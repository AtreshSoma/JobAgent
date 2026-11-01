/** The master resume dialog and search-profile choices. */

import { $, el, fmt, shortStamp, slowProgress, toast } from './dom.js';
import { api, postJson } from './api.js';
import { openDialog } from './dialogs.js';
import { classifyResumeLine, displayName, initials, looksLikeHeading } from './format.js';
import { activeProfileId, announceSwitch, describeProfiles, loadProfiles, profileSubline } from './profiles.js';
import { scheduleRefresh } from './mutations.js';

export { classifyResumeLine, looksLikeHeading };

/* ───────────────────────── master resume ───────────────────────── */

export const MASTER_MAX_BYTES = 8 * 1024 * 1024;
export const kb = (bytes) => `${Math.max(1, Math.round(Number(bytes ?? 0) / 1024))} KB`;

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
  // Neutral unless the resume and the search genuinely disagree: a panel that
  // is blue when all is well trains the eye to skip the one that is amber.
  const box = el('div', { class: diff.drifted ? 'attention' : 'mr-block' });
  if (diff.drifted) box.append(el('span', { class: 'mark', text: '!' }));

  const inner = el('div', { class: 'mr-block-body' });
  inner.append(el('p', { class: 'mr-lead' },
    el('b', {
      // A label, not a restatement — the summary already names the role.
      text: diff.drifted
        ? 'This resume and your job search describe different jobs. '
        : 'Resume and job search. ',
    }),
    diff.summary));

  // What the resume says you are NOW. Earlier roles are listed only where
  // there is something to do about them (the tick-chips below): naming them
  // twice — once as a sentence, once as chips — was the same list read twice.
  if (evidence.currentTitles?.length) {
    inner.append(el('dl', { class: 'mr-facts-list' },
      el('dt', { text: 'Current role' }), el('dd', { text: evidence.currentTitles.join(' · ') })));
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

    const group = el('div', { class: 'mr-choice', role: 'group', 'aria-label': 'Roles from this resume' });
    if (currentUnmatched.length) {
      group.append(el('div', { class: 'mr-choice-label', text: 'Your current role is not being searched for:' }));
      group.append(chips(currentUnmatched));
    }
    if (earlierUnmatched.length) {
      group.append(el('div', { class: 'mr-choice-label' },
        'Earlier roles you are not searching for — tick any you would still take:'));
      group.append(chips(earlierUnmatched));
    }
    group.append(el('div', { class: 'row-gap' },
      el('button', {
        class: 'small primary', 'data-action': 'adopt-resume-titles',
        text: 'Add selected to my job search',
        title: 'Writes the selected titles into candidate.targetTitles. Nothing else changes.',
      }),
      el('button', {
        class: 'small ghost', 'data-action': 'preview-resume-title',
        text: 'Preview one first',
        title: 'Search the job boards for the first selected title without changing your profile.',
      })));
    inner.append(group);
  }

  if (diff.newSkills.length) {
    const shown = diff.newSkills.slice(0, 8);
    const group = el('div', { class: 'mr-choice', role: 'group', 'aria-label': 'Skills from this resume' });
    group.append(el('div', { class: 'mr-choice-label' },
      `${fmt(diff.newSkills.length)} skill${diff.newSkills.length === 1 ? '' : 's'} in this resume `
      + 'are not in your profile yet. Skills decide how well a posting is judged to fit you.'));
    const list = el('div', { class: 'kwlist' });
    for (const skill of shown) list.append(el('span', { class: 'chip', text: skill }));
    if (diff.newSkills.length > shown.length) {
      list.append(el('span', { class: 'chip unscored', text: `+${fmt(diff.newSkills.length - shown.length)} more` }));
    }
    group.append(list);
    group.append(el('div', { class: 'row-gap' }, el('button', {
      class: 'small', 'data-action': 'adopt-resume-skills',
      text: `Add ${diff.newSkills.length === 1 ? 'this skill' : `all ${fmt(diff.newSkills.length)} skills`} to my profile`,
    })));
    inner.append(group);
  }

  // When nothing is wrong, these are optional suggestions: one line, opened on
  // request. When the resume and the search disagree, the amber box stays open.
  if (!diff.drifted) {
    const counts = [diff.newTitles.length ? `${diff.newTitles.length} role${diff.newTitles.length === 1 ? '' : 's'}` : '',
      diff.newSkills.length ? `${diff.newSkills.length} skill${diff.newSkills.length === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (!counts.length) return;
    const fold = el('details', { class: 'mr-block mr-suggest', 'data-key': 'mr-suggest' },
      el('summary', {}, el('b', { text: 'Suggestions from your resume' }), el('span', { class: 'faint', text: ` · ${counts.join(' and ')} you could add` })));
    fold.append(inner);
    body.append(fold);
    return;
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
 * Shown as a list of PEOPLE — one row each, with a Switch button — and, only
 * when the uploaded resume belongs to someone else, a two-line notice with
 * one clear next step. Everything diagnostic (the reasons behind the verdict,
 * what a profile would search for, merging) sits behind "Details": it is
 * evidence for the rare doubt, not reading for every visit. The previous
 * version printed all of it, every time, as ~25 lines of small text.
 *
 * It never decides. A resume says what someone has DONE; a profile says what
 * they WANT, and those diverge exactly when somebody is changing direction.
 */
export async function renderSearchProfiles(body) {
  let listing;
  try { listing = await loadProfiles(); } catch { listing = null; }
  if (!listing) return null; // never let this panel break the drawer it sits in

  if (!listing.profiles?.length) {
    body.append(el('div', { class: 'mr-block' },
      el('p', { class: 'mr-lead' }, el('b', { text: 'No saved search profile yet.' }),
        ' Save your current settings as one, so you can switch between people or search directions later.'),
      el('div', { class: 'row-gap' }, el('button', {
        class: 'small primary', 'data-action': 'migrate-search-profile',
        text: 'Save my current setup as a profile',
        title: 'Saves your current search settings as your first profile. Nothing about your search changes.',
      }))));
    return null;
  }

  // ── does the uploaded resume belong to the active profile? ──────────────
  let proposal = null;
  try { proposal = await api('/api/search-profiles/from-resume/preview'); }
  catch (err) {
    // Said, not swallowed: a comparison that did not run must not look like a
    // resume that matches.
    body.append(el('p', { class: 'mr-note st-blocked' }, `Could not compare this resume with your profile: ${err.message}`));
  }
  const relation = proposal?.available ? proposal.comparison.relation : null;
  const rows = describeProfiles(listing);
  if (proposal?.available) {
    const notice = resumeNotice(proposal, rows);
    if (notice) body.append(notice);
  }

  // ── the people ──────────────────────────────────────────────────────────
  body.append(profileList(rows));
  const active = listing.active;
  if (active?.effect) body.append(searchDetails(active.effect));
  return relation;
}

/** One row per saved profile: avatar, name, one line, Active or Switch, Delete. */
function profileList(rows) {
  const list = el('ul', { class: 'pf-list', 'aria-label': 'Saved search profiles' });
  for (const p of rows) {
    const row = el('li', { class: `pf-row${p.active ? ' is-active' : ''}${p.ready ? '' : ' is-empty'}`, ...(p.active ? { 'aria-current': 'true' } : {}) },
      el('span', { class: 'pf-avatar', 'aria-hidden': 'true', text: initials(p.display) || '?' }),
      el('span', { class: 'pf-who' },
        el('span', { class: 'pf-name' }, p.display, p.active ? el('span', { class: 'pf-badge', text: 'Active' }) : ''),
        el('span', { class: 'pf-sub', text: profileSubline(p) })));
    const actions = el('span', { class: 'pf-actions' });
    if (!p.active) {
      actions.append(el('button', {
        type: 'button', class: 'small', 'data-action': 'activate-search-profile', 'data-profile-id': p.id,
        disabled: !p.ready, 'aria-label': `Switch to ${p.display}`,
        title: p.ready ? `Search as ${p.display}` : 'This profile has no job titles yet, so it cannot search',
        text: 'Switch',
      }));
      actions.append(el('button', {
        type: 'button', class: 'small ghost iconbtn pf-delete', 'data-action': 'delete-search-profile', 'data-profile-id': p.id,
        'aria-label': `Delete ${p.display}${p.duplicate ? ' (duplicate)' : ''}`, title: 'Delete this saved profile',
      }, trashIcon()));
    }
    row.append(actions);
    list.append(row);
  }
  return list;
}

function trashIcon() {
  const svg = el('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(el('path', { d: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5' }));
  return svg;
}

/** What the active profile searches for, for the curious — collapsed. */
function searchDetails(effect) {
  const box = el('details', { class: 'pf-details', 'data-key': 'pf-details' });
  box.append(el('summary', { text: 'What the active profile searches for' }));
  const phrases = el('div', { class: 'kwlist' });
  for (const q of effect.searchPhrases ?? []) phrases.append(el('span', { class: 'chip', text: q }));
  box.append(el('p', { class: 'mr-note' },
    `Searches job boards for these phrases and recognises ${fmt(effect.targetTitles?.length ?? 0)} job titles`
    + `${effect.families?.length ? ` in ${effect.families.map((f) => f.label).join(', ')}` : ''}.`));
  box.append(phrases);
  return box;
}

/**
 * The resume does not match the active profile: say whose it is, and offer the
 * ONE action that fits — switch to their saved profile, or create one — with
 * "keep searching as me" beside it. Reasons and merging go behind Details.
 */
function resumeNotice(proposal, rows) {
  const { comparison, preview, choices } = proposal;
  if (comparison.relation === 'same') return null;
  if (proposal.acknowledged) {
    return el('p', { class: 'mr-note' }, 'You chose to keep your current search for this resume. ',
      el('button', { class: 'small ghost', 'data-action': 'profile-from-resume-reconsider', text: 'Reconsider' }));
  }
  const resumeName = displayName(proposal.proposal?.identity?.fullName) || 'someone else';
  const activeName = rows.find((p) => p.active)?.display || 'your active profile';
  const different = comparison.relation === 'different';
  const canSearch = (preview?.targetTitles?.length ?? 0) > 0;
  const firstName = resumeName.split(' ')[0];
  // Their profile may already be saved (and able to search): switch, do not copy.
  const saved = different
    ? rows.find((p) => !p.active && p.ready && p.display.toLowerCase() === resumeName.toLowerCase())
    : null;

  const box = el('div', { class: 'attention mr-notice', role: 'group', 'aria-labelledby': 'mrNoticeHead' });
  box.append(el('span', { class: 'mark', 'aria-hidden': 'true', text: '!' }));
  const inner = el('div', { class: 'mr-block-body' });
  inner.append(el('p', { class: 'mr-lead', id: 'mrNoticeHead' },
    el('b', { text: different ? `This resume belongs to ${resumeName}.` : 'This resume has moved on from your search.' }),
    ` You are searching as ${activeName}.`));

  const actions = el('div', { class: 'row-gap' });
  const keep = el('button', {
    class: 'small ghost', 'data-action': 'profile-from-resume-keep',
    text: different ? `Keep searching as ${activeName.split(' ')[0]}` : 'Keep my current search',
  });
  if (saved) {
    actions.append(el('button', {
      class: 'small primary', 'data-action': 'activate-search-profile', 'data-profile-id': saved.id,
      text: `Switch to ${firstName}'s profile`,
    }), keep);
  } else if (canSearch) {
    const create = choices?.find((c) => c.id === 'create');
    actions.append(el('button', {
      class: 'small primary', 'data-action': 'profile-from-resume-create',
      title: create?.detail ?? '',
      text: different ? `Create ${firstName}'s profile and switch` : 'Create a new profile from it',
    }), keep);
  } else {
    inner.append(el('p', { class: 'mr-note' },
      'No job titles could be read from this resume, so a profile made from it would search for nothing. '
      + 'Put each job title on its own line (or before its dates), then upload it again.'));
    actions.append(keep);
  }
  inner.append(actions);

  // The evidence, for when the verdict is in doubt — collapsed.
  const more = el('details', { class: 'mr-more', 'data-key': 'mr-notice-details' });
  more.append(el('summary', { text: 'Details' }));
  const why = el('ul', { class: 'mr-reasons' });
  for (const reason of comparison.reasons.slice(0, 3)) why.append(el('li', { text: reason }));
  more.append(why);
  if (canSearch) {
    more.append(el('p', { class: 'mr-note' },
      `A profile from this resume would search for ${preview.searchPhrases.map((q) => `"${q}"`).join(', ')} `
      + `and recognise ${fmt(preview.targetTitles.length)} job titles. Switching never deletes your current profile.`));
  }
  if (choices?.some((c) => c.id === 'merge')) {
    more.append(el('div', { class: 'row-gap' }, el('button', {
      class: 'small ghost', 'data-action': 'profile-from-resume-merge',
      text: 'Merge into my current profile instead',
      title: 'Only if this resume is yours: adds the roles and skills you pick to your current search.',
    })));
  }
  inner.append(more);
  box.append(inner);
  return box;
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
  const previous = activeProfileId();
  try {
    const result = await postJson('/api/search-profiles/from-resume', { choice, ...extra });
    if (!result.changed) { toast(result.message ?? 'Nothing changed.', ''); return; }
    if (result.activated) announceSwitch(result.activated.label, previous !== result.id ? previous : null);
    else toast(`Saved profile "${result.id}". Switch to it to start searching with it.`, 'good');
    // The header's initials, the switcher and the board all depend on who is active.
    if (result.activated) scheduleRefresh(0);
    await loadProfiles();
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
  // A flat header row, not a gradient card: the file is the subject of the
  // dialog, and its name, facts and two actions say so without a frame.
  const head = el('div', { class: 'mr-head' });
  const meta = el('div', { class: 'mr-meta' });
  meta.append(el('div', { class: 'mr-name', text: 'MASTER_RESUME.docx' }));
  meta.append(el('div', {
    class: 'mr-facts',
    text: master.exists
      ? [kb(master.bytes), master.wordCount != null ? `${fmt(master.wordCount)} words` : null,
        `updated ${shortStamp(master.modifiedAt)}`].filter(Boolean).join(' · ')
      : 'Not found yet',
  }));
  head.append(meta);

  const buttons = el('div', { class: 'row-gap' });
  if (master.exists) {
    buttons.append(el('a', {
      class: 'btn small', href: '/api/master-resume/file', text: 'Download to edit',
      title: 'Download, edit in Word or Google Docs, then upload it back here.',
    }));
  }
  buttons.append(el('button', {
    class: 'small primary', 'data-action': 'pick-master-file',
    text: master.exists ? 'Upload new version' : 'Upload your resume',
  }));
  head.append(buttons);
  body.append(head);

  // The full path is for the rare person placing the file by hand. It was the
  // second-most prominent line in the dialog; it is now one click away — and
  // shown outright when the file is missing, because that copy points at it.
  const where = el('code', { class: 'mr-path', text: master.path });
  if (master.exists) {
    body.append(el('details', { class: 'mr-loc' }, el('summary', { text: 'File location' }), where));
  } else {
    body.append(where);
  }
  body.append(el('p', { class: 'mr-note' },
    'Tailoring reads this file and writes a separate resume for each job — the master itself is never '
    + 'edited. Uploading a new version keeps the old one, so you can roll back in one click.'));

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
  if (master.stalePackets > 0) {
    body.append(el('p', { class: 'mr-note' },
      `${fmt(master.stalePackets)} tailored resume(s) were generated before this version. `
      + 'Use “↻ Re-tailor” on a job to rebuild its resume from the current master.'));
  }

  // ── your job search ────────────────────────────────────────────────────
  // Whose search is running, and does this resume belong to them? This comes
  // FIRST among the sections: it decides whether anything below it matters.
  const search = el('section', { class: 'mr-section', 'aria-labelledby': 'mrSearchHead' },
    el('h3', { id: 'mrSearchHead', tabindex: '-1', text: 'Search profiles' }));
  body.append(search);
  const relation = await renderSearchProfiles(search);

  // The role-level diff below compares TITLES; the panel above compares WHOSE
  // RESUME THIS IS. When the two disagree the screen contradicted itself —
  // "This looks like a different candidate" sat directly above "your current
  // role is already being searched for". The identity question is the bigger
  // one and it already offers the right actions, so the title diff is left out
  // until the resume and the profile are agreed to be the same person.
  if (master.exists && relation !== 'different') await renderResumeSuggestions(search);

  // ── what is actually in it ─────────────────────────────────────────────
  if (master.paragraphs.length) {
    const preview = el('details', { class: 'mr-section mr-contents', open: true, 'data-key': 'mr-contents' });
    preview.append(el('summary', {},
      el('span', { class: 'mr-sum-title', text: 'Preview' }),
      el('span', { class: 'mr-sum-meta', text: 'Plain text, as tailoring reads it' })));
    preview.append(resumePreview(master.paragraphs));
    if (master.truncated) {
      preview.append(el('div', { class: 'faint fineprint', text: 'Preview truncated — download the file to read it all.' }));
    }
    body.append(preview);
  }

  // ── rollback ───────────────────────────────────────────────────────────
  const versions = el('section', { class: 'mr-section', 'aria-labelledby': 'mrVersionsHead' },
    el('h3', { id: 'mrVersionsHead', text: `Previous versions (${master.backups.length})` }));
  body.append(versions);
  if (!master.backups.length) {
    versions.append(el('p', { class: 'mr-note', text: 'None yet — a copy is kept automatically whenever you upload a new version.' }));
    return;
  }
  const list = el('ul', { class: 'mr-versions' });
  for (const backup of master.backups) {
    list.append(el('li', {},
      el('span', { class: 'when', text: `${shortStamp(backup.modifiedAt)} · ${kb(backup.bytes)}` }),
      el('button', {
        class: 'small', 'data-action': 'restore-master', 'data-name': backup.name,
        title: 'Make this the master resume again (the current one is kept too).',
        text: 'Restore',
      })));
  }
  versions.append(list);
}

/** The structured, read-only preview of the master resume. */
export function resumePreview(paragraphs) {
  const doc = el('div', { class: 'mr-preview' });
  // Lines above the first heading are the name and contact block.
  let beforeFirstHeading = paragraphs.some((p) => looksLikeHeading(p));
  let list = null;
  paragraphs.forEach((line, index) => {
    const kind = classifyResumeLine(line, { beforeFirstHeading, index });
    if (kind === 'heading') beforeFirstHeading = false;
    if (kind === 'item') {
      if (!list) { list = el('ul', { class: 'mr-items' }); doc.append(list); }
      list.append(el('li', { text: line }));
      return;
    }
    list = null;
    doc.append(el(kind === 'heading' ? 'h4' : 'p', { class: `mr-${kind}`, text: line }));
  });
  return doc;
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
