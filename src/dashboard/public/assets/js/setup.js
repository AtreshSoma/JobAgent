/**
 * The setup card (S1): what is left before applying, in one line.
 *
 * It replaced a red notice that listed every stored copy of every template
 * value, one per line, each with the same instruction and a CLI command: 19
 * lines on a fresh profile, filling the first screen, so the job list (the
 * thing that does work while setup is unfinished) was below the fold.
 *
 * The server sends `notice.setup` from src/config/setupProgress.js: groups of
 * items, each done or not, each with the screen that fixes it. This module
 * only draws it. Whether applying is held is still the server's placeholder
 * check; nothing here can release it.
 */
import { $, el, fmt } from './dom.js';
import { readPreference, savePreference } from './main.js';

const OPEN_KEY = 'setup-card-open';

/** Whether the steps are shown. Closed unless the person opened them last time. */
export const setupCardOpen = () => readPreference(OPEN_KEY) === '1';

/** The first item still to do, in the card's order. */
export function nextSetupItem(setup) {
  for (const group of setup?.groups ?? []) {
    const item = group.items.find((i) => !i.done);
    if (item) return { group, item };
  }
  return null;
}

/** The control that fixes one item: its editor, scrolled to the field, or its one-click action. */
function fixButton(item, { label = 'Fix', primary = false } = {}) {
  const cls = `small${primary ? ' primary' : ''}`;
  if (item.fix?.action) {
    return el('button', { type: 'button', class: cls, 'data-action': item.fix.action, text: item.fix.label ?? label });
  }
  return el('button', {
    type: 'button', class: cls, 'data-action': 'setup-fix',
    'data-editor': item.fix?.editor ?? 'details', 'data-field': item.fix?.field ?? '',
    'aria-label': label === 'Fix' ? `Fix ${item.label}` : null, text: label,
  });
}

function itemRow(item) {
  const row = el('li', { class: `sp-item ${item.done ? 'is-done' : 'is-todo'}` },
    el('span', { class: 'sp-check', 'aria-hidden': 'true' }),
    el('span', { class: 'sp-item-text' },
      el('span', { class: 'sp-item-label', text: item.label }),
      el('span', { class: 'sr-only', text: item.done ? ': done' : ': still to do' }),
      !item.done && item.values?.length
        ? el('span', { class: 'sp-item-was muted', text: `still the example text “${item.values[0]}”` })
        : null,
      !item.done && item.personOnly
        ? el('span', { class: 'sp-item-was muted', text: 'Only you can answer this; it is never taken from your resume.' })
        : null));
  if (!item.done) row.append(fixButton(item));
  return row;
}

function groupBlock(group, openKey) {
  const left = group.total - group.done;
  const details = el('details', { class: 'sp-group', 'data-group': group.key });
  if (group.key === openKey) details.open = true;
  details.append(el('summary', {},
    el('span', { class: 'sp-group-title', text: group.title }),
    el('span', { class: `sp-group-count${left ? '' : ' is-done'}`, text: `${fmt(group.done)} of ${fmt(group.total)}` })));
  const list = el('ul', { class: 'sp-items' });
  for (const item of group.items) list.append(itemRow(item));
  details.append(list);
  return details;
}

/**
 * The card.
 *
 * @param {{message: string, fix?: string, setup: {total: number, done: number, groups: object[]}}} notice
 * @returns {HTMLElement}
 */
export function setupCard(notice) {
  const setup = notice.setup ?? { total: 0, done: 0, groups: [] };
  const open = setupCardOpen();
  const next = nextSetupItem(setup);
  const pct = setup.total ? Math.round((setup.done / setup.total) * 100) : 0;

  const card = el('section', { class: 'setup-progress', id: 'setupCard', 'aria-labelledby': 'setupCardTitle', 'data-open': open ? 'true' : 'false' });
  const line = el('div', { class: 'sp-line' },
    el('span', { class: 'sp-mark', 'aria-hidden': 'true', text: 'i' }),
    el('h2', { class: 'sp-title', id: 'setupCardTitle' },
      'Finish setup to apply: ',
      el('b', { text: `${fmt(setup.done)} of ${fmt(setup.total)} done` })),
    el('div', {
      class: 'sp-bar', role: 'progressbar', 'aria-label': 'Setup progress',
      'aria-valuemin': '0', 'aria-valuemax': String(setup.total), 'aria-valuenow': String(setup.done),
      'aria-valuetext': `${setup.done} of ${setup.total} done`,
    }, el('i', { style: `width: ${pct}%` })),
    // Continue takes you to the next thing to fill in. Where that is a
    // one-click fix (Fill from my resume), the steps open on it instead of
    // running it: a click on "Continue" should not change the profile.
    next && !next.item.fix?.action
      ? fixButton(next.item, { label: 'Continue setup', primary: true })
      : el('button', { type: 'button', class: 'small primary', 'data-action': 'setup-toggle', 'data-force': 'open', text: 'Continue setup' }),
    el('button', {
      type: 'button', class: 'small ghost icon sp-toggle', 'data-action': 'setup-toggle',
      'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'setupCardBody',
      'aria-label': open ? 'Hide setup steps' : 'Show setup steps',
    }, el('span', { class: 'sp-chev', 'aria-hidden': 'true' })));
  card.append(line);

  const body = el('div', { class: 'sp-body', id: 'setupCardBody', hidden: !open });
  body.append(el('p', { class: 'sp-why muted', text: notice.fix ?? '' }));
  const groups = el('div', { class: 'sp-groups' });
  for (const group of setup.groups) groups.append(groupBlock(group, next?.group.key));
  body.append(groups);
  card.append(body);
  return card;
}

/** Show or hide the steps, and remember the choice for the next visit. */
export function toggleSetupCard(force = null) {
  const card = $('setupCard');
  if (!card) return;
  const open = force === 'open' ? true : force === 'close' ? false : card.dataset.open !== 'true';
  savePreference(OPEN_KEY, open ? '1' : '0');
  card.dataset.open = String(open);
  $('setupCardBody').hidden = !open;
  const toggle = card.querySelector('.sp-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Hide setup steps' : 'Show setup steps');
}

/** Bring the card into view with its steps open: where a blocked Apply sends you. */
export function revealSetupCard() {
  const card = $('setupCard');
  if (!card) return;
  toggleSetupCard('open');
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  card.querySelector('.sp-group[open] button, .sp-group button, .sp-toggle')?.focus({ preventScroll: true });
}
