/** The master resume dialog and search-profile choices. */

import { $, el, fmt, shortStamp, slowProgress, toast } from './dom.js';
import { api, postJson } from './api.js';
import { note } from './detail.js';
import { openDialog } from './dialogs.js';
import { download } from './profile.js';

/* ───────────────────────── master resume ───────────────────────── */

export const MASTER_MAX_BYTES = 8 * 1024 * 1024;
export const kb = (bytes) => `${Math.max(1, Math.round(Number(bytes ?? 0) / 1024))} KB`;

/**
 * A resume line that is almost certainly a section heading, so the plain-text
 * preview keeps the document's shape instead of reading as one grey wall.
 */
export function looksLikeHeading(line) {
  const text = String(line).trim();
  if (text.length > 48 || /[.;]$/.test(text)) return false;
  return text === text.toUpperCase() ? /[A-Z]/.test(text) : /^[A-Z][\w/&' -]*$/.test(text);
}

export async function openMasterResume() {
  const body = $('masterBody');
  const stop = slowProgress(body, 'Reading your master resume and comparing it with your search…');
  $('masterMsg').textContent = '';
  openDialog($('dlgMaster'));
  try { await renderMasterResume(); } finally { stop(); }
}

/**
 * "Does this resume match what we are searching for?"
 *
 * Replacing the master resume changed nothing upstream: discovery reads
 * `candidate.targetTitles`, and the resume was not opened until tailoring time.
 * So a new resume for a different role left the pipeline searching the old one
 * indefinitely, silently. This panel makes that visible and offers the fix.
 *
 * It PROPOSES. Adopting a title is a click, never automatic — a resume says
 * what you have done, while target titles say what you want next, and those two
 * differ exactly when someone is changing direction.
 */
export async function renderResumeSuggestions(body) {
  let data;
  try { data = await api('/api/master-resume/suggestions'); }
  catch { return; } // never let this panel break the drawer it sits in
  if (!data?.available) return;

  const { diff, evidence } = data;
  const box = el('div', { class: diff.drifted ? 'attention' : 'evidence-note' });
  if (diff.drifted) box.append(el('span', { class: 'mark', text: '!' }));

  const inner = el('div');
  inner.append(el('div', {},
    el('b', {
      // A label, not a restatement — the summary already names the role.
      text: diff.drifted
        ? 'This resume and your job search describe different jobs. '
        : 'Resume vs. your job search. ',
    }),
    diff.summary));

  // What the resume says you are NOW, separately from what you used to be.
  // Collapsing the two made an aligned resume look mismatched, because a career
  // history is mostly roles you have moved past.
  if (evidence.currentTitles?.length) {
    inner.append(el('div', { class: 'muted small' },
      `Current role in this resume: ${evidence.currentTitles.join(' · ')}`));
  }
  if (evidence.earlierTitles?.length) {
    inner.append(el('div', { class: 'muted small' },
      `Earlier roles: ${evidence.earlierTitles.join(' · ')}`));
  }

  // Titles the resume shows that nothing is being searched for. These are the
  // actionable half: adopting one changes what every source looks for.
  if (diff.newTitles.length) {
    const currentSet = new Set((diff.currentTitles ?? []).map((t) => t.toLowerCase()));
    const currentUnmatched = diff.newTitles.filter((t) => currentSet.has(t.toLowerCase()));
    const earlierUnmatched = diff.newTitles.filter((t) => !currentSet.has(t.toLowerCase()));

    const chips = (titles) => {
      const pick = el('div', { class: 'row-gap' });
      for (const title of titles) {
        pick.append(el('label', { class: 'chipbox' },
          el('input', { type: 'checkbox', 'data-adopt-title': title }),
          el('span', { text: title })));
      }
      return pick;
    };

    if (currentUnmatched.length) {
      inner.append(el('div', { class: 'muted small', text: 'Your CURRENT role is not being searched for:' }));
      inner.append(chips(currentUnmatched));
    }
    if (earlierUnmatched.length) {
      inner.append(el('div', { class: 'muted small' },
        'Earlier roles, not searched for — tick one only if you would still take that job:'));
      inner.append(chips(earlierUnmatched));
    }

    const actions = el('div', { class: 'row-gap' });
    actions.append(el('button', {
      class: 'small primary', 'data-action': 'adopt-resume-titles',
      text: 'Add selected to my job search',
      title: 'Writes the selected titles into candidate.targetTitles. Nothing else changes.',
    }));
    actions.append(el('button', {
      class: 'small ghost', 'data-action': 'preview-resume-title',
      text: 'Preview one first',
      title: 'Search the job boards for the first selected title without changing your profile.',
    }));
    inner.append(actions);
  }

  if (diff.newSkills.length) {
    inner.append(el('div', { class: 'muted small' },
      `${fmt(diff.newSkills.length)} skill term(s) in this resume are not in your profile stack `
      + `(${diff.newSkills.slice(0, 8).join(', ')}${diff.newSkills.length > 8 ? '…' : ''}). `
      + 'These affect how relevant a posting is judged to be.'));
    inner.append(el('button', {
      class: 'small ghost', 'data-action': 'adopt-resume-skills',
      text: 'Add these skills to my profile',
    }));
  }

  box.append(inner);
  body.append(box);
}

/** Titles ticked in the suggestions panel. */
export function selectedAdoptTitles() {
  return [...document.querySelectorAll('[data-adopt-title]')]
    .filter((i) => i.checked)
    .map((i) => i.dataset.adoptTitle);
}

export async function adoptResumeSelection({ titles = [], skills = [] } = {}) {
  if (!titles.length && !skills.length) {
    toast('Tick at least one first.', '');
    return;
  }
  try {
    const r = await postJson('/api/profile/adopt', { titles, skills });
    const bits = [];
    if (r.addedTitles.length) bits.push(`${r.addedTitles.length} title(s)`);
    if (r.addedSkills.length) bits.push(`${r.addedSkills.length} skill(s)`);
    toast(
      bits.length
        ? `Added ${bits.join(' and ')} to your profile — the next run will search for them.`
        : 'Those were already in your profile.',
      'good',
    );
    await renderMasterResume();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/**
 * "Whose search is this, and does this resume belong to them?"
 *
 * The single most expensive silent failure this tool had was a run that kept
 * using one person's target titles after another person's resume was uploaded,
 * with nothing anywhere saying so. This panel is the answer: it names the
 * active search profile, says plainly what that profile makes the agent look
 * for, and — when the resume does not match — offers the three things a person
 * may actually want to do about it.
 *
 * It never decides. A resume says what someone has DONE; a search profile says
 * what they WANT, and those diverge exactly when somebody is changing
 * direction. So the choice is always theirs.
 */
export async function renderSearchProfiles(body) {
  let listing;
  try { listing = await api('/api/search-profiles'); }
  catch { return null; } // never let this panel break the drawer it sits in

  const wrap = el('div', { class: 'evidence-note' });

  if (!listing.profiles?.length) {
    wrap.append(el('div', {}, el('b', { text: 'No saved search profile. ' }),
      'Discovery is running on config/candidate.json exactly as written, so uploading a '
      + 'different resume will not change what is searched for.'));
    wrap.append(el('div', { class: 'row-gap' },
      el('button', {
        class: 'small primary', 'data-action': 'migrate-search-profile',
        text: 'Import my current setup as a profile',
        title: 'Reads config/candidate.json and saves it as your first search profile. Nothing about your search changes.',
      })));
    body.append(wrap);
    return null;
  }

  // WHAT THE ACTIVE PROFILE MAKES THE AGENT DO. Stated as consequences, because
  // a list of stored fields does not tell anyone what will actually happen.
  const active = listing.active;
  if (active) {
    const e = active.effect;
    wrap.append(el('div', {}, el('b', { text: 'Searching as: ' }), active.profile.label));
    wrap.append(el('div', { class: 'muted small' },
      `Asks the boards for ${e.searchPhrases.map((q) => `"${q}"`).join(', ') || '(nothing)'} · `
      + `recognizes ${e.targetTitles.length} title(s) · `
      + `role famil${e.families.length === 1 ? 'y' : 'ies'}: ${e.families.map((f) => f.label).join(', ') || 'none inferred'}`));
    if (e.expandedRoles.length) {
      wrap.append(el('div', { class: 'muted small' },
        `You stated ${e.statedRoles.length} role(s); role-family expansion also looks for `
        + `${e.expandedRoles.slice(0, 6).join(' · ')}${e.expandedRoles.length > 6 ? ` +${e.expandedRoles.length - 6} more` : ''}.`));
    }
  }

  // The switcher. Every other profile is one click away.
  const others = listing.profiles.filter((p) => !p.active);
  if (others.length) {
    const row = el('div', { class: 'row-gap' });
    for (const p of others) {
      row.append(el('button', {
        class: 'small ghost', 'data-action': 'activate-search-profile', 'data-profile-id': p.id,
        text: `Switch to ${p.label}`,
        title: `Regenerates candidate.json, scoring.json and exclusions.json from "${p.id}". `
          + 'Every previous version is kept as .bak.',
      }));
    }
    wrap.append(el('div', { class: 'muted small', text: `${others.length} other saved profile(s):` }));
    wrap.append(row);
  }
  body.append(wrap);

  // ── does the uploaded resume belong to this profile? ────────────────────
  let proposal;
  try { proposal = await api('/api/search-profiles/from-resume/preview'); }
  catch (err) {
    // SAY SO. This swallowed every failure and returned null, so a broken
    // comparison was indistinguishable from a resume that matches perfectly —
    // the panel simply showed nothing, and the user had no way to know the
    // check had not run. It still must not break the drawer it sits in, so the
    // error is rendered in place rather than thrown.
    body.append(el('div', { class: 'evidence-note st-blocked small' },
      el('b', { text: 'Could not compare your resume to this profile. ' }), err.message));
    return null;
  }
  if (!proposal?.available) return null;

  const { comparison, preview, choices } = proposal;
  if (comparison.relation === 'same') {
    body.append(el('div', { class: 'evidence-note muted small', text: comparison.summary }));
    return comparison.relation;
  }
  // Already answered for this exact resume — "Keep my current goals" is a
  // decision, and re-asking it every render is not respecting it.
  if (proposal.acknowledged) {
    body.append(el('div', { class: 'evidence-note muted small' },
      'You chose to keep your current search goals for this resume. ',
      el('button', {
        class: 'small ghost', 'data-action': 'profile-from-resume-reconsider',
        text: 'Reconsider',
      })));
    return comparison.relation;
  }

  const box = el('div', { class: comparison.relation === 'different' ? 'attention' : 'evidence-note' });
  if (comparison.relation === 'different') box.append(el('span', { class: 'mark', text: '!' }));
  const inner = el('div');
  inner.append(el('div', {}, el('b', {
    text: comparison.relation === 'different'
      ? 'This looks like a different candidate. ' : 'This resume has moved on. ',
  }), comparison.summary));
  for (const reason of comparison.reasons.slice(0, 3)) {
    inner.append(el('div', { class: 'muted small', text: `· ${reason}` }));
  }
  inner.append(el('div', { class: 'muted small' },
    `A profile built from this resume would ask the boards for `
    + `${preview.searchPhrases.map((q) => `"${q}"`).join(', ') || '(nothing)'} and recognize `
    + `${preview.targetTitles.length} title(s) across `
    + `${preview.families.map((f) => f.label).join(', ') || 'no recognized family'}.`));

  // THE THREE CHOICES, named by the server so the CLI and the board agree.
  const actions = el('div', { class: 'row-gap' });
  const buttonFor = {
    create: { class: 'small primary', action: 'profile-from-resume-create' },
    keep: { class: 'small ghost', action: 'profile-from-resume-keep' },
    merge: { class: 'small ghost', action: 'profile-from-resume-merge' },
  };
  for (const choice of choices) {
    const spec = buttonFor[choice.id];
    if (!spec) continue;
    actions.append(el('button', {
      class: spec.class, 'data-action': spec.action, text: choice.label, title: choice.detail,
    }));
  }
  inner.append(actions);
  // SAY WHAT THE BUTTON ACTUALLY DOES. This line used to read "it only takes
  // over the search when you activate it", while the button passed
  // `activate: true` — so the copy told the user the opposite of what would
  // happen the moment they pressed it.
  inner.append(el('div', { class: 'muted small' },
    'Nothing has changed yet. Creating a profile from this resume also makes it the active search — '
    + 'your current profile is saved and you can switch back at any time.'));
  box.append(inner);
  body.append(box);
  return comparison.relation;
}

/**
 * Let the user choose exactly what to merge from the resume.
 *
 * "Merge" previously posted every proposed role, skill and industry — the whole
 * proposal — while presenting itself as the middle option between adopting the
 * resume wholesale and keeping the current search. Adding 40 titles to a search
 * because a resume mentions them is the thing a merge is supposed to avoid, so
 * the choice is now actually offered.
 *
 * Everything starts ticked, because the proposal is still the recommendation;
 * the point is that the user can see it and untick.
 */
export async function openMergePicker() {
  const host = $('masterBody');
  let data;
  try { data = await api('/api/search-profiles/from-resume/preview'); }
  catch (err) { toast(err.message, 'bad'); return; }
  if (!data?.available) { toast('No resume to merge from.', 'bad'); return; }

  const intent = data.proposal.searchIntent;
  const box = el('div', { class: 'evidence-note', id: 'mergePicker' });
  box.append(el('div', {}, el('b', { text: 'Choose what to add to your current search. ' }),
    'Nothing is removed — merging only adds.'));

  const group = (title, kind, items) => {
    if (!items.length) return;
    box.append(el('div', { class: 'muted small', text: title }));
    const list = el('div', { class: 'row-gap' });
    for (const [i, value] of items.entries()) {
      const id = `merge-${kind}-${i}`;
      // `chipbox` is the existing tickable-suggestion style in this drawer.
      const label = el('label', { class: 'chipbox', for: id });
      label.append(el('input', {
        type: 'checkbox', id, checked: true, 'data-merge-kind': kind, value,
      }));
      label.append(el('span', { text: value }));
      list.append(label);
    }
    box.append(list);
  };
  group('Roles to search for', 'roles', intent.targetRoles ?? []);
  group('Skills to match on', 'skills', intent.skillsToKeep ?? []);
  group('Industries', 'industries', intent.industries ?? []);

  box.append(el('div', { class: 'row-gap' },
    el('button', { class: 'small primary', 'data-action': 'confirm-merge-selection', text: 'Merge what I ticked' }),
    el('button', { class: 'small ghost', 'data-action': 'cancel-merge-selection', text: 'Cancel' })));
  host.append(box);
  box.scrollIntoView?.({ block: 'nearest' });
}

/** Post only the ticked roles/skills/industries. */
export async function submitMergeSelection() {
  const picker = $('mergePicker');
  if (!picker) return;
  const ticked = (kind) => [...picker.querySelectorAll(`[data-merge-kind="${kind}"]`)]
    .filter((box) => box.checked).map((box) => box.value);
  const roles = ticked('roles');
  const skills = ticked('skills');
  const industries = ticked('industries');
  if (!roles.length && !skills.length && !industries.length) {
    toast('Tick at least one thing to merge.', 'bad');
    return;
  }
  await chooseResumeProfile('merge', { roles, skills, industries });
}

/** Re-open the resume question the user had previously settled. */
export async function reconsiderResumeChoice() {
  try {
    await postJson('/api/search-profiles/acknowledge-resume', { clear: true });
    await renderMasterResume();
  } catch (err) { toast(err.message, 'bad'); }
}

/** POST one of the three resume choices, then re-render the drawer. */
export async function chooseResumeProfile(choice, extra = {}) {
  try {
    const result = await postJson('/api/search-profiles/from-resume', { choice, ...extra });
    if (!result.changed) { toast(result.message ?? 'Nothing changed.', ''); return; }
    toast(result.activated
      ? `Now searching as "${result.activated.label}".`
      : `Saved profile "${result.id}". Activate it to start searching with it.`, 'ok');
    await renderMasterResume();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export async function renderMasterResume() {
  const body = $('masterBody');
  let master;
  try { master = await api('/api/master-resume'); }
  catch (err) {
    body.textContent = '';
    body.append(el('div', { class: 'st-blocked', text: err.message }));
    return;
  }
  body.textContent = '';

  if (!master.available) {
    body.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: master.reason })));
    return;
  }

  // ── the file itself ────────────────────────────────────────────────────
  const card = el('div', { class: 'mr-file' });
  const meta = el('div', { class: 'mr-meta' });
  meta.append(el('div', { class: 'mr-name', text: 'MASTER_RESUME.docx' }));
  meta.append(el('div', {
    class: 'mr-facts',
    text: master.exists
      ? [kb(master.bytes), master.wordCount != null ? `${fmt(master.wordCount)} words` : null,
        `updated ${shortStamp(master.modifiedAt)}`].filter(Boolean).join(' · ')
      : 'Not found yet',
  }));
  meta.append(el('div', { class: 'mr-path', text: master.path }));
  card.append(meta);

  const buttons = el('div', { class: 'row-gap' });
  if (master.exists) {
    buttons.append(el('a', {
      class: 'btn small', href: '/api/master-resume/file', text: '⬇ Download to edit',
      title: 'Download, edit in Word or Google Docs, then upload it back here.',
    }));
  }
  buttons.append(el('button', {
    class: 'small primary', 'data-action': 'pick-master-file',
    text: master.exists ? '⬆ Upload new version' : '⬆ Upload your resume',
  }));
  card.append(buttons);
  body.append(card);

  if (!master.exists) {
    body.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', {}, el('b', { text: 'No master resume yet.' }),
        ' Tailoring cannot run without it — every packet would fall back to nothing. '
        + 'Upload a .docx here, or place the file at the path above.')));
  }
  if (master.textError) {
    body.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', {}, el('b', { text: 'This file is present but unreadable: ' }), master.textError,
        el('br'), 'Tailoring would copy it through verbatim. Re-save it from Word as .docx and upload it again.')));
  }

  // Whose search is running, and does this resume belong to them? This comes
  // FIRST: it is the question that decides whether anything below it matters.
  const relation = await renderSearchProfiles(body);

  // The role-level diff below compares TITLES; the panel above compares WHOSE
  // RESUME THIS IS. When the two disagree the screen contradicted itself —
  // "This looks like a different candidate" sat directly above "your current
  // role is already being searched for". The identity question is the bigger
  // one and it already offers the right actions, so the title diff is left out
  // until the resume and the profile are agreed to be the same person.
  if (master.exists && relation !== 'different') await renderResumeSuggestions(body);

  body.append(el('div', { class: 'evidence-note' },
    'Tailoring opens this document read-only and writes a separate resume per job — '
    + 'the master is never edited in place. Uploading a new version keeps the previous one, '
    + 'so you can roll back in one click.'));

  if (master.stalePackets > 0) {
    body.append(el('div', { class: 'muted' },
      `${fmt(master.stalePackets)} tailored resume(s) were generated before this version. `
      + 'Use “↻ Re-tailor” on a job to rebuild its resume from the current master.'));
  }

  // ── what is actually in it ─────────────────────────────────────────────
  if (master.paragraphs.length) {
    body.append(el('h3', { text: 'Contents' }));
    const preview = el('div', { class: 'mr-preview' });
    for (const line of master.paragraphs) {
      preview.append(el('p', { class: looksLikeHeading(line) ? 'h' : '', text: line }));
    }
    body.append(preview);
    if (master.truncated) {
      body.append(el('div', { class: 'faint fineprint', text: 'Preview truncated — download the file to read it all.' }));
    }
  }

  // ── rollback ───────────────────────────────────────────────────────────
  body.append(el('h3', { text: `Previous versions (${master.backups.length})` }));
  if (!master.backups.length) {
    body.append(el('div', { class: 'muted', text: 'None yet — a copy is kept automatically whenever you upload a new version.' }));
    return;
  }
  const list = el('ul', { class: 'mr-versions' });
  for (const backup of master.backups) {
    list.append(el('li', {},
      el('span', { class: 'when', text: `${shortStamp(backup.modifiedAt)} · ${kb(backup.bytes)}` }),
      el('button', {
        class: 'small', 'data-action': 'restore-master', 'data-name': backup.name,
        title: 'Make this the master resume again (the current one is kept too).',
        text: '↺ Restore',
      })));
  }
  body.append(list);
}

/** Base64-encode in chunks: one apply() over a multi-MB array overflows the stack. */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export async function uploadMasterResume(file) {
  const msg = $('masterMsg');
  const show = (text, tone = 'muted') => { msg.className = tone; msg.textContent = text; };
  if (!file) return;
  if (!/\.docx$/i.test(file.name)) {
    show('Only .docx files can be used — export from Google Docs or “Save As” in Word.', 'st-blocked');
    return;
  }
  if (file.size > MASTER_MAX_BYTES) {
    show(`That file is ${kb(file.size)} — the limit is 8 MB.`, 'st-blocked');
    return;
  }
  show(`Checking and installing ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await postJson('/api/master-resume', {
      filename: file.name,
      contentBase64: bytesToBase64(bytes),
    });
    show('');
    toast(result.backup
      ? `Master resume replaced — previous version kept as ${result.backup}`
      : 'Master resume installed', 'good');
    await renderMasterResume();
  } catch (err) {
    // The server's rejection reasons are the actionable part (wrong file type,
    // no readable text), so they are shown in place rather than as a toast.
    show(err.message, 'st-blocked');
  }
}

export async function restoreMasterVersion(name) {
  const msg = $('masterMsg');
  msg.className = 'muted';
  msg.textContent = `Restoring ${name}…`;
  try {
    await postJson('/api/master-resume/restore', { name });
    msg.textContent = '';
    toast('Master resume restored — the version it replaced was kept too.', 'good');
    await renderMasterResume();
  } catch (err) {
    msg.className = 'st-blocked';
    msg.textContent = err.message;
  }
}
