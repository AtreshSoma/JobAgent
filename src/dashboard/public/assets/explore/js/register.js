/**
 * The capability register: what is built, and how finished it is, as something
 * to explore rather than a table to read.
 *
 * Three questions, in the order a reader has them:
 *
 *   How much is finished?   Four counts over one bar. Each count is a filter.
 *   Which part?             Six areas, drawn as stops on a line.
 *   What about this one?    A short list of names. Choosing one opens three
 *                           lines: what it does, why it matters, how it works,
 *                           with its status said in words.
 *
 * Only one capability is spelled out at a time, so the page never becomes a
 * wall of rows. Each row is a disclosure button; its details sit inside the
 * row for assistive technology and for phones, and are set beside the list in
 * a wide window (scenes.css).
 */
import { countTo, h, icon } from './dom.js';
import { statusBadge } from './ui.js';
import { AREA_NAMES, CAPABILITIES, CAPABILITY_AREAS, STATUS } from './content-overview.js';

export function register() {
  let status = 'all';
  let area = CAPABILITY_AREAS[0];
  let chosen = null;

  const total = (id) => CAPABILITIES.filter((c) => c.status === id).length;
  const visible = (c) => status === 'all' || c.status === status;
  const rowsOf = (a) => CAPABILITIES.filter((c) => c.area === a && visible(c));

  /* How much is finished: one bar, four counts. Pressing a count filters; pressing it again clears. */
  const stats = Object.entries(STATUS).map(([id, meta]) => {
    const n = h('span', { class: 'ex-reg-n', text: String(total(id)) });
    const el = h('button', {
      type: 'button', class: 'ex-reg-stat', 'aria-pressed': 'false', dataset: { status: id },
      onClick: () => { status = status === id ? 'all' : id; settle(); paint({ moved: true }); },
    }, n, h('span', { class: 'ex-reg-stat-name', text: meta.label }), h('span', { class: 'ex-reg-stat-note', text: meta.short }));
    return { id, el, n };
  });
  const bar = h('div', { class: 'ex-reg-bar', 'aria-hidden': 'true' }, Object.keys(STATUS).map((id) => h('i', { dataset: { status: id }, style: `flex-grow:${total(id)}` })));

  /* Which part: the six areas, as stops on a line. */
  const areas = CAPABILITY_AREAS.map((id) => {
    const count = h('span', { class: 'ex-count' });
    const el = h('button', {
      type: 'button', class: 'ex-reg-area', 'aria-pressed': 'false', dataset: { area: id },
      onClick: () => { area = id; chosen = null; settle(); paint({ moved: true }); },
    }, h('span', { class: 'ex-reg-area-dot', 'aria-hidden': 'true' }), h('span', { class: 'ex-reg-area-name', text: AREA_NAMES[id] }), count);
    return { id, el, count };
  });

  const note = h('p', { class: 'ex-reg-note', role: 'status' });
  const list = h('ul', { class: 'ex-reg-list' });

  /** Keep the choice valid: an area with rows, and a capability inside it. */
  function settle() {
    if (!rowsOf(area).length) area = CAPABILITY_AREAS.find((a) => rowsOf(a).length) ?? area;
    const rows = rowsOf(area);
    if (!rows.includes(chosen)) chosen = rows[0] ?? null;
  }

  function details(c, id) {
    return h('div', { class: 'ex-reg-detail', id },
      h('p', { class: 'ex-reg-detail-status' }, statusBadge(c.status), h('span', { text: STATUS[c.status].note })),
      h('h3', { class: 'ex-reg-detail-name', text: c.name }),
      h('dl', { class: 'ex-reg-facts' },
        h('div', {}, h('dt', { text: 'What it does' }), h('dd', { text: c.what })),
        h('div', {}, h('dt', { text: 'Why it matters' }), h('dd', { text: c.why })),
        h('div', {}, h('dt', { text: 'How it works' }), h('dd', { text: c.how }))),
      h('a', { class: 'ex-more', href: `#/how/${c.topic}` }, 'See it under the hood', icon('arrow', { size: 14 })));
  }

  function choose(c, { focus = false } = {}) {
    if (c === chosen) return;
    chosen = c;
    paint({ focus });
  }

  function paint({ moved = false, focus = false } = {}) {
    for (const s of stats) s.el.setAttribute('aria-pressed', String(s.id === status));
    for (const a of areas) {
      const n = rowsOf(a.id).length;
      a.el.setAttribute('aria-pressed', String(a.id === area));
      a.el.disabled = n === 0;
      a.count.textContent = String(n);
    }
    const rows = rowsOf(area);
    note.textContent = status === 'all'
      ? `${AREA_NAMES[area]}: ${rows.length} of ${CAPABILITIES.length} capabilities.`
      : `${STATUS[status].label}: ${STATUS[status].note} ${rows.length} in ${AREA_NAMES[area]}.`;
    // A change of area or filter brings its rows in with a short rise; choosing a row does not.
    section.classList.toggle('is-swapping', moved);
    list.replaceChildren(...rows.map((c, k) => {
      const open = c === chosen;
      const id = `reg-detail-${CAPABILITIES.indexOf(c)}`;
      const row = h('button', {
        type: 'button', class: 'ex-reg-row', 'aria-expanded': String(open), 'aria-controls': open ? id : null,
        onClick: () => choose(c, { focus: true }),
        // A mouse only has to pass over a name to read about it; the keyboard and touch press.
        onPointerenter: (event) => { if (event.pointerType === 'mouse' && matchMedia('(min-width: 1000px)').matches) choose(c); },
        onKeydown: (event) => {
          const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          choose(rows[(k + step + rows.length) % rows.length], { focus: true });
        },
      },
      h('span', { class: `ex-reg-mark ex-reg-mark-${c.status}`, 'aria-hidden': 'true' }),
      h('span', { class: 'ex-reg-row-name', text: c.name }),
      c.fresh ? h('span', { class: 'ex-reg-new', text: 'New' }) : null,
      h('span', { class: 'sr-only', text: `, ${STATUS[c.status].label}` }));
      return h('li', { class: `ex-reg-item${open ? ' is-open' : ''}`, style: `--k:${k}` }, row, open ? details(c, id) : null);
    }));
    if (focus) list.querySelector('.ex-reg-row[aria-expanded="true"]')?.focus({ preventScroll: true });
  }

  const section = h('section', { class: 'ex-chapter ex-reg', id: 'ledger', 'aria-labelledby': 'ledgerTitle', dataset: { reveal: '' } },
    h('div', { class: 'ex-reg-head' },
      h('div', { class: 'ex-reg-title' },
        h('h2', { id: 'ledgerTitle', class: 'ex-big', tabindex: '-1', text: 'What is built, and what is not yet' }),
        h('p', { class: 'ex-section-lede', text: `${CAPABILITIES.length} capabilities, each marked with how finished it is. Optional ones are complete and switched off. Planned ones do not exist yet.` })),
      h('div', { class: 'ex-reg-tally' }, bar, h('div', { class: 'ex-reg-stats', role: 'group', 'aria-label': 'Filter by how finished it is' }, stats.map((s) => s.el)))),
    h('div', { class: 'ex-reg-body' },
      h('div', { class: 'ex-reg-areas', role: 'group', 'aria-label': 'Area' }, areas.map((a) => a.el)),
      h('div', { class: 'ex-reg-pane' }, note, list)),
    h('p', { class: 'ex-reg-foot' }, h('span', { class: 'ex-reg-new', text: 'New' }), 'arrived in version 0.2.3 or later.'));

  // The counts settle once, when the register is first reached.
  section.addEventListener('ex:reveal', () => { for (const s of stats) countTo(s.n, total(s.id), { duration: 900 }); }, { once: true });

  settle();
  paint();
  return section;
}
