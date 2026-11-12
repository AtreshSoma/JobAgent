/**
 * The Product Overview: the headline and the route, the five stations, what
 * the product never does, the register of what is built, and the close.
 */
import { h, icon } from './dom.js';
import { statusBadge, topicLink } from './ui.js';
import { buildRoute, buildStations } from './journey.js';
import { BOUNDARIES, CAPABILITIES, CAPABILITY_AREAS, STATUS } from './content-overview.js';

function hero(route) {
  return h('section', { class: 'ex-hero', 'aria-labelledby': 'heroTitle' },
    h('div', { class: 'ex-hero-top' },
      h('h1', { id: 'heroTitle', class: 'ex-display ex-hero-title' },
        // Each line rises out of its own mask on load; the outer span is the mask.
        h('span', { class: 'ex-line' }, h('span', { text: 'All the work.' })), ' ',
        // The full stop is drawn as the route's signal lamp: the call is the
        // moment the line is held for you. The real "." stays for assistive tech.
        h('span', { class: 'ex-line ex-display-stop' }, h('span', {}, 'Your call',
          h('span', { class: 'sr-only', text: '.' }), h('span', { class: 'ex-lamp', 'aria-hidden': 'true' })))),
      h('div', { class: 'ex-hero-side' },
        h('p', { class: 'ex-lede', text: 'JobAgent finds jobs, explains every score, tailors your resume without inventing a word and fills in the form, all on your own computer. You approve. You press Submit.' }),
        h('div', { class: 'ex-actions' },
          h('a', { class: 'ex-btn ex-btn-solid', href: '#/overview/discover' }, 'Follow the line', icon('arrow', { size: 16 })),
          h('a', { class: 'ex-btn', href: '#/how' }, 'How it works')))),
    h('div', { class: 'ex-platform' }, route.root));
}

function boundaries() {
  return h('section', { class: 'ex-never', id: 'boundaries', 'aria-labelledby': 'neverTitle', dataset: { reveal: '' } },
    h('h2', { id: 'neverTitle', class: 'ex-station-name ex-never-word', tabindex: '-1', text: 'Never' }),
    h('div', { class: 'ex-never-side' },
      h('p', { class: 'ex-never-lede', text: 'What JobAgent will not do. Each line is a rule in the code with a test behind it, not a setting you could switch off by accident.' }),
      topicLink('security', 'How these are enforced')),
    h('ul', { class: 'ex-never-list' }, BOUNDARIES.never.map((text) => {
      const [first, ...rest] = text.split('. ');
      return h('li', {}, h('span', { class: 'ex-never-rule', text: rest.length ? `${first}.` : first }),
        rest.length ? h('span', { class: 'ex-never-more', text: rest.join('. ') }) : null);
    })),
    h('div', { class: 'ex-does' },
      h('h3', { class: 'ex-h3', text: 'What it does on its own' }),
      h('ul', { class: 'ex-does-list' }, BOUNDARIES.does.map((text) => h('li', {}, icon('check', { size: 16 }), h('span', { text }))))));
}

/** The register: every capability, grouped by area, with how finished it is. */
function ledger() {
  let filter = 'all';
  const counts = Object.fromEntries(Object.keys(STATUS).map((key) => [key, CAPABILITIES.filter((c) => c.status === key).length]));
  const buttons = [['all', 'Everything', CAPABILITIES.length], ...Object.entries(STATUS).map(([key, meta]) => [key, meta.label, counts[key]])]
    .map(([id, text, n]) => h('button', {
      type: 'button', class: 'ex-chip', 'aria-pressed': String(id === 'all'), dataset: { status: id },
      onClick: () => { filter = id; paint(); },
    }, text, h('span', { class: 'ex-count', text: String(n) })));
  const note = h('p', { class: 'ex-ledger-note', role: 'status' });
  const groups = CAPABILITY_AREAS.map((area, index) => {
    const rows = CAPABILITIES.filter((c) => c.area === area);
    const tally = h('span', { class: 'ex-ledger-tally' });
    const list = h('ul', { class: 'ex-ledger-rows' });
    // The first area starts open so the page shows what a row looks like.
    const el = h('details', { class: 'ex-ledger-group', open: index === 0 },
      h('summary', {}, h('span', { class: 'ex-ledger-area', text: area }), tally),
      list);
    return { area, rows, tally, list, el };
  });

  let painted = false;
  let settle = 0;
  function paint() {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.status === filter));
    // A filter change brings its rows in with a short rise; the first paint does not.
    section.classList.toggle('is-filtering', painted);
    clearTimeout(settle);
    if (painted) settle = setTimeout(() => section.classList.remove('is-filtering'), 900);
    painted = true;
    note.textContent = filter === 'all' ? 'Four states, used the same way everywhere on this page.' : `${STATUS[filter].label}: ${STATUS[filter].note}`;
    for (const group of groups) {
      const shown = group.rows.filter((c) => filter === 'all' || c.status === filter);
      group.el.hidden = shown.length === 0;
      // A filter is a question about rows, so matching groups open to answer it.
      if (filter !== 'all') group.el.open = true;
      group.tally.textContent = `${shown.length} ${shown.length === 1 ? 'capability' : 'capabilities'}`;
      group.list.replaceChildren(...shown.map((row, k) => h('li', { class: 'ex-ledger-row', style: `--k:${k}` },
        h('span', { class: 'ex-ledger-name', text: row.name }),
        h('span', { class: 'ex-ledger-what', text: row.what }),
        statusBadge(row.status),
        h('a', { class: 'ex-ledger-link', href: `#/how/${row.topic}`, 'aria-label': `How ${row.name} works` }, icon('arrow', { size: 14 })))));
    }
  }

  const section = h('section', { class: 'ex-ledger', id: 'ledger', 'aria-labelledby': 'ledgerTitle', dataset: { reveal: '' } },
    h('div', { class: 'ex-ledger-head' },
      h('h2', { id: 'ledgerTitle', class: 'ex-h2', tabindex: '-1', text: 'What is built, and what is not yet' }),
      h('p', { class: 'ex-section-lede', text: 'A plain account of every capability and how finished it is. Optional features are complete and switched off. Planned ones do not exist yet.' }),
      h('div', { class: 'ex-chips', role: 'group', 'aria-label': 'Filter by status' }, buttons),
      note),
    h('div', { class: 'ex-ledger-body' }, groups.map((g) => g.el)));
  paint();
  return section;
}

function closing() {
  return h('section', { class: 'ex-close', 'aria-labelledby': 'closeTitle', dataset: { reveal: '' } },
    h('h2', { id: 'closeTitle', class: 'ex-display ex-display-close', text: 'It is already running on this computer.' }),
    h('p', { class: 'ex-lede', text: 'This page came from the same local server that runs your job search. Nothing on it was fetched from the internet.' }),
    h('div', { class: 'ex-actions' },
      h('a', { class: 'ex-btn ex-btn-solid', href: '/' }, 'Open dashboard', icon('arrow', { size: 16 })),
      h('a', { class: 'ex-btn', href: '#/how' }, 'How it works')));
}

/** Build the whole Overview into `root`. Returns the route so the caller can start it. */
export function renderOverview(root) {
  const route = buildRoute();
  root.replaceChildren(
    hero(route),
    h('div', { class: 'ex-journey', id: 'journey' }, buildStations()),
    boundaries(),
    ledger(),
    closing());
  return route;
}
