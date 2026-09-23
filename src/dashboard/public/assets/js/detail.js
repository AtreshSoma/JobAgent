/** The detail rail / sheet: keyed sections, notes autosave, action plans, resume card. */

import { $, el, esc, safeHref, shortStamp, toast } from './dom.js';
import { state } from './state.js';
import { api, postJson } from './api.js';
import { sponsorshipEvidence, sponsorshipTitle, statusLabel } from './board.js';
import { openDialog } from './dialogs.js';
import { decide } from './mutations.js';
import { autofillBlockedReason, BROWSER_MISSING } from './today.js';

/* ──────────────────────── detail rail ──────────────────────── */

/**
 * Narrow layouts show the detail in a sheet; wide ones in the sticky rail.
 *
 * At <=1240px the page is one column, and the rail used to land UNDER the
 * whole board: selecting a row changed something ~7,000px below the viewport
 * and nothing on screen. The sheet opens where the user is looking.
 */
export const SHEET_QUERY = matchMedia('(max-width: 1240px)');
export const isSheetLayout = () => SHEET_QUERY.matches;

export let selectTimer = null;

/** Mark the open job's row, and only that row. */
export function markCurrentRow(id) {
  for (const tr of $('rows').querySelectorAll('tr.job')) {
    // Present-or-absent, not "true"/"false": aria-current="false" is a valid
    // value meaning "not current", but it still marks the row as participating,
    // and 99 rows announcing their non-currency is noise.
    if (tr.dataset.id === id) tr.setAttribute('aria-current', 'true');
    else tr.removeAttribute('aria-current');
  }
  for (const card of document.querySelectorAll('.tcard[data-id]')) {
    card.classList.toggle('current', card.dataset.id === id);
  }
}

/**
 * Open a job in the detail rail.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {boolean} [options.focusRow] move focus to the job's board row
 * @param {boolean} [options.user] a person asked for this job (click, Enter,
 *   a Today card). On a narrow layout that opens the sheet; a background
 *   refresh re-rendering the same job never does.
 * @param {number} [options.defer] debounce the fetch, in ms. Arrow-key browsing
 *   fired one detail request per keypress; holding ↓ for a second queued ~30.
 */
export async function selectJob(id, { focusRow = false, user = false, defer = 0 } = {}) {
  // Leaving a job with an unsaved note saves it rather than dropping it.
  if (id !== state.selectedId) flushNote();
  state.selectedId = id;
  markCurrentRow(id);
  if (focusRow) {
    $('rows').querySelector(`tr.job[data-id="${cssEscape(id)}"]`)?.focus();
  }
  history.replaceState(null, '', `#job=${encodeURIComponent(id)}`);
  if (user && isSheetLayout()) openDetailSheet(id);

  clearTimeout(selectTimer);
  if (defer > 0) {
    await new Promise((resolve) => { selectTimer = setTimeout(resolve, defer); });
    if (state.selectedId !== id) return;
  }
  await loadDetail(id);
}

export async function loadDetail(id) {
  const host = $('detail');
  let job;
  try {
    job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    if (state.selectedId !== id) return;
    host.textContent = '';
    host.append(el('div', { class: 'panel empty', text: err.message }));
    return;
  }
  if (state.selectedId !== id) return; // user moved on
  state.detailJob = job;
  state.known.set(job.id, { ...(state.known.get(job.id) ?? {}), ...job });
  renderDetail(job);
}

export function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

/** The element that scrolls the detail: the sheet body, or the sticky rail. */
export function railScroller() {
  const sheet = $('dlgDetail');
  return sheet?.open ? $('dlgDetailBody') : document.querySelector('.rail-sticky');
}

/** Put #detail wherever the current layout shows it. */
export function placeDetail() {
  const detail = $('detail');
  const sheet = $('dlgDetail');
  if (!detail || !sheet) return;
  if (isSheetLayout()) {
    if (detail.parentElement !== $('dlgDetailBody')) $('dlgDetailBody').append(detail);
  } else {
    if (sheet.open) sheet.close();
    const rail = document.querySelector('.rail-sticky');
    if (detail.parentElement !== rail) rail.append(detail);
  }
}

/** Which job the sheet was opened for, so closing it can return focus there. */
export let sheetReturnId = null;

export function openDetailSheet(id) {
  const sheet = $('dlgDetail');
  sheetReturnId = id;
  placeDetail();
  if (!sheet.open) sheet.showModal();
  // Focus goes to the sheet's heading, not its first button: landing on
  // "Open posting" or "Reject" is one Enter away from an action nobody chose.
  $('dlgDetailTitle').focus();
}

/** The control that represents a job wherever it is currently visible. */
export function jobAnchor(id) {
  const selector = `tr.job[data-id="${cssEscape(id)}"], .tcard[data-id="${cssEscape(id)}"] .tcard-title`;
  return [...document.querySelectorAll(selector)].find((node) => node.offsetParent !== null) ?? null;
}

/*
 * THE RAIL IS RECONCILED, NOT REBUILT.
 *
 * Every refresh — the 90s background poll, each decision, each link save, the
 * end of a run — used to clear the rail and draw it again. That wiped a note
 * being typed (verified: the text was simply gone), threw focus to <body>,
 * shut every open <details>, jumped the rail back to the top and erased the
 * link-check result. The rail is now a list of keyed sections: re-rendering
 * the SAME job swaps only sections the user is not in, and leaves a section
 * holding focus — or an unsaved note — exactly as it is.
 */
export const railSection = (key, ...children) => el('div', { class: 'rail-sec', 'data-section': key }, ...children);

export function renderDetail(job) {
  const host = $('detail');
  const sections = detailSections(job);
  const current = host.querySelector(':scope > .panel[data-job-id]');
  if (current && current.dataset.jobId === job.id) {
    reconcileDetail(current, sections);
    return;
  }
  if (note.id !== job.id) {
    note.id = job.id;
    note.saved = job.notes ?? '';
  }
  host.textContent = '';
  const panel = el('div', { class: 'panel detail-panel', 'data-job-id': job.id });
  panel.append(...sections);
  host.append(panel);
  // A different job starts at its top; the same job keeps its place (above).
  const scroller = railScroller();
  if (scroller) scroller.scrollTop = 0;
}

/** A section is left untouched while the user is working inside it. */
export function keepSection(node, key) {
  return node.contains(document.activeElement) || (key === 'notes' && note.isDirty());
}

/** Re-apply the open/closed state of keyed <details> to their replacement. */
export function carryOpenDetails(from, to) {
  for (const open of from.querySelectorAll('details[data-key][open]')) {
    to.querySelector(`details[data-key="${cssEscape(open.dataset.key)}"]`)?.setAttribute('open', '');
  }
}

export function reconcileDetail(panel, sections) {
  const scroller = railScroller();
  const top = scroller?.scrollTop ?? 0;
  const old = new Map([...panel.children].map((node) => [node.dataset.section, node]));
  let anchor = null;
  for (const node of sections) {
    const key = node.dataset.section;
    const prev = old.get(key);
    old.delete(key);
    let placed = node;
    // A kept node is never MOVED: detaching an element, even to reinsert it a
    // moment later, blurs whatever inside it had focus.
    if (prev && keepSection(prev, key)) placed = prev;
    else if (prev) { carryOpenDetails(prev, node); prev.replaceWith(node); }
    else if (anchor) anchor.after(node);
    else panel.prepend(node);
    anchor = placed;
  }
  for (const [key, prev] of old) if (!keepSection(prev, key)) prev.remove();
  if (!old.has('notes') && !note.isDirty()) note.saved = state.detailJob?.notes ?? note.saved;
  if (scroller) scroller.scrollTop = top;
}

/** The grade's own label is the verdict; `fit` is only the fallback. */
export function verdictLabel(job) {
  return job.grade?.label ?? fitLabel(job.fit);
}

export function detailSections(job) {
  const out = [];

  // header — the grade's label is the one verdict shown. A separate chip that
  // re-derived "medium fit" from `job.fit` could sit next to a grade reading
  // "Strong fit", and the two then contradicted each other.
  const head = el('div', { class: 'detail-head' });
  head.append(el('span', {
    class: `grade big ${job.grade ? job.grade.letter : 'none'}`,
    role: 'img',
    'aria-label': job.grade ? `grade ${job.grade.letter}, ${job.grade.label}` : 'not scored yet',
    text: job.grade ? job.grade.letter : '—',
  }));
  const headMain = el('div', { class: 'grow-1' });
  headMain.append(el('h2', { class: 'detail-title', text: `${job.company || 'Company on posting'} — ${job.title}` }));
  const meta = [job.location, job.remote ? 'remote' : null, job.postedLabel, `via ${job.source}`,
    job.atsPlatform ? `ATS ${job.atsPlatform}` : null].filter(Boolean).join(' · ');
  headMain.append(el('div', { class: 'muted detail-meta', title: meta, text: meta }));

  const chips = el('div', { class: 'chiprow' });
  chips.append(el('span', {
    class: `chip ${job.fit}`,
    title: job.score != null ? `Skills-match score ${job.score}/100` : 'Not scored yet',
    text: job.score != null ? `${verdictLabel(job)} · ${job.score}` : verdictLabel(job),
  }));
  chips.append(el('span', {
    class: `chip ${esc(job.sponsorship ?? '')}`,
    title: sponsorshipTitle(job),
    text: `sponsorship: ${job.sponsorship ?? 'unknown'}`,
  }));
  if (job.employmentLabel) chips.append(el('span', { class: 'chip', text: job.employmentLabel }));
  chips.append(el('span', { class: `chip st-${job.appStatus}`, text: statusLabel(job) }));
  if (job.decisionReason) {
    chips.append(el('span', { class: 'chip', title: 'Why you closed this job', text: `reason: ${reasonLabel(job.decisionReason)}` }));
  }
  if (job.atsScore != null) {
    chips.append(el('span', { class: 'chip', title: 'Resume/JD keyword match from the ATS report', text: `ATS ${job.atsScore}%` }));
  }
  headMain.append(chips);
  head.append(headMain);
  out.push(railSection('head', head));
  out.push(railSection('stepper', stepper(job.progress)));

  // attention
  if (job.statusReason && ['blocked', 'failed', 'cancelled', 'rejected', 'discarded', 'skipped',
    'date_unconfirmed', 'submit_unverified', 'needs_description'].includes(job.appStatus)) {
    const box = el('div', { class: 'attention' });
    box.append(el('span', { class: 'mark', text: '!' }));
    const detail = el('div', {});
    detail.append(el('b', { text: statusLabel(job) }), el('br'),
      job.attention?.summary || job.statusReason);
    if (job.attention?.summary && job.statusReason !== job.attention.summary) {
      const more = el('details', { 'data-key': 'technical' });
      more.append(el('summary', { class: 'muted', text: 'Technical detail' }),
        el('div', { class: 'muted', text: job.statusReason }));
      detail.append(more);
    }
    box.append(detail);
    out.push(railSection('attention', el('h3', { text: 'Needs attention' }), box));
  }

  // next best action
  out.push(railSection('next', el('h3', { text: 'Do this next' }), nextBestAction(job)));

  // resume card — the feature the workflow revolves around
  out.push(railSection('resume', resumeCard(job)));

  // quick actions
  const actions = el('div', { class: 'actions' });
  // A row with no stored URL used to render a dead <a> with no href that looked
  // clickable and did nothing. Say what is missing instead.
  const postingHref = safeHref(job.url);
  if (postingHref) {
    actions.append(el('a', { class: 'btn', href: postingHref, target: '_blank', rel: 'noopener noreferrer', text: 'Open posting ↗' }));
    actions.append(el('button', { class: 'small', 'data-action': 'check-link', 'data-id': job.id, text: 'Check link' }));
  } else {
    actions.append(el('span', { class: 'chip bad', title: 'This job has no application URL stored', text: 'no posting URL' }));
  }
  actions.append(el('button', { class: 'small', 'data-action': 'open-link-dialog', 'data-id': job.id, text: 'Replace URL' }));
  for (const [decision, label] of [['shortlisted', '★ Shortlist'], ['rejected', '✕ Reject'],
    ['archived', 'Archive'], ['clear', 'Clear']]) {
    actions.append(el('button', {
      class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': decision, text: label,
    }));
  }
  if (job.approvalStatus === 'pending_review') {
    actions.append(el('button', { class: 'small', 'data-action': 'reject-packet', 'data-id': job.id, text: 'Reject packet' }));
  }
  // Available at every stage except the ones where it's meaningless: already
  // recorded (submitted) or a closed/dead row (rejected/archived/discarded).
  // Applying yourself, outside the guided flow, is not gated on having run
  // Prepare/Approve/Auto-fill first — a job can sit at `discovered` or `scored`
  // and still have been applied to on the employer's own site.
  if (!['submitted', 'rejected', 'archived', 'discarded'].includes(job.appStatus)) {
    actions.append(el('button', { class: 'small', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: 'I submitted it myself' }));
  }
  // The last link check survives re-renders: it is a result the user asked
  // for, and redrawing the rail used to erase it a few seconds later.
  const health = state.linkHealth.get(job.id);
  out.push(railSection('actions', actions, el('div', {
    class: `linkhealth ${health?.tone ?? ''}`.trim(), id: 'linkHealth', 'aria-live': 'polite', text: health?.text ?? '',
  })));

  // submission record
  if (job.appStatus === 'submitted') {
    const box = el('div', { class: 'why' });
    box.append(`Submitted by you on ${shortStamp(job.appliedAt)}`);
    if (job.submittedConfirmation) {
      box.append(el('br'), 'Confirmation: ', el('b', { text: job.submittedConfirmation }));
    }
    out.push(railSection('submission', el('h3', { text: 'Submission record' }), box));
  }

  out.push(railSection('sponsorship', el('h3', { text: 'Sponsorship' }), sponsorshipEvidence(job)));

  out.push(railSection('fit',
    el('h3', { text: job.grade?.label ? `Why: ${job.grade.label.toLowerCase()}` : 'Why this may be a fit' }),
    el('div', { class: 'why', text: job.explanation ?? job.discardReason ?? 'Not scored yet.' })));

  out.push(railSection('skills',
    el('h3', { text: 'Your skills found in this posting' }), keywordList(job.matchedKeywords, 'good'),
    el('h3', { text: 'Asked for, not evidenced in your resume' }), keywordList(job.missingKeywords, 'bad')));

  out.push(railSection('notes', notesEditor(job)));

  // assist history
  if (job.assistFilledCount != null) {
    const box = el('div', {});
    box.append(`${job.assistFilledCount} field(s) filled`);
    if (job.assistBlockers?.length) {
      const ul = el('ul', { class: 'plan' });
      for (const blocker of job.assistBlockers) ul.append(el('li', { class: 'st-blocked', text: blocker }));
      box.append(ul);
    } else box.append(' · no blockers');
    out.push(railSection('assist', el('h3', { text: 'Last assisted fill' }), box));
  }

  if (job.packet) out.push(railSection('packet', packetSection(job.packet)));

  // job id (for the browser extension)
  const idRow = el('div', { class: 'row-gap' });
  idRow.append(el('code', { class: 'jobid', text: job.id }),
    el('button', { class: 'small', 'data-action': 'copy-id', 'data-id': job.id, text: 'Copy' }));
  out.push(railSection('jobid', el('h3', { text: 'Job id' }), idRow));

  if (job.events?.length) {
    const ul = el('ul', { class: 'plan' });
    for (const event of job.events) {
      ul.append(el('li', {},
        el('span', { class: 'faint', text: shortStamp(event.at) }), ` ${event.type} — ${event.message ?? ''}`));
    }
    out.push(railSection('audit', el('h3', { text: 'Audit trail' }), ul));
  }
  return out;
}

/* ─────────────────────────── notes ───────────────────────────
 * Notes save themselves: a debounce while typing, and immediately on blur or
 * when another job is opened. There was only a "Save note" button, and
 * anything typed without pressing it was lost to the next refresh. */

export const NOTE_DEBOUNCE_MS = 1200;

export const note = {
  /** Job the editor belongs to, and the value the server last confirmed. */
  id: null,
  saved: '',
  timer: null,
  inflight: null,
  box() {
    const box = $('noteBox');
    return box && box.dataset.id === this.id ? box : null;
  },
  isDirty() {
    const box = this.box();
    return Boolean(box) && (box.value !== this.saved || this.inflight !== null);
  },
};

export function notesEditor(job) {
  const wrap = el('div', { class: 'notes' });
  const textarea = el('textarea', {
    id: 'noteBox', 'data-id': job.id, rows: '3', 'aria-describedby': 'noteStatus',
    placeholder: 'Private reminders — saved as you type, and exported to CSV…',
  });
  textarea.value = job.notes ?? '';
  wrap.append(el('label', { for: 'noteBox', class: 'rail-label', text: 'Your notes' }), textarea,
    el('div', { class: 'note-foot' },
      el('span', { id: 'noteStatus', class: 'note-status faint', 'aria-live': 'polite', text: job.notes ? 'Saved' : '' }),
      el('button', { class: 'small ghost', 'data-action': 'save-note', 'data-id': job.id, text: 'Save now' })));
  return wrap;
}

export function setNoteStatus(kind, detail = '') {
  const node = $('noteStatus');
  if (!node) return;
  const text = {
    saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: `Couldn’t save — ${detail}`,
  }[kind] ?? '';
  node.textContent = text;
  node.className = `note-status ${kind === 'error' ? 'st-blocked' : kind === 'dirty' ? 'warn-text' : 'faint'}`;
}

export async function saveNote() {
  clearTimeout(note.timer);
  const box = note.box();
  if (!box) return;
  const id = note.id;
  // One write at a time per job; a later edit waits and then saves the latest.
  if (note.inflight) {
    await note.inflight.catch(() => {});
    if (note.id === id) await saveNote();
    return;
  }
  const value = box.value;
  if (value === note.saved) { setNoteStatus('saved'); return; }
  setNoteStatus('saving');
  note.inflight = postJson(`/api/jobs/${encodeURIComponent(id)}/note`, { note: value });
  try {
    await note.inflight;
    if (note.id !== id) return;
    note.saved = value;
    const known = state.known.get(id);
    if (known) known.notes = value;
    if (state.detailJob?.id === id) state.detailJob.notes = value;
    setNoteStatus(note.box()?.value === value ? 'saved' : 'dirty');
  } catch (err) {
    if (note.id === id) setNoteStatus('error', err.message);
  } finally {
    note.inflight = null;
  }
}

/** Save an unsaved note for the job being left, without waiting on it. */
export function flushNote() {
  const box = note.box();
  if (!box || box.value === note.saved) return;
  clearTimeout(note.timer);
  const id = note.id;
  const value = box.value;
  note.saved = value;
  postJson(`/api/jobs/${encodeURIComponent(id)}/note`, { note: value })
    .then(() => { const known = state.known.get(id); if (known) known.notes = value; })
    .catch((err) => toast(`Your note on the previous job was not saved: ${err.message}`, 'bad'));
}

document.addEventListener('input', (event) => {
  if (event.target.id !== 'noteBox') return;
  setNoteStatus('dirty');
  clearTimeout(note.timer);
  note.timer = setTimeout(saveNote, NOTE_DEBOUNCE_MS);
});
document.addEventListener('focusout', (event) => {
  if (event.target.id === 'noteBox') saveNote();
});
// Closing the tab mid-sentence: keepalive lets the request outlive the page,
// and unlike sendBeacon it can carry the X-Job-Agent header.
window.addEventListener('pagehide', () => {
  const box = note.box();
  if (!box || box.value === note.saved) return;
  fetch(`/api/jobs/${encodeURIComponent(note.id)}/note`, {
    method: 'POST', keepalive: true,
    headers: { 'content-type': 'application/json', 'X-Job-Agent': '1' },
    body: JSON.stringify({ note: box.value }),
  }).catch(() => {});
});

/** Why a job was closed. Order is the order the chips are offered in. */
export const DECISION_REASONS = [
  ['salary', 'Salary'], ['location', 'Location'], ['seniority', 'Seniority'],
  ['sponsorship', 'Sponsorship'], ['stack', 'Stack'], ['company', 'Company'],
  ['stale', 'Stale'], ['other', 'Other'],
];
export const reasonLabel = (key) => DECISION_REASONS.find(([k]) => k === key)?.[1] ?? String(key ?? '');

export function fitLabel(fit) {
  return { strong: 'strong fit', medium: 'medium fit', weak: 'weak fit', no_fit: 'no fit', unscored: 'unscored' }[fit] ?? fit;
}

export function keywordList(list = [], tone = '') {
  if (!list.length) return el('div', { class: 'muted', text: 'none' });
  const wrap = el('div', { class: 'kwlist' });
  for (const kw of list) wrap.append(el('span', { class: `chip ${tone}`, text: kw }));
  return wrap;
}

export function stepper(progress) {
  if (!progress) return el('div');
  const labels = ['Found', 'Scored', 'Shortlist', 'Prepared', 'Approved', 'Ready', 'Submitted'];
  if (progress.offRamp) {
    return el('div', { class: 'muted' }, 'Off the happy path: ',
      el('b', { class: 'st-blocked', text: progress.stage.replace(/_/g, ' ') }));
  }
  const wrap = el('div');
  const bars = el('div', { class: 'stepper' });
  labels.forEach((_, i) => {
    bars.append(el('div', { class: `s ${i < progress.index ? 'done' : i === progress.index ? 'now' : ''}`.trim() }));
  });
  wrap.append(bars, el('div', { class: 'steplabels' },
    el('span', { text: labels[0] }),
    el('span', { text: labels[progress.index] ?? '' }),
    el('span', { text: labels.at(-1) })));
  return wrap;
}

/** True when a URL is an aggregator listing rather than a real application form. */
export function isAggregatorUrl(url) {
  try {
    return /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|simplyhired|monster|dice)\./i
      .test(new URL(url).hostname);
  } catch { return false; }
}

export function nextBestAction(job) {
  const box = el('div', { class: 'nba' });
  const { text, buttons } = actionPlan(job);
  box.append(el('div', { class: 'nba-text', text }));
  const row = el('div', { class: 'nba-actions' });
  for (const button of buttons) if (button) row.append(button);
  box.append(row);
  return box;
}

export const autofillButton = (id, label = '⚡ Auto-fill application') => {
  const blocked = autofillBlockedReason();
  return el('button', {
    class: 'small primary', 'data-action': 'autofill-one', 'data-id': id,
    disabled: Boolean(blocked),
    title: blocked ?? 'Prepare a packet if needed, approve it, open the posting, fill everything it can — and stop before Submit.',
    text: label,
  });
};

/** Where the filler's inputs live — offered wherever an auto-fill can stall. */
export const setupLinks = () => [
  el('button', { class: 'small ghost', 'data-action': 'open-profile', title: 'What the filler types, and how it answers form questions', text: '👤 Application profile' }),
  el('button', { class: 'small ghost', 'data-action': 'open-master', title: 'The resume every tailored version is built from', text: '🧾 Master resume' }),
];

export function actionPlan(job) {
  const postingHref = safeHref(job.url);
  // No safe URL means nothing to open; an <a> without an href would look
  // clickable and do nothing, so the button simply is not offered.
  const openPosting = () => (postingHref ? el('a', {
    class: 'btn small', href: postingHref, target: '_blank', rel: 'noopener noreferrer', text: 'Open posting ↗',
  }) : null);
  const markSubmitted = () => el('button', {
    class: 'small primary', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: 'I submitted it myself',
  });

  if (job.appStatus === 'submitted') {
    return { text: 'Submitted — nothing further to do.', buttons: [] };
  }
  if (job.appStatus === 'submit_unverified') {
    return {
      // The server's explanation knows whether this was our click or the
      // human's own submit; fall back to the generic wording only without it.
      text: job.statusReason || ('Auto-submit clicked Submit but no confirmation was detected. Check the ATS or your email. '
        + 'This is NOT counted as applied until you confirm.'),
      buttons: [markSubmitted(), openPosting()],
    };
  }
  if (job.appStatus === 'needs_review') {
    return {
      text: 'Packet is prepared. Review the tailored resume, then auto-fill opens the application and stops for your review.',
      buttons: [
        el('button', { class: 'small primary', 'data-action': 'preview-resume', 'data-id': job.id, text: '👁 Review resume' }),
        autofillButton(job.id),
        el('button', { class: 'small', 'data-action': 'approve', 'data-id': job.id, text: '✓ Approve only' }),
      ],
    };
  }
  if (job.appStatus === 'approved') {
    return {
      text: 'Approved. Open it in a browser — it fills the form and stops before Submit.',
      buttons: [el('button', {
        class: 'small primary', 'data-action': 'assist', 'data-id': job.id, text: '▶ Fill in browser',
        disabled: Boolean(autofillBlockedReason()), title: autofillBlockedReason(),
      }), el('button', { class: 'small', 'data-action': 'preview-resume', 'data-id': job.id, text: '👁 Resume' })],
    };
  }
  if (job.appStatus === 'ready_for_submit') {
    return {
      text: 'Filled and waiting — review the open browser tab, click Submit yourself, then record it here.',
      buttons: [markSubmitted(), autofillButton(job.id, '↻ Re-fill'), openPosting()],
    };
  }
  if (['blocked', 'failed', 'cancelled'].includes(job.appStatus)) {
    const kind = job.attention?.kind;
    if (isAggregatorUrl(job.url) || kind === 'aggregator') {
      return {
        text: 'This is an aggregator listing, not a reliable application form. Open it, follow Apply to the '
          + 'employer site, then save that direct URL here.',
        buttons: [openPosting(), el('button', {
          class: 'small', 'data-action': 'open-link-dialog', 'data-id': job.id, text: 'Save direct URL',
        })],
      };
    }
    if (['dead_link', 'restricted_link'].includes(kind)) {
      return {
        text: job.attention.summary,
        buttons: [
          el('button', { class: 'small primary', 'data-action': 'check-link', 'data-id': job.id, text: 'Check link' }),
          el('button', { class: 'small', 'data-action': 'open-link-dialog', 'data-id': job.id, text: 'Replace URL' }),
        ],
      };
    }
    // A missing browser is the cause, not this job: say so here rather than
    // offering a retry that is certain to fail the same way.
    if (state.browserUnavailable || BROWSER_MISSING.test(job.statusReason ?? '')) {
      return {
        text: 'Auto-fill could not start a browser. Install it once (npx playwright install chromium in the JobAgent folder), then retry.',
        buttons: [autofillButton(job.id, '↻ Retry auto-fill'), openPosting()],
      };
    }
    // Most stalls are a question the profile cannot answer or a field it
    // leaves blank — so the two places that fix them sit next to the retry.
    return {
      text: job.attention?.summary
        || 'The assistant stopped because this step needs you. Complete it in the browser, then retry auto-fill.',
      buttons: [openPosting(), autofillButton(job.id, '↻ Retry auto-fill'), ...setupLinks()],
    };
  }
  if (job.sponsorshipGated) {
    return {
      text: 'Strong fit, but sponsorship is unconfirmed — check the employer sponsors H-1B, then shortlist and prepare.',
      buttons: [
        openPosting(),
        el('button', { class: 'small primary', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'shortlisted', text: '★ Shortlist' }),
        autofillButton(job.id, '⚡ Auto-fill anyway'),
      ],
    };
  }
  if (job.appStatus === 'shortlisted') {
    return {
      text: 'Shortlisted — auto-fill prepares the tailored packet and fills the application in one pass.',
      buttons: [autofillButton(job.id), el('button', {
        class: 'small', 'data-action': 'prepare-one', 'data-id': job.id, text: '📄 Prepare only',
      })],
    };
  }
  if (['no_fit', 'weak'].includes(job.fit)) {
    return {
      text: 'Low fit — probably not worth your time. Reject it to keep the board focused.',
      buttons: [el('button', {
        class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'rejected', text: '✕ Reject',
      })],
    };
  }
  if (job.fit === 'strong') {
    return {
      text: 'Strong fit — auto-fill tailors the resume, fills the application, and stops before Submit.',
      buttons: [autofillButton(job.id), el('button', {
        class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'shortlisted', text: '★ Shortlist',
      })],
    };
  }
  return {
    text: 'Review the fit and sponsorship below, then shortlist or reject.',
    buttons: [autofillButton(job.id), el('button', {
      class: 'small', 'data-action': 'decide', 'data-id': job.id, 'data-decision': 'shortlisted', text: '★ Shortlist',
    })],
  };
}

/**
 * How long the tailored resume is. Says "2 pages" only when a PDF was actually
 * rendered and counted; an estimate is labelled as one rather than presented as
 * a measurement.
 */
export function pageLabel(tailoring) {
  if (!tailoring) return null;
  if (Number.isFinite(tailoring.pageCount)) {
    return `${tailoring.pageCount} page${tailoring.pageCount === 1 ? '' : 's'}`;
  }
  if (Number.isFinite(tailoring.estimatedPages)) {
    return `~${Math.max(1, Math.ceil(tailoring.estimatedPages))} page(s) est.`;
  }
  return null;
}

/** The resume review card: status, what changed, and one-click preview. */
export function resumeCard(job) {
  const card = el('div', { class: 'resume-card' });
  const head = el('div', { class: 'rc-head' });
  head.append(el('span', { class: 'rc-title', text: 'Tailored resume' }));

  const packet = job.packet;
  const hasFile = Boolean(job.resumeDocxPath || job.resumePdfPath);
  if (!hasFile) {
    head.append(el('span', { class: 'chip', text: 'not prepared' }));
    card.append(head);
    card.append(el('div', { class: 'muted', text: 'No tailored resume yet. Prepare this job to generate one from your master resume.' }));
    card.append(el('div', { class: 'actions' },
      el('button', { class: 'small primary', 'data-action': 'prepare-one', 'data-id': job.id, text: '📄 Prepare resume' }),
      el('button', {
        class: 'small ghost', 'data-action': 'open-master',
        title: 'View, edit, or replace the master resume every tailored version is built from.',
        text: '🧾 Master resume',
      }),
      el('button', {
        class: 'small ghost', 'data-action': 'open-profile',
        title: 'The details and answers the form filler uses on every application.',
        text: '👤 Application profile',
      })));
    return card;
  }

  head.append(el('span', {
    class: `chip ${packet?.resumeTailored ? 'good' : 'warn'}`,
    title: packet?.resumeTailored
      ? 'Built from your master resume for this posting'
      : 'Tailoring did not run — your master resume was used as-is',
    text: packet?.resumeTailored ? 'tailored' : 'master fallback',
  }));
  card.append(head);

  // Big, obvious click target straight into the preview.
  const thumb = el('button', { class: 'resume-thumb', 'data-action': 'preview-resume', 'data-id': job.id });
  thumb.append(el('span', { class: 'pageicon', 'aria-hidden': 'true' }));
  const tmeta = el('span', { class: 'rt-meta' });
  tmeta.append(el('b', { text: 'View tailored resume' }));
  const bits = [];
  // Length first: a resume that quietly ran to three pages is the single most
  // common thing to catch in review.
  const pages = pageLabel(packet?.tailoring);
  if (pages) bits.push(pages);
  if (packet?.atsReport?.match_score != null) bits.push(`ATS match ${packet.atsReport.match_score}%`);
  if (packet?.tailoring?.changes?.length) bits.push(`${packet.tailoring.changes.length} update(s)`);
  if (packet?.tailoring?.gaps?.length) bits.push(`${packet.tailoring.gaps.length} gap(s)`);
  tmeta.append(el('span', { text: bits.join(' · ') || 'Opens the PDF preview' }));
  thumb.append(tmeta);
  card.append(thumb);

  const links = el('div', { class: 'actions' });
  if (job.resumePdfPath) {
    links.append(el('a', {
      class: 'btn small', href: `/api/jobs/${encodeURIComponent(job.id)}/resume?format=pdf`,
      target: '_blank', rel: 'noopener', text: 'Open PDF ↗',
    }));
  }
  links.append(el('a', {
    class: 'btn small', href: `/api/jobs/${encodeURIComponent(job.id)}/resume?format=docx`, text: '⬇ DOCX',
  }));
  links.append(el('button', {
    class: 'small', 'data-action': 'prepare-one', 'data-id': job.id,
    title: 'Regenerate the tailored resume and refresh this audit', text: '↻ Re-tailor',
  }));
  card.append(links);

  if (packet?.resumeWarning) {
    card.append(el('div', { class: 'attention' }, el('span', { class: 'mark', text: '!' }),
      el('div', { text: packet.resumeWarning })));
  }
  return card;
}

export function packetSection(packet) {
  const wrap = el('div');
  if (packet.error) {
    wrap.append(el('h3', { text: 'Application packet' }));
    wrap.append(el('div', { class: 'st-blocked', text: packet.error }));
    return wrap;
  }

  wrap.append(el('h3', { text: 'Application packet' }));
  const guarantee = el('div', { class: 'muted' });
  guarantee.append(`Stops before submit: ${packet.stopBeforeSubmit ? 'yes' : 'NO — report this'} · `);
  guarantee.append(`submit-ready flag: ${packet.submitReady ? 'YES — report this' : 'no'}`);
  wrap.append(guarantee);

  if (packet.tailoring?.changes?.length || packet.tailoring?.gaps?.length) {
    wrap.append(el('h3', { text: 'What was changed in your resume' }));
    const ul = el('ul', { class: 'change-list' });
    for (const change of packet.tailoring.changes ?? []) {
      ul.append(el('li', { text: resumeChangeLabel(change) }));
    }
    if (!(packet.tailoring.changes ?? []).length) {
      ul.append(el('li', { class: 'muted', text: 'Nothing needed reordering — the master resume already led with the right content.' }));
    }
    wrap.append(ul);

    // Content that was left OUT to hold the page limit. Omissions matter as
    // much as changes at review time — this is the user's own experience being
    // held back, and they may want it in.
    const trimmed = (packet.tailoring.changes ?? [])
      .find((change) => change.type === 'fit_to_page_budget')
      ?.evidence?.[0]?.omitted ?? [];
    if (trimmed.length) {
      wrap.append(el('h3', { text: `Left out to fit the page limit (${trimmed.length})` }));
      wrap.append(el('div', {
        class: 'evidence-note',
        text: 'Whole bullets from your oldest roles, chosen as the least relevant to this '
          + 'posting. Nothing was shortened or reworded. Every role kept its dates and at '
          + 'least one bullet.',
      }));
      const omitted = el('ul', { class: 'change-list' });
      for (const entry of trimmed.slice(0, 8)) {
        omitted.append(el('li', { class: 'muted', text: entry.text }));
      }
      wrap.append(omitted);
    }

    if ((packet.tailoring.gaps ?? []).length) {
      wrap.append(el('h3', { text: 'Asked for, but not in your resume' }));
      wrap.append(el('div', {
        class: 'evidence-note',
        text: 'These were deliberately NOT added — they are job-description terms, not proven facts about you. '
          + 'If you genuinely have the experience, add a truthful bullet to your master resume and re-tailor.',
      }));
      const gaps = el('ul', { class: 'change-list' });
      for (const gap of packet.tailoring.gaps.slice(0, 8)) {
        gaps.append(el('li', {}, el('b', { text: gap.keyword ?? 'Requirement' }), ' — not evidenced'));
      }
      wrap.append(gaps);
    }
  }

  // Provenance for the optional grounded LLM requirement expansion.
  const llm = packet.llmRequirements;
  if (llm?.provenance) {
    wrap.append(el('h3', { text: 'Requirement analysis' }));
    const note = el('div', { class: 'grounded-note' });
    if (llm.provenance.skipped) {
      note.append(`Deterministic keyword matching only (${llm.provenance.skipped}).`);
    } else {
      note.append(`${llm.provenance.verified} requirement phrase(s) read from the posting`);
      if (llm.provenance.rejected) note.append(`, ${llm.provenance.rejected} rejected as not actually present`);
      note.append('. Every accepted phrase was found verbatim in the job description, and resume content '
        + 'stayed evidence-gated — nothing was written for you.');
    }
    wrap.append(note);
  }

  if (packet.prefillPlan?.length) {
    wrap.append(el('h3', { text: 'Form pre-fill plan' }));
    const ul = el('ul', { class: 'plan' });
    for (const field of packet.prefillPlan) {
      ul.append(el('li', {}, `${field.label} → `, el('b', { text: field.value }),
        ' ', el('span', { class: 'faint', text: `(${field.source})` })));
    }
    wrap.append(ul);
  }
  if (packet.needsUser?.length) {
    wrap.append(el('h3', { text: 'Questions left for you' }));
    const ul = el('ul', { class: 'plan' });
    for (const field of packet.needsUser) ul.append(el('li', { class: 'st-blocked', text: `${field.label} — needs you` }));
    wrap.append(ul);
  }
  if (packet.blockers?.length) {
    wrap.append(el('h3', { text: 'Blockers' }));
    const ul = el('ul', { class: 'plan' });
    for (const blocker of packet.blockers) ul.append(el('li', { class: 'st-blocked', text: blocker }));
    wrap.append(ul);
  }
  return wrap;
}

export function resumeChangeLabel(change = {}) {
  const labels = {
    reorder_skills: 'Reordered existing skills so this role’s requirements appear first.',
    reorder_summary: 'Prioritized existing summary content for this role.',
    reorder_experience_bullets: 'Prioritized existing bullets within the same role.',
    emphasize: 'Emphasized terms the posting asks for that your resume already supports.',
    focus_line: 'Added an evidence-backed role-focus line.',
    flatten_tables_for_ats: 'Converted layout tables to single-column text for safer ATS parsing.',
    stabilize_page_breaks: 'Kept section headings with their first content line.',
    normalize_layout: 'Cleaned up layout artifacts (manual page breaks, merged role blocks, blank filler).',
    fit_to_page_budget: 'Omitted the least relevant bullets from the oldest roles to hold the page limit.',
  };
  const label = labels[change.type] || change.reason
    || String(change.type ?? 'Recorded an update').replace(/_/g, ' ');
  // These two describe WHAT they did in `after`, and that detail is the point.
  return ['normalize_layout', 'fit_to_page_budget'].includes(change.type) && change.after
    ? `${label} (${change.after})`
    : label;
}

/* ─────────────────────── resume preview ─────────────────────── */

export async function openResumePreview(id) {
  const job = state.known.get(id) ?? state.detailJob;
  const dialog = $('dlgResume');
  $('dlgResumeSub').textContent = job ? `${job.company ?? ''} — ${job.title ?? ''}` : '';
  $('resumeFrameHost').textContent = '';
  const links = $('dlgResumeLinks');
  links.textContent = '';
  const status = $('resumePreviewStatus');
  status.className = 'preview-status';
  status.textContent = 'Preparing the PDF preview…';
  openDialog(dialog);

  try {
    const ready = await postJson(`/api/jobs/${encodeURIComponent(id)}/resume-preview`);
    const frame = el('iframe', {
      title: 'Tailored resume preview', loading: 'lazy',
      src: `${ready.url}&v=${Date.now()}`,
    });
    $('resumeFrameHost').append(frame);
    status.textContent = ready.generated ? 'Preview generated from the tailored DOCX.' : '';
    links.append(el('a', {
      class: 'btn small', href: ready.url, target: '_blank', rel: 'noopener', text: 'Full size ↗',
    }), el('a', {
      class: 'btn small', href: `/api/jobs/${encodeURIComponent(id)}/resume?format=docx`, text: '⬇ DOCX',
    }));
  } catch (err) {
    status.className = 'preview-status bad';
    status.textContent = err.message;
    links.append(el('a', {
      class: 'btn small', href: `/api/jobs/${encodeURIComponent(id)}/resume?format=docx`, text: '⬇ Download DOCX instead',
    }));
  }
}
