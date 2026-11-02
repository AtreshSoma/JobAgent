/** The application profile dialog, question queue, System health and downloads. */

import { $, el, fmt, relTime, slowProgress, toast } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { cssEscape } from './detail.js';
import { guardDialog, openDialog } from './dialogs.js';
import { formIsDirty, restoreForm, saveOnlyOnPurpose, snapshotForm } from './forms.js';
import { setSystemNotices } from './today.js';
import { miniTable } from './reports.js';

/* ─────────────────── application profile + question queue ─────────────────── */

// Closing this dialog with typed-but-unsaved text asks first (see dialogs.js).
guardDialog($('dlgProfile'), () => formIsDirty($('profileBody')));

/**
 * The profile page has three commitments, so it has three save buttons: the
 * details form, one queued question at a time, and the saved-answer list. A
 * single "Save" spanning all three would leave it unclear what a click writes.
 */
export async function openProfile() {
  const body = $('profileBody');
  const stop = slowProgress(body, 'Loading your application profile…');
  profileMessage('');
  openDialog($('dlgProfile'));
  // Opening starts from what is stored: nothing typed before is still on screen.
  try { await renderProfile({ keep: false }); } finally { stop(); }
}

export function profileMessage(text, tone = 'muted') {
  const node = $('profileMsg');
  node.className = `grow-1 ${tone}`;
  node.textContent = text;
}

/**
 * Redraw the dialog from the server's copy.
 *
 * Each of the three sections saves on its own, and each save lands here. The
 * redraw used to replace everything, so text typed into a section that was NOT
 * being saved vanished (and the open "Saved answers" list snapped shut). What
 * the person has typed is carried across instead; only controls the save just
 * COMMITTED take the stored value.
 *
 * @param {object} [options]
 * @param {boolean} [options.keep=true] carry unsaved edits across (false when opening)
 * @param {string|null} [options.committed] selector for the controls this save just wrote
 */
export async function renderProfile({ keep = true, committed = null } = {}) {
  const body = $('profileBody');
  let data;
  try { data = await api('/api/profile'); }
  catch (err) {
    body.textContent = '';
    body.append(el('div', { class: 'st-blocked', text: err.message }));
    return;
  }
  state.profile = data;
  // Taken AFTER the fetch, so keystrokes made while it was in flight count too.
  const pending = keep ? snapshotForm(body, { skip: committed }) : null;
  body.textContent = '';

  if (!data.available) {
    body.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: data.reason })));
    return;
  }

  // A long question queue would otherwise bury the details form under several
  // screens of scroll, which is the section most visits are actually after.
  body.append(el('nav', { class: 'pf-nav', 'aria-label': 'Profile sections' },
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'pf-jump', 'data-target': 'pfQuestions', text: `Questions (${fmt(data.questions.openCount)})` }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'pf-jump', 'data-target': 'pfDetails', text: 'Your details' }),
    el('button', { type: 'button', class: 'small ghost', 'data-action': 'pf-jump', 'data-target': 'pfAnswers', text: `Saved answers (${fmt((data.screening.answers ?? []).length)})` })));

  body.append(renderQuestionQueue(data.questions));
  body.append(renderProfileFields(data.profile));
  body.append(renderSavedAnswers(data.screening));
  restoreForm(body, pending);
  renderHealthProfileFlag();
}

/** The work: questions a real form asked that the filler could not answer. */
export function renderQuestionQueue(queue) {
  const section = el('section', { class: 'pf-section', id: 'pfQuestions' });
  section.append(el('h3', { text: `Questions waiting on you (${fmt(queue.openCount)})` }));

  if (queue.error) {
    section.append(el('div', { class: 'st-blocked', text: queue.error }));
    return section;
  }
  if (!queue.openCount) {
    section.append(el('div', { class: 'muted' },
      'Nothing queued. Every question the last auto-fill runs met was answered from your saved answers. '
      + 'When a form asks something new, it lands here so you can answer it once instead of every time.'));
    return section;
  }

  section.append(el('div', { class: 'evidence-note' },
    `${fmt(queue.requiredCount)} of these were marked required by the form, which is what stopped the run. `
    + 'An answer saved here is used by every future application that asks the same thing.'));

  for (const q of queue.open) {
    const item = el('div', { class: 'pf-q' });
    const head = el('div', { class: 'pf-q-head' });
    head.append(el('b', { text: q.label }));
    if (q.required) head.append(el('span', { class: 'chip bad', text: 'required' }));
    head.append(el('span', {
      class: 'faint',
      text: `asked ${fmt(q.seenCount)}×${relTime(q.lastSeenAt) ? ` · last ${relTime(q.lastSeenAt)}` : ''}`,
    }));
    item.append(head);

    const asked = (q.jobs ?? []).map((j) => [j.company, j.title].filter(Boolean).join(' — ')).filter(Boolean);
    if (asked.length) item.append(el('div', { class: 'faint fineprint', text: `Seen on: ${asked.join(' · ')}` }));
    if (q.note) item.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }), el('div', { text: q.note })));

    // The live form's own choices, offered as one-click fills. The stored value
    // stays free text — the filler maps it onto whatever the next form's option
    // list happens to be called.
    const options = (q.options ?? []).map((o) => o.label).filter(Boolean);
    if (options.length && options.length <= 8) {
      const row = el('div', { class: 'row-gap pf-choices' });
      row.append(el('span', { class: 'faint', text: 'The form offered:' }));
      for (const option of options) {
        row.append(el('button', {
          type: 'button', class: 'small ghost', 'data-action': 'use-question-choice',
          'data-key': q.key, 'data-value': option, text: option,
        }));
      }
      item.append(row);
    }

    item.append(el('label', { for: `qa-${q.key}`, text: 'Your answer' }));
    item.append(el('textarea', { id: `qa-${q.key}`, rows: '2', 'data-q-answer': q.key }));

    const details = el('details', { class: 'pf-adv' });
    details.append(el('summary', { text: 'Matching (edit if this should cover other wordings)' }));
    details.append(el('label', { for: `qp-${q.key}`, text: 'Match a question containing any of these phrases' }));
    details.append(el('input', {
      type: 'text', id: `qp-${q.key}`, 'data-q-patterns': q.key,
      value: (q.suggestedPatterns ?? []).join(' | '),
      title: 'Separate alternatives with |. A phrase must not end in punctuation.',
    }));
    details.append(el('label', { for: `qi-${q.key}`, text: 'Id' }));
    details.append(el('input', { type: 'text', id: `qi-${q.key}`, 'data-q-id': q.key, value: q.suggestedId }));
    item.append(details);

    const actions = el('div', { class: 'row-gap' });
    actions.append(el('button', {
      type: 'button', class: 'small primary', 'data-action': 'save-question-answer', 'data-key': q.key,
      text: 'Save answer',
    }));
    actions.append(el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'dismiss-question', 'data-key': q.key,
      title: 'Keep it out of this list. The runner will still stop for it on every application.',
      text: "I'll answer this by hand",
    }));
    item.append(actions);
    section.append(item);
  }
  return section;
}

/** Who you are — the values the filler types into contact fields. */
export function renderProfileFields(profile) {
  const section = el('section', { class: 'pf-section', id: 'pfDetails' });
  section.append(el('h3', { text: 'Your details' }));

  if (profile.error) {
    section.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: profile.error })));
  }
  // State what is actually true of BOTH tiers. Saying "every field has a value"
  // while three optional boxes were blank was an overclaim in exactly the place
  // the page exists to be trusted.
  const missing = profile.missing ?? [];
  const blankOptional = (profile.fields ?? []).filter((f) => !f.required && !f.filled).length;
  const optionalNote = blankOptional
    ? ` ${blankOptional} optional field(s) are blank — a form asking for one gets nothing.`
    : '';
  section.append(el('div', { class: missing.length ? 'attention' : 'evidence-note' },
    missing.length ? el('span', { class: 'mark', text: '!' }) : null,
    el('div', {}, missing.length
      ? `${missing.length} required field(s) are empty, so every application leaves them blank — `
        + `which is what turns an auto-fill run into "blocked".${optionalNote}`
      : `Every required field has a value, typed onto forms exactly as written here.${optionalNote}`)));

  const grid = el('div', { class: 'pf-grid' });
  for (const field of profile.fields ?? []) {
    const cell = el('div', { class: 'pf-cell' });
    cell.append(el('label', { for: `pf-${field.field}` },
      field.label,
      field.required ? el('span', { class: 'pf-req', title: 'Required by most application forms', text: ' *' }) : null));
    // A value that is still the shipped template text ("Your City") is not the
    // person's answer. It is shown as grey placeholder text in an EMPTY box, so
    // it reads as "fill this in" and is never submitted as if it were theirs.
    const template = field.placeholder === true;
    cell.append(el('input', {
      type: field.type === 'url' ? 'url' : 'text',
      id: `pf-${field.field}`, 'data-path': field.path,
      value: template ? '' : (field.value ?? ''),
      placeholder: template ? field.value : null,
      'data-template': template ? '' : null,
      // type=email/tel would let the browser block a save with its own bubble,
      // which hides the server's specific reason. Validation lives on the server.
      inputmode: field.type === 'tel' ? 'tel' : null,
    }));
    if (field.hint) cell.append(el('div', { class: 'faint fineprint', text: field.hint }));
    grid.append(cell);
  }
  // A form, so Enter in any field saves — the same one-path submit the small
  // dialogs use (see the document 'submit' listener).
  const form = el('form', { class: 'pf-form', 'data-submit': 'save-profile', novalidate: true });
  form.append(grid, el('div', { class: 'row-gap' },
    el('button', { type: 'submit', class: 'small primary', text: 'Save details' }),
    el('span', { class: 'faint fineprint', text: profile.path ?? '' })));
  // Enter in a box must not save half-finished work; Ctrl/Cmd+Enter does.
  saveOnlyOnPurpose(form);
  section.append(form);
  return section;
}

/** The answers already in config, editable and deletable. */
export function renderSavedAnswers(screening) {
  const section = el('section', { class: 'pf-section', id: 'pfAnswers' });
  const wrap = el('details', { class: 'pf-saved', 'data-keep': 'saved-answers' });
  wrap.append(el('summary', { text: `Saved answers (${fmt((screening.answers ?? []).length)})` }));

  if (screening.error) {
    wrap.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: screening.error })));
  }

  // ANSWERS THE ACTIVE PROFILE STATES ON YOUR BEHALF.
  //
  // These are generated from the profile and take precedence over an entry of
  // the same name below, so that switching profiles cannot leave one person's
  // work authorization or pay expectation on another person's application.
  // Without showing them, editing the entry below would appear to do nothing
  // and there would be no way to find out why.
  const derived = screening.derivedAnswers ?? [];
  let overridden = new Set();
  if (derived.length) {
    const shadowed = new Set(derived.map((d) => String(d.id).toLowerCase()));
    const note = el('div', { class: 'evidence-note' });
    note.append(el('div', {}, el('b', { text: 'From your search profile. ' }),
      `${derived.length} answer(s) are filled in from the active profile and used instead of `
      + 'anything with the same name below. Change them by editing the profile.'));
    // A real definition list: these are question -> answer pairs, and a screen
    // reader should hear them as pairs rather than as one run-on line.
    const list = el('dl', { class: 'kv' });
    for (const entry of derived) {
      list.append(el('dt', { text: entry.id }));
      list.append(el('dd', { text: entry.answer }));
    }
    note.append(list);
    wrap.append(note);
    overridden = shadowed;
  }

  for (const entry of screening.answers ?? []) {
    const row = el('div', { class: 'pf-answer', 'data-answer-id': entry.id });
    // Marked from a local set rather than by tagging the entry: these objects
    // come from the cached API response, and a flag written onto them would
    // survive into later renders after the override had gone away.
    if (overridden.has(String(entry.id).toLowerCase())) {
      row.append(el('div', { class: 'muted small' },
        'Not in use — your search profile answers this one.'));
    }
    // LABELS ARE WIRED TO THEIR CONTROLS, not merely placed above them.
    //
    // These were bare <label> elements with no `for`, so a screen reader
    // announced each box as an unlabelled edit field and clicking the caption
    // did not focus anything. `id` is derived from the answer id, which is
    // already unique within the document and constrained to
    // [a-z0-9_-] by validateAnswerEntry — so it is safe in an id attribute.
    const patternsId = `answer-patterns-${entry.id}`;
    const answerId = `answer-text-${entry.id}`;
    row.append(el('div', { class: 'pf-answer-id' }, el('b', { text: entry.id })));
    row.append(el('label', { text: 'Matches questions containing', for: patternsId }));
    row.append(el('input', {
      type: 'text', id: patternsId, 'data-a-patterns': entry.id,
      value: (entry.patterns ?? []).join(' | '),
    }));
    row.append(el('label', { text: 'Answer', for: answerId }));
    // `text`, not `.value =`: it sets the textarea's DEFAULT value, which is how
    // the browser (and forms.js) tells "as rendered" from "edited since".
    // Template text ("YOUR total years…") is not an answer: it is shown as grey
    // placeholder text in an empty box. The original rides along in data-template
    // so an untouched box can be saved back exactly as it was stored.
    const template = entry.placeholder === true;
    row.append(el('textarea', {
      rows: '2', id: answerId, 'data-a-answer': entry.id,
      ...(template ? { placeholder: entry.answer ?? '', 'data-template': entry.answer ?? '' } : { text: entry.answer ?? '' }),
    }));
    row.append(el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'delete-answer', 'data-id': entry.id,
      text: '✕ Delete this answer',
    }));
    wrap.append(row);
  }
  wrap.append(el('div', { class: 'row-gap' },
    el('button', { type: 'button', class: 'small primary', 'data-action': 'save-answers', text: 'Save all answers' }),
    el('span', { class: 'faint fineprint', text: screening.path ?? '' })));
  section.append(wrap);
  return section;
}

/** Split a "a | b | c" pattern box into trimmed alternatives. */
export const splitPatterns = (value) => String(value ?? '').split('|').map((p) => p.trim()).filter(Boolean);

export async function saveProfileDetails() {
  const values = {};
  for (const input of $('profileBody').querySelectorAll('[data-path]')) {
    // Still showing its template placeholder and never typed in: not the
    // person's data, so it is not sent and the stored value is left alone.
    if (input.hasAttribute('data-template') && !input.value.trim()) continue;
    values[input.dataset.path] = input.value;
  }
  profileMessage('Saving…');
  try {
    const result = await postJson('/api/profile', { values });
    profileMessage(result.warning ?? '', result.warning ? 'st-blocked' : 'muted');
    toast(result.changed.length
      ? `Saved — ${result.changed.length} field(s) changed. New applications use these values.`
      : 'No changes to save.', 'good');
    await renderProfile({ committed: '[data-path]' });
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

export async function saveQuestionAnswer(key) {
  const body = $('profileBody');
  const answer = body.querySelector(`[data-q-answer="${cssEscape(key)}"]`)?.value ?? '';
  const patterns = splitPatterns(body.querySelector(`[data-q-patterns="${cssEscape(key)}"]`)?.value);
  const id = body.querySelector(`[data-q-id="${cssEscape(key)}"]`)?.value ?? '';
  const question = state.profile?.questions?.open?.find((q) => q.key === key)?.label ?? '';
  if (!answer.trim()) { profileMessage('Type the answer first.', 'st-blocked'); return; }

  profileMessage('Saving…');
  try {
    await postJson('/api/profile/questions/answer', { key, id, patterns, answer, question, type: 'text' });
    toast('Answered. Every future application that asks this fills it automatically.', 'good');
    profileMessage('');
    // The answered question leaves the queue; every OTHER box keeps its text.
    const k = cssEscape(key);
    await renderProfile({ committed: `[data-q-answer="${k}"], [data-q-patterns="${k}"], [data-q-id="${k}"]` });
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

export async function setQuestionStatus(key, status) {
  try {
    await postJson('/api/profile/questions/status', { key, status });
    await renderProfile();
  } catch (err) { profileMessage(err.message, 'st-blocked'); }
}

export async function saveAllAnswers({ removeId = null } = {}) {
  const body = $('profileBody');
  const answers = [];
  for (const row of body.querySelectorAll('[data-answer-id]')) {
    const id = row.dataset.answerId;
    if (id === removeId) continue;
    const existing = (state.profile?.screening?.answers ?? []).find((a) => a.id === id) ?? {};
    const box = row.querySelector('[data-a-answer]');
    const typed = box?.value ?? '';
    // A box still showing its template placeholder was never answered. The save
    // replaces the whole list, so that entry goes back exactly as stored; it is
    // not something the person typed.
    const unanswered = box?.dataset.template !== undefined && !typed.trim();
    answers.push({
      id,
      patterns: splitPatterns(row.querySelector('[data-a-patterns]')?.value),
      answer: unanswered ? box.dataset.template : typed,
      type: existing.type ?? 'text',
    });
  }
  profileMessage('Saving…');
  try {
    const result = await postJson('/api/profile/answers', {
      defaults: state.profile?.screening?.defaults ?? {},
      answers,
    });
    profileMessage(result.warning ?? '', result.warning ? 'st-blocked' : 'muted');
    toast(removeId ? `Deleted "${removeId}".` : `Saved ${result.count} answer(s).`, 'good');
    // Every answer row was just written, so those take the stored value; an
    // unsaved details edit or queued-question answer is still the person's.
    await renderProfile({ committed: '[data-a-answer], [data-a-patterns]' });
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

/**
 * A pill in the health strip when the profile cannot fill a form completely.
 * The number it shows is the number of rows the dialog opens on — never a
 * separate tally that could drift from it.
 */
export function renderHealthProfileFlag() {
  const host = $('health');
  host.querySelector('.stat.pf-flag')?.remove();
  const data = state.profile;
  if (!data?.available) return;
  const open = data.questions?.openCount ?? 0;
  const missing = data.profile?.missing?.length ?? 0;
  if (!open && !missing) return;
  // Each count bold inside its own words ("1 empty field"). A separate bold
  // total in front read as "1 1 empty field" — the number twice.
  const parts = [];
  if (open) parts.push([open, ` question${open === 1 ? '' : 's'}`]);
  if (missing) parts.push([missing, ` empty field${missing === 1 ? '' : 's'}`]);
  const nodes = parts.flatMap(([n, words], i) => [...(i ? [el('span', { class: 'l', text: ' · ' })] : []),
    el('b', { text: String(n) }), el('span', { class: 'l', text: words })]);
  host.append(el('button', {
    type: 'button', class: 'stat clickable attn pf-flag', 'data-action': 'open-profile',
    title: 'Open the application profile to fill these in.',
  }, ...nodes));
}

export async function loadProfileFlag() {
  try {
    state.profile = await api('/api/profile');
    renderHealthProfileFlag();
  } catch { /* the flag is an extra; never break the board over it */ }
}

export async function openHealth() {
  const body = $('healthBody');
  const stop = slowProgress(body, 'Running the system checks — config, Python, the browser…');
  openDialog($('dlgHealth'));
  let health;
  try { health = await api('/api/health'); }
  catch (err) { stop(); body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }
  stop();
  // The same report feeds Today's setup checklist; keep the two in step.
  state.health = health;
  setSystemNotices(state.today?.systemNotices ?? []);

  body.textContent = '';
  const checks = Array.isArray(health.checks) ? health.checks : [];
  if (!checks.length) {
    body.append(el('pre', { text: JSON.stringify(health, null, 2) }));
    return;
  }

  const summary = health.summary ?? {};
  const overall = el('div', { class: health.ok ? 'grounded-note' : 'attention' });
  overall.append(health.ok
    ? 'All required checks pass.'
    : `${summary.fail ?? 0} check(s) need attention${summary.warn ? `, ${summary.warn} warning(s)` : ''}.`);
  body.append(overall);

  // Doctor severities: pass / warn / fail.
  const tone = { pass: 'good', warn: 'warn', fail: 'bad' };
  body.append(miniTable(['Check', 'Status', 'Detail', 'How to fix'], checks.map((c) => [
    c.label ?? c.id ?? '—',
    el('span', { class: `chip ${tone[c.status] ?? ''}`, text: c.status ?? '—' }),
    c.detail ?? '—',
    c.fix ?? '—',
  ])));
}

export function download(path, filename) {
  return fetch(path).then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = el('a', { href, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    // Revoking in the same tick can cancel the download the click just started.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    toast(`Downloaded ${filename}`, 'good');
  }).catch((err) => toast(err.message, 'bad'));
}
