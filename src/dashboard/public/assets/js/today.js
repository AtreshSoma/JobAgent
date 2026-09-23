/** The Today action queue, system notices, the Auto-fill gate and the setup checklist. */

import { $, el } from './dom.js';
import { state } from './state.js';
import { api, apiOptional } from './api.js';
import { statusLabel } from './board.js';
import { fitLabel, markCurrentRow, renderDetail, selectJob } from './detail.js';
import { autofillOne, prepareOne, simpleAction } from './mutations.js';
import { syncSelectionBar } from './selection.js';
import { openHealth, openProfile } from './profile.js';
import { openSubmitDialog } from './actions.js';
import { savePreference } from './main.js';

/* ─────────────────────────── Today ───────────────────────────
 * The landing view: at most ten jobs, each with the ONE next action that
 * moves it forward. The board shows everything and asks the user to work out
 * what matters; this answers that question first, and the board stays one
 * click away.
 *
 * Contract: GET /api/today -> { generatedAt, items: [{ id, title, company,
 * location, score, grade, tier, appStatus, statusLabel, reason, nextAction:
 * { kind, label } }], systemNotices: [{ code, severity, message, fix }] }.
 * A server without the route gets the same view derived from
 * /api/sections?only=todaysPriorities, minus failed rows (a failure is not a
 * next step — its cause is, and that surfaces as a notice).
 */

export const VIEWS = ['today', 'board'];

export function setView(view, { save = true } = {}) {
  if (!VIEWS.includes(view)) return;
  const changed = state.view !== view;
  state.view = view;
  $('todayView').hidden = view !== 'today';
  $('boardView').hidden = view !== 'board';
  $('tabs').hidden = view !== 'board';
  for (const button of document.querySelectorAll('[data-action="set-view"][aria-pressed]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  if (save) savePreference('view', view);
  if (changed && view === 'today') loadToday();
}

export let todayInFlight = null;
export let todayTimer = null;

export function scheduleTodayReload(delay = 350) {
  clearTimeout(todayTimer);
  todayTimer = setTimeout(loadToday, delay);
}

export function loadToday() {
  if (todayInFlight) return todayInFlight;
  todayInFlight = (async () => {
    let data = null;
    try { data = await apiOptional('/api/today'); } catch { data = null; }
    if (!data) data = await deriveToday();
    state.today = data;
    for (const item of data.items ?? []) {
      state.known.set(item.id, { ...(state.known.get(item.id) ?? {}), ...item });
    }
    setSystemNotices(data.systemNotices ?? []);
    renderToday();
  })().finally(() => { todayInFlight = null; });
  return todayInFlight;
}

/** What an older server's todaysPriorities row asks for next. */
export function derivedNextAction(row) {
  switch (row.appStatus) {
    case 'needs_review': return { kind: 'review', label: 'Review resume' };
    case 'approved': return { kind: 'autofill', label: 'Auto-fill' };
    case 'ready_for_submit': return { kind: 'submit', label: 'Record submission' };
    case 'submit_unverified': return { kind: 'submit', label: 'Verify submission' };
    case 'blocked': case 'cancelled': return { kind: 'review', label: 'See what stopped it' };
    case 'shortlisted': return { kind: 'prepare', label: 'Prepare resume' };
    default:
      return row.sponsorshipGated
        ? { kind: 'review', label: 'Check sponsorship' }
        : { kind: 'review', label: 'Review' };
  }
}

export function derivedReason(row) {
  const reasons = {
    needs_review: 'Packet prepared — review the tailored resume before it is used.',
    approved: 'Approved — ready to fill the application.',
    ready_for_submit: 'Filled and waiting for you to press Submit.',
    submit_unverified: 'Submitted automatically, but no confirmation page was seen.',
    blocked: 'Stopped at a step only you can do.',
    cancelled: 'You stopped the fill; it resumes from where it was.',
    shortlisted: 'Shortlisted — needs a tailored resume.',
  };
  if (reasons[row.appStatus]) return reasons[row.appStatus];
  const bits = [row.grade?.label ?? fitLabel(row.fit)];
  if (row.sponsorshipGated) bits.push('sponsorship unconfirmed — verify before applying');
  if (row.postedLast24h) bits.push('posted in the last 24h');
  return bits.filter(Boolean).join(' · ');
}

export const BROWSER_NOTICE = {
  code: 'browser_unavailable',
  severity: 'error',
  message: 'Auto-fill can’t start: the Playwright browser isn’t installed.',
  fix: 'Run `npx playwright install chromium` in the JobAgent folder, then retry.',
};
export const BROWSER_MISSING = /Executable doesn't exist|playwright install/i;

export async function deriveToday() {
  const [sections, failed] = await Promise.all([
    api('/api/sections?only=todaysPriorities').catch(() => null),
    // The one failure worth a notice is a missing browser: every auto-fill
    // fails the same way until it is installed, and the rows say so.
    api('/api/jobs?appStatus=failed&hideClosed=false&limit=50&fields=board').catch(() => null),
  ]);
  const items = (sections?.todaysPriorities ?? [])
    .filter((row) => row.appStatus !== 'failed')
    .slice(0, 10)
    .map((row) => ({ ...row, reason: derivedReason(row), nextAction: derivedNextAction(row) }));
  const browserDown = (failed?.jobs ?? []).some((job) => BROWSER_MISSING.test(job.statusReason ?? ''));
  return { generatedAt: new Date().toISOString(), derived: true, items, systemNotices: browserDown ? [BROWSER_NOTICE] : [] };
}

/* ── system notices ── */

export function setSystemNotices(list) {
  const notices = [...list];
  // The doctor's browser check is a second witness to the same problem.
  const browserCheck = state.health?.checks?.find((c) => c.id === 'browser');
  if (browserCheck?.status === 'fail' && !notices.some((n) => n.code === 'browser_unavailable')) {
    notices.push(BROWSER_NOTICE);
  }
  state.systemNotices = notices;
  const unavailable = notices.some((n) => n.code === 'browser_unavailable');
  const changed = unavailable !== state.browserUnavailable;
  state.browserUnavailable = unavailable;
  renderNotices();
  renderSetupChecklist();
  if (changed) {
    // Every Auto-fill control reads this flag; redraw the ones on screen.
    syncSelectionBar();
    if (state.detailJob) renderDetail(state.detailJob);
    renderToday();
  }
}

/** Render a `fix` string, setting `code` spans as code with a Copy button. */
export function fixLine(fix) {
  const line = el('div', { class: 'notice-fix' });
  const parts = String(fix ?? '').split(/`([^`]+)`/);
  parts.forEach((part, i) => { if (part) line.append(i % 2 ? el('code', { text: part }) : part); });
  let command = parts[1];
  // The server may send the fix as a bare command ("npx playwright install
  // chromium") rather than prose with `code` in it: set the whole thing as code.
  if (!command && /^(npx|npm|node|python3?|pip3?|brew)\s/.test(String(fix ?? '').trim())) {
    command = String(fix).trim();
    line.textContent = '';
    line.append('Run ', el('code', { text: command }));
  }
  if (command) {
    line.append(' ', el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'copy-text', 'data-text': command,
      'aria-label': `Copy the command ${command}`, text: 'Copy',
    }));
  }
  return line;
}

export function renderNotices() {
  const host = $('systemNotices');
  host.textContent = '';
  for (const notice of state.systemNotices ?? []) {
    host.append(el('div', { class: `notice ${notice.severity === 'error' ? 'is-error' : 'is-warn'}`, role: 'status' },
      el('span', { class: 'notice-mark', 'aria-hidden': 'true', text: '!' }),
      el('div', { class: 'notice-body' },
        el('b', { text: notice.message }),
        notice.fix ? fixLine(notice.fix) : null),
      NOTICE_ACTION[notice.code] ? el('button', {
        type: 'button', class: 'small', 'data-action': NOTICE_ACTION[notice.code][0], text: NOTICE_ACTION[notice.code][1],
      }) : null));
  }
}

/** Notice code -> the dialog that resolves it. */
export const NOTICE_ACTION = { profile_placeholders: ['open-profile', 'Open application profile'] };

/** Why an Auto-fill control is unavailable, or null when it can be used. */
export function autofillBlockedReason() {
  return state.browserUnavailable
    ? 'Auto-fill can’t start until the Playwright browser is installed — see the notice at the top of the page.'
    : null;
}

/* ── cards ── */

export function renderToday() {
  const list = $('todayList');
  if (!list) return;
  const items = state.today?.items ?? [];
  list.textContent = '';
  const count = $('todayCount');
  count.hidden = items.length === 0;
  count.textContent = String(items.length);
  $('todaySub').textContent = items.length
    ? `${items.length} job${items.length === 1 ? '' : 's'} worth your time right now, most important first.`
    : 'Nothing is waiting on you.';

  if (!items.length) {
    list.append(el('li', { class: 'today-empty' },
      el('div', { class: 'big', text: state.today ? 'Nothing needs you right now' : 'Loading…' }),
      state.today ? el('p', { class: 'muted' },
        'New strong matches, packets to review and applications waiting on you land here. '
        + 'Run discovery to look for new postings — or, if runs keep finding nothing, widen what your search profile asks for.') : null,
      state.today ? el('div', { class: 'row-gap empty-actions' },
        el('button', { type: 'button', class: 'small primary', 'data-action': 'run', 'data-phase': 'discover', text: 'Find new jobs' }),
        el('button', { type: 'button', class: 'small', 'data-action': 'open-master', text: 'Widen my search…' }),
        el('button', { type: 'button', class: 'small ghost', 'data-action': 'set-view', 'data-view': 'board', text: 'Open the full board' })) : null));
    return;
  }

  for (const item of items) list.append(todayCard(item));
  markCurrentRow(state.selectedId);
}

export function todayCard(item) {
  const grade = item.grade;
  const card = el('li', { class: `tcard${item.id === state.selectedId ? ' current' : ''}`, 'data-id': item.id });
  card.append(el('span', {
    class: `grade ${grade ? grade.letter : 'none'}`,
    role: 'img',
    'aria-label': grade ? `grade ${grade.letter}, ${grade.label}` : 'not scored yet',
    text: grade ? grade.letter : '—',
  }));

  const main = el('div', { class: 'tcard-main' });
  // The title opens the job in the rail; the one primary button does the work.
  main.append(el('button', {
    type: 'button', class: 'tcard-title', 'data-action': 'today-review', 'data-id': item.id,
    title: 'Open this job’s details',
    text: item.title || 'Title not identified',
  }));
  const meta = el('div', { class: 'tcard-meta' });
  meta.append(el('span', { class: 'co', text: item.company || 'Company on posting' }));
  if (item.location) meta.append(el('span', { class: 'faint', text: ` · ${item.location}` }));
  main.append(meta);
  const chips = el('div', { class: 'tcard-chips' });
  // The server's own label, never re-derived: see verdictLabel.
  chips.append(el('span', {
    class: `chip ${item.fit ?? ''}`.trim(),
    text: [grade?.label ?? fitLabel(item.fit), item.score != null ? String(item.score) : null].filter(Boolean).join(' · '),
  }));
  if (item.statusLabel || item.appStatus) {
    chips.append(el('span', { class: `chip st-${item.appStatus}`, text: item.statusLabel ?? statusLabel(item) }));
  }
  main.append(chips);
  if (item.reason) main.append(el('p', { class: 'tcard-reason', text: item.reason }));
  card.append(main);

  const next = item.nextAction ?? derivedNextAction(item);
  const attrs = {
    type: 'button', class: 'small primary tcard-go', 'data-action': 'today-act',
    'data-id': item.id, 'data-kind': next.kind, text: next.label,
  };
  const blocked = next.kind === 'autofill' ? autofillBlockedReason() : null;
  if (blocked) Object.assign(attrs, { disabled: true, title: blocked });
  card.append(el('div', { class: 'tcard-act' }, el('button', attrs)));
  return card;
}

/** Run a Today card's next action. */
export async function todayAct(target) {
  const id = target.dataset.id;
  switch (target.dataset.kind) {
    case 'prepare': await prepareOne(id); break;
    case 'approve': await simpleAction(id, 'approve', 'Packet approved'); break;
    case 'autofill': await autofillOne(id); break;
    case 'answer': await openProfile(); break;
    case 'submit': openSubmitDialog(id); break;
    case 'fix_setup': await openHealth(); break;
    default: await selectJob(id, { user: true });
  }
  scheduleTodayReload(600);
}

/* ─────────────────────── setup checklist ───────────────────────
 * /api/health runs the doctor on demand. Its failing checks were visible only
 * inside System health, so a fresh install with placeholder profile values
 * and no browser looked "fine" until the first Auto-fill failed. Fetched once
 * when the page is idle, and shown as a short checklist on Today, each item
 * linked to the dialog that fixes it.
 */

/** Notice code -> the doctor check that reports the same problem. */
export const NOTICE_CHECK = { browser_unavailable: 'browser', profile_placeholders: 'profile-placeholders' };

/** Check id -> the control that fixes it. */
export const SETUP_FIX = {
  browser: { kind: 'copy' },
  profile: { action: 'open-profile', label: 'Open application profile' },
  'profile-placeholders': { action: 'open-profile', label: 'Open application profile' },
  'profile-active': { action: 'open-master', label: 'Open master resume' },
  resume: { action: 'open-master', label: 'Open master resume' },
};

export async function loadHealthChecks() {
  try { state.health = await api('/api/health'); } catch { return; }
  setSystemNotices(state.today?.systemNotices ?? []);
}

export function renderSetupChecklist() {
  const host = $('setupChecklist');
  if (!host) return;
  host.textContent = '';
  // A check already raised as a system notice is not listed twice.
  const noticed = new Set((state.systemNotices ?? []).map((n) => NOTICE_CHECK[n.code]).filter(Boolean));
  const failing = (state.health?.checks ?? []).filter((c) => c.status === 'fail' && !noticed.has(c.id));
  if (!failing.length) return;
  const card = el('section', { class: 'setup-card', 'aria-labelledby': 'setupTitle' });
  card.append(el('h3', { id: 'setupTitle', text: `Setup checklist — ${failing.length} to fix` }));
  const list = el('ul', { class: 'setup-list' });
  for (const check of failing) {
    const fix = SETUP_FIX[check.id] ?? { action: 'open-health', label: 'See details' };
    const item = el('li', {},
      el('span', { class: 'setup-mark', 'aria-hidden': 'true' }),
      el('div', { class: 'setup-text' },
        el('b', { text: check.label ?? check.id }),
        check.detail ? el('div', { class: 'faint clamp-2', title: check.detail, text: check.detail }) : null,
        fix.kind === 'copy' && check.fix ? fixLine(check.fix) : null));
    if (fix.action) {
      item.append(el('button', { type: 'button', class: 'small', 'data-action': fix.action, text: fix.label }));
    }
    list.append(item);
  }
  card.append(list);
  host.append(card);
}
