/**
 * JobAgent dashboard front end.
 *
 * Design notes that matter for correctness:
 *
 *  - NO inline event handlers. Every interaction is routed through one
 *    delegated listener keyed on `data-action`, and every job id travels in a
 *    `data-id` attribute. The previous build interpolated ids into
 *    `onclick="select('…')"` strings, so an id containing an apostrophe (ids are
 *    derived from third-party feed data) broke the row or executed as script.
 *    Values are now never parsed as code, and the page needs no
 *    `script-src 'unsafe-inline'`.
 *
 *  - The board is PAGINATED against the server. It previously rendered whatever
 *    the API's default 200-row cap returned while the tab badges counted every
 *    match, so ~1,400 jobs were unreachable and the numbers disagreed.
 *
 *  - Mutations update the affected row in place and schedule ONE coalesced
 *    background refresh, instead of re-fetching stats + sections + board after
 *    every click (~1s of work each on a large database).
 */

/* ───────────────────────────── state ───────────────────────────── */

const $ = (id) => document.getElementById(id);

const state = {
  activeTab: 'all',
  page: 1,
  pageSize: 100,
  sort: 'score',
  selectedId: null,
  /** @type {Set<string>} */
  selected: new Set(),
  /** id -> row, for every row seen this session (batch actions need off-page rows) */
  known: new Map(),
  /** ids rendered on the current page, in order (keyboard nav + select-all) */
  visible: [],
  stats: null,
  running: false,
  serverUp: null,
  detailJob: null,
  /** Last /api/run/status payload, so the details panel needs no extra fetch. */
  lastRunStatus: null,
  /** finishedAt of a result the user dismissed; a newer run reappears. */
  runDismissedAt: null,
};

const FILTER_IDS = [
  'q', 'fit', 'appStatus', 'postedWithinHours', 'state', 'city',
  'sponsorship', 'employmentType', 'source', 'ats', 'resumeStatus',
];
/**
 * Checkbox filters. Every one is OFF by default, including `includeClosed`:
 * "Hide closed ✓" was a checked-by-default double negative that read as an
 * active filter you had to UNcheck, and its pill said the opposite of its label.
 */
const TOGGLE_IDS = ['remoteOnly', 'sponsorshipGated', 'undated', 'includeClosed'];

/* ── one accessor per filter kind ─────────────────────────────────────────
 * Filters are read, written, cleared, counted, and chipped through these three
 * helpers alone. Each control kind (text box, select, checkbox, segmented
 * switch) is handled in exactly one place, so adding or restyling a filter
 * cannot leave one of the five behaviours behind — which is how the posting-age
 * control could previously be set but never appear as a chip.
 */
function filterValue(id) {
  const node = $(id);
  return node.type === 'checkbox' ? (node.checked ? 'true' : '') : node.value.trim();
}

function setFilterValue(id, value) {
  const node = $(id);
  if (node.type === 'checkbox') node.checked = Boolean(value) && value !== 'false';
  else node.value = value == null ? '' : String(value);
  if (id === 'postedWithinHours') syncSegments();
}

function clearFilter(id) {
  setFilterValue(id, id === 'postedWithinHours' ? '' : '');
}

/** Reflect the hidden posting-age value on its segmented buttons. */
function syncSegments() {
  const current = $('postedWithinHours').value;
  for (const button of document.querySelectorAll('[data-action="set-posted"]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === current && current !== ''));
  }
}

/** Which sort direction each board sort actually applies, for aria-sort. */
const SORT_DIRECTION = {
  score: 'descending', posted: 'descending', company: 'ascending', updated: 'descending',
};

const TABS = [
  ['all', 'All jobs', false],
  ['today', 'Today', true],
  ['best', 'Best matches', false],
  ['shortlisted', 'Shortlisted', false],
  ['needs_review', 'Needs review', true],
  ['ready_apply', 'Ready to apply', true],
  ['blocked', 'Needs you', true],
  ['submitted', 'Submitted', false],
];

/* ─────────────────────────── utilities ─────────────────────────── */

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Build an element with attributes + children, avoiding innerHTML for data. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('data-') || k.startsWith('aria-')) node.setAttribute(k, v);
    else if (k === 'for') node.htmlFor = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function relTime(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const shortStamp = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ');

function toast(message, tone = '') {
  const host = $('toasts');
  const node = el('div', { class: `toast ${tone}`.trim(), role: 'status', text: message });
  host.append(node);
  // Each toast owns its own timer, so a later toast can never be cut short by
  // an earlier one's timeout (the old single-element toast did exactly that).
  setTimeout(() => node.remove(), tone === 'bad' ? 6000 : 3600);
}

/* ─────────────────────────── API layer ─────────────────────────── */

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    setServerStatus(false);
    throw new Error('Cannot reach the dashboard server — it may have stopped. '
      + 'Restart it with "npm run dashboard", then reload this page.');
  }
  setServerStatus(true);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The server serves index.html and app.js from disk on every request, so a
    // browser reload picks up new front-end code while the RUNNING process
    // still has the old routes. That mismatch surfaced as a bare
    // "no route: GET /api/…", which reads like a bug rather than a stale
    // process. Say what it actually is.
    if (res.status === 404 && /^no route:/i.test(body.error ?? '')) {
      throw new Error('This feature is newer than the dashboard process that is running. '
        + 'Stop it and run "npm run dashboard" again, then reload this page.');
    }
    throw new Error(body.error || res.statusText);
  }
  return body;
}

const postJson = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function setServerStatus(up) {
  if (up === state.serverUp) return;
  state.serverUp = up;
  const conn = $('conn');
  // The dot is a CSS pseudo-element now, so the text must not carry one too.
  conn.textContent = up ? 'connected' : 'disconnected';
  conn.className = `conn ${up ? 'ok' : 'down'}`;
  $('offline').dataset.open = String(!up);
}

/* ─────────────────────── filters + query ─────────────────────── */

function filterParams({ forCount = false } = {}) {
  const p = new URLSearchParams();
  if (state.activeTab && state.activeTab !== 'all') p.set('view', state.activeTab);
  for (const id of FILTER_IDS) {
    const value = filterValue(id);
    if (value) p.set(id, value);
  }
  if ($('remoteOnly').checked) p.set('remote', 'true');
  if ($('sponsorshipGated').checked) p.set('sponsorshipGated', 'true');
  if ($('undated').checked) p.set('undated', 'true');
  // The API speaks hideClosed; the UI asks the question the positive way round.
  p.set('hideClosed', String(!$('includeClosed').checked));
  p.set('sort', state.sort);
  if (!forCount) {
    p.set('limit', String(state.pageSize));
    p.set('page', String(state.page));
  }
  return p;
}

/** Labels for the checkbox filters, used by both the chips and the badge. */
const TOGGLE_LABELS = {
  remoteOnly: 'Remote only',
  sponsorshipGated: 'Needs sponsor check',
  undated: 'Posting date unknown',
  includeClosed: 'Including closed jobs',
};

/**
 * Field names for the chips of the selects inside "More filters". Their option
 * text is deliberately terse ("Likely", "Contract"), which reads as a mystery
 * chip once the panel is closed, so the chip names the field too. The primary
 * selects need no prefix — "Strong fit" and "Posted < 3h ago" say it already.
 */
const FIELD_LABELS = {
  sponsorship: 'Sponsorship', employmentType: 'Job type', source: 'Source',
  ats: 'ATS', resumeStatus: 'Resume', state: 'Location',
};

/**
 * Render a posting-age window the way the button that set it is labelled.
 * Without this a week reads as "168h", which no one thinks in.
 */
function humanizeHours(value) {
  const h = Number(value);
  if (!Number.isFinite(h)) return `${value}`;
  if (h % 168 === 0) return h === 168 ? '1 week' : `${h / 168} weeks`;
  if (h % 24 === 0) return h === 24 ? '24 hours' : `${h / 24} days`;
  return `${h} hours`;
}

/** Chip text for filters that are not <select>s (no option label to borrow). */
const VALUE_LABELS = {
  postedWithinHours: (value) => `Posted < ${humanizeHours(value)} ago`,
  city: (value) => `City: ${value}`,
};

/** Human-readable chips for every active filter, each individually clearable. */
function renderActiveFilters() {
  const host = $('activeFilters');
  host.textContent = '';
  const chips = [];
  const labelFor = (id) => {
    const node = $(id);
    const option = node.selectedOptions?.[0];
    return option ? option.textContent.trim() : node.value;
  };
  for (const id of FILTER_IDS) {
    const value = filterValue(id);
    if ($(id).tagName === 'SELECT') $(id).classList.toggle('on', Boolean(value));
    if (!value) continue;
    if (id === 'q') chips.push([id, `“${value}”`]);
    else if (VALUE_LABELS[id]) chips.push([id, VALUE_LABELS[id](value)]);
    else chips.push([id, FIELD_LABELS[id] ? `${FIELD_LABELS[id]}: ${labelFor(id)}` : labelFor(id)]);
  }
  for (const [id, label] of Object.entries(TOGGLE_LABELS)) {
    if ($(id).checked) chips.push([id, label]);
  }

  for (const [id, label] of chips) {
    host.append(el('span', { class: 'pill' }, label,
      el('button', { 'data-action': 'clear-filter', 'data-filter': id, 'aria-label': `Clear filter ${label}`, text: '✕' })));
  }
  if (chips.length > 1) {
    host.append(el('button', { class: 'small ghost', 'data-action': 'reset-filters', text: 'Clear all' }));
  }
}

function resetFilters({ keepTab = false } = {}) {
  if (!keepTab) state.activeTab = 'all';
  for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);
  state.sort = 'score';
  savePreference('sort', state.sort);
  syncSortIndicator();
  state.page = 1;
  renderTabs();
  refreshAll();
}

/** Apply a metric/next-action filter object. Honors EVERY key it is given. */
function applyFilterObject(filter = {}) {
  state.activeTab = 'all';
  for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);

  // A filter naming a closed status must reveal closed rows, or it shows zero.
  const CLOSED = ['rejected', 'archived', 'discarded'];
  for (const [key, value] of Object.entries(filter)) {
    if (value === null || value === undefined) continue;
    if (key === 'view') {
      // A curated tab IS the filter (its badge counts the same predicate), so
      // next actions whose count spans several statuses can point at one.
      state.activeTab = String(value);
      continue;
    }
    if (key === 'appStatus') {
      const select = $('appStatus');
      // Guard against a status the select does not offer: silently falling back
      // to "" used to show the WHOLE board instead of the requested subset.
      if ([...select.options].some((o) => o.value === value)) select.value = value;
      else toast(`No filter exists for status "${value}"`, 'bad');
      if (CLOSED.includes(value)) setFilterValue('includeClosed', true);
    } else if (key === 'last24h') setFilterValue('postedWithinHours', value ? '24' : '');
    else if (key === 'postedWithinHours') setFilterValue('postedWithinHours', value);
    else if (key === 'remote') setFilterValue('remoteOnly', value);
    else if (key === 'sponsorshipGated') setFilterValue('sponsorshipGated', value);
    else if (key === 'undated') {
      setFilterValue('undated', value);
      // Undated rows are exactly where the freshness gate parked them, so they
      // are only reachable with closed jobs in scope — but only when the filter
      // is actually being switched ON.
      if (value) setFilterValue('includeClosed', true);
    } else if (key === 'includeClosed' || key === 'hideClosed') {
      setFilterValue('includeClosed', key === 'hideClosed' ? !value : value);
    } else if (FILTER_IDS.includes(key)) setFilterValue(key, value);
  }
  state.page = 1;
  renderTabs();
  refreshAll();
}

/* ───────────────────────── pipeline health ─────────────────────────
 * Only facts that are NOT already a tab. "Awaiting approval", "ready to
 * submit" and "submitted" were dropped from here because Needs review, Ready
 * to apply and Submitted are literally the same numbers one row away — showing
 * them twice, in two visual languages, is what made the top of the page busy.
 */

/** Always shown: how big the corpus is and how fresh it is. */
const HEALTH_FACTS = [
  { key: 'jobsTracked', label: 'tracked', filter: { includeClosed: true }, title: 'Every job ever seen, including closed ones' },
  { key: 'discoveredLast24h', label: 'found 24h', tone: 'hot', title: 'Jobs discovered in the last 24 hours' },
  { key: 'postedLast24h', label: 'posted 24h', tone: 'hot', filter: { postedWithinHours: '24' }, title: 'Jobs whose POSTING is less than 24 hours old' },
  // The 24h count is often single digits while a week holds hundreds. Without
  // this chip the bar implies there is nothing to apply to.
  { key: 'postedLast7d', label: 'posted 1w', tone: 'hot', filter: { postedWithinHours: '168' }, title: 'Jobs whose POSTING is less than 1 week old' },
  { key: 'strongFit', label: 'strong fit', tone: 'hot', filter: { fit: 'strong' }, title: 'Open jobs scored as a strong match' },
];

/** Shown only when non-zero, and only where no tab already carries it. */
const HEALTH_FLAGS = [
  { key: 'submitUnverified', label: 'unverified submits', tone: 'bad', filter: { appStatus: 'submit_unverified' }, title: 'Auto-submits with no confirmation — only you can resolve these' },
  { key: 'needsSponsorshipCheck', label: 'verify sponsor', tone: 'attn', filter: { sponsorshipGated: true }, title: 'Strong fits parked until you confirm the employer sponsors' },
  { key: 'undatedDropped', label: 'undated', tone: 'attn', filter: { undated: true }, title: 'The source gave no confirmed posting date — held back, or still live but worth a quick check' },
];

/**
 * Render one stat tile, distinguishing "computed and genuinely zero" from
 * "not present in this response at all".
 *
 * REGRESSION GUARD. `stats.totals[key] ?? 0` treats both the same way,
 * rendering a missing key as a confident "0" — indistinguishable from a real
 * zero. This is exactly how a long-running dashboard server process (started
 * before a new stat field was added to the backend, since Node does not
 * hot-reload edited source) can show an impossible state: "4 posted 24h, 0
 * posted 1w" is a contradiction (24h is a subset of 1w) that can only happen
 * if the "0" is not a real computed value but a fallback for a key the
 * server's in-memory code never set. An honest "—" makes that gap visible
 * instead of masquerading as data.
 */
function statNode({ key, label, tone, filter, title }, stats) {
  const raw = stats.totals[key];
  const known = typeof raw === 'number' && Number.isFinite(raw);
  const value = known ? raw : 0;
  const attrs = {
    class: `stat ${known && value > 0 ? tone ?? '' : ''} ${filter ? 'clickable' : ''}`.trim().replace(/\s+/g, ' '),
    title: known ? (title ?? '') : `${title ?? label} — not reported by the server (it may need a restart to pick up a recent update)`,
  };
  if (filter) {
    attrs['data-action'] = 'metric-filter';
    attrs['data-filter'] = JSON.stringify(filter);
    attrs.role = 'button';
    attrs.tabindex = '0';
  }
  return el('span', attrs, el('b', { text: known ? fmt(value) : '—' }), el('span', { class: 'l', text: label }));
}

function renderHealth(stats) {
  const host = $('health');
  host.textContent = '';
  for (const fact of HEALTH_FACTS) host.append(statNode(fact, stats));

  // Nationwide coverage, stated as data rather than assumed. The searches ask
  // for "United States"; this is how many states actually came back.
  const coverage = stats.coverage;
  if (coverage?.statesPossible) {
    host.append(el('span', {
      class: 'stat',
      title: `Open jobs span ${coverage.statesCovered} of ${coverage.statesPossible} US states and territories`
        + `, plus ${fmt(coverage.nationwide)} nationwide/remote and ${fmt(coverage.unstated)} with no stated location.`,
    }, el('b', { text: `${coverage.statesCovered}/${coverage.statesPossible}` }),
    el('span', { class: 'l', text: 'US states' })));
  }

  const last = relTime(stats.lastDiscoveryAt);
  host.append(el('span', { class: 'stat', title: 'When discovery last found anything' },
    el('b', { text: last ?? 'never' }), el('span', { class: 'l', text: 'last run' })));

  for (const flag of HEALTH_FLAGS) {
    // An empty warning is noise; only real attention items get a pill.
    if ((stats.totals[flag.key] ?? 0) === 0) continue;
    host.append(statNode(flag, stats));
  }
}

function renderTabs() {
  const views = state.stats?.views ?? {};
  const host = $('tabs');
  host.textContent = '';
  for (const [key, label, urgent] of TABS) {
    const count = views[key] ?? 0;
    const selected = state.activeTab === key;
    host.append(el('button', {
      class: `tab${urgent && count > 0 ? ' urgent' : ''}`,
      role: 'tab',
      'aria-selected': String(selected),
      'data-action': 'set-tab',
      'data-tab': key,
    }, label, el('span', { class: 'badge', text: fmt(count) })));
  }
}

function renderAnalytics(stats) {
  const srcEntries = Object.entries(stats.bySource).sort((a, b) => b[1].found - a[1].found);
  const srcMax = Math.max(0, ...srcEntries.map(([, v]) => v.found));
  const srcRows = $('srcRows');
  srcRows.textContent = '';
  if (!srcEntries.length) {
    srcRows.append(el('tr', {}, el('td', { colspan: '5', class: 'muted', text: 'No jobs yet — run “Find new jobs”.' })));
  }
  for (const [src, v] of srcEntries) {
    srcRows.append(el('tr', {},
      el('td', {}, el('button', {
        class: 'small ghost', 'data-action': 'metric-filter',
        'data-filter': JSON.stringify({ source: src }), text: src,
      })),
      el('td', { class: 'r' }, fmt(v.found), ' ', bar(v.found, srcMax)),
      el('td', { class: 'r', text: fmt(v.strong) }),
      el('td', { class: 'r', text: fmt(v.prepared) }),
      el('td', { class: 'r', text: fmt(v.submitted) })));
  }

  // Nationwide coverage, made inspectable: which states the board actually
  // holds jobs from. An empty or lopsided list here is a real coverage gap, not
  // a display quirk.
  const stateRows = $('stateRows');
  stateRows.textContent = '';
  const stateEntries = Object.entries(stats.byState ?? {})
    .sort((a, b) => b[1].count - a[1].count);
  const stateMax = Math.max(0, ...stateEntries.map(([, v]) => v.count));
  if (!stateEntries.length) {
    stateRows.append(el('tr', {}, el('td', { colspan: '3', class: 'muted', text: 'No jobs yet.' })));
  }
  for (const [code, v] of stateEntries.slice(0, 60)) {
    const label = code === 'US' || code === 'unknown' ? v.name : `${v.name} (${code})`;
    stateRows.append(el('tr', {},
      el('td', { title: label, text: label }),
      el('td', { class: 'r' }, fmt(v.count), ' ', bar(v.count, stateMax)),
      el('td', { class: 'r', text: fmt(v.strong) })));
  }
  const coverage = stats.coverage;
  if (coverage?.statesPossible) {
    stateRows.append(el('tr', {}, el('td', {
      colspan: '3',
      class: 'faint',
      text: `${coverage.statesCovered} of ${coverage.statesPossible} US states and territories represented.`,
    })));
  }

  const sponRows = $('sponRows');
  sponRows.textContent = '';
  for (const [k, v] of Object.entries(stats.bySponsorship ?? {}).sort((a, b) => b[1].count - a[1].count)) {
    sponRows.append(el('tr', {},
      el('td', {}, el('span', { class: `chip ${esc(k)}`, text: k })),
      el('td', { class: 'r', text: fmt(v.count) }),
      el('td', { class: 'r', text: fmt(v.strong) })));
  }

  const dayMax = Math.max(0, ...(stats.daily ?? []).map((d) => d.discovered));
  const dailyRows = $('dailyRows');
  dailyRows.textContent = '';
  for (const d of stats.daily ?? []) {
    dailyRows.append(el('tr', {},
      el('td', { class: 'muted', text: d.day.slice(5) }),
      el('td', { class: 'r' }, fmt(d.discovered), ' ', bar(d.discovered, dayMax)),
      el('td', { class: 'r', text: fmt(d.prepared) }),
      el('td', { class: 'r', text: fmt(d.submitted) })));
  }

  const actions = $('nextActions');
  actions.textContent = '';
  actions.append(el('h2', { text: 'Next actions' }));
  const list = stats.nextActions ?? [];
  if (!list.length) {
    actions.append(el('div', { class: 'muted', text: 'All caught up — nothing waiting on you.' }));
  } else {
    const ul = el('ul', { class: 'plan' });
    for (const action of list) {
      const li = el('li');
      if (action.filter) {
        li.append(el('button', {
          class: 'small ghost', 'data-action': 'metric-filter',
          'data-filter': JSON.stringify(action.filter), text: action.text,
        }));
      } else li.textContent = action.text;
      ul.append(li);
    }
    actions.append(ul);
  }
}

function bar(value, max) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const wrap = el('span', { class: 'mini', title: fmt(value) });
  const fill = el('i');
  fill.style.width = `${pct}%`;
  wrap.append(fill);
  return wrap;
}

async function loadStats() {
  const stats = await api('/api/stats');
  state.stats = stats;
  renderHealth(stats);
  renderTabs();
  renderAnalytics(stats);
  const select = $('source');
  const current = select.value;
  select.textContent = '';
  // Matches the "Any" wording of every other select in the panel.
  select.append(el('option', { value: '', text: 'Any source' }));
  for (const src of Object.keys(stats.bySource)) {
    select.append(el('option', { value: src, text: src, selected: src === current }));
  }
  populateStates(stats);
}

/**
 * Fill the state dropdown from the states that ACTUALLY have jobs, with each
 * one's count, so the list can never offer a state that returns nothing.
 *
 * `byState` is keyed by two-letter code, plus 'US' for national/remote-only
 * postings that name no state and 'unknown' for locations we could not read.
 * Neither of those is a state, so neither becomes a state option — 'US' is
 * already served by the dedicated Remote entry, and offering "unknown" as a
 * location choice would be meaningless.
 */
function populateStates(stats) {
  const select = $('state');
  const current = select.value;
  const entries = Object.entries(stats.byState ?? {})
    .filter(([code]) => code !== 'US' && code !== 'unknown')
    .sort((a, b) => (a[1].name ?? a[0]).localeCompare(b[1].name ?? b[0]));

  select.textContent = '';
  select.append(el('option', { value: '', text: 'Any location' }));
  select.append(el('option', { value: 'REMOTE', text: 'Remote', selected: current === 'REMOTE' }));
  for (const [code, info] of entries) {
    select.append(el('option', {
      value: code,
      text: `${info.name ?? code} (${fmt(info.count)})`,
      selected: code === current,
    }));
  }
}

async function loadSections() {
  const sections = await api('/api/sections').catch(() => null);
  if (!sections) return;
  const host = $('blockRows');
  host.textContent = '';
  const rows = sections.blockedByReason ?? [];
  if (!rows.length) {
    host.append(el('tr', {}, el('td', { colspan: '2', class: 'muted', text: 'Nothing blocked' })));
    return;
  }
  for (const entry of rows) {
    host.append(el('tr', {},
      el('td', { title: entry.reason, text: entry.reason }),
      el('td', { class: 'r', text: fmt(entry.count) })));
  }
}

/* ──────────────────────────── board ──────────────────────────── */

let boardSeq = 0;

async function loadBoard() {
  const seq = ++boardSeq;
  const body = $('rows');
  if (!body.children.length) {
    body.append(el('tr', {}, el('td', { colspan: '10' },
      el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }))));
  }

  let page;
  try {
    page = await api(`/api/jobs?${filterParams()}`);
  } catch (err) {
    if (seq !== boardSeq) return;
    body.textContent = '';
    body.append(el('tr', {}, el('td', { colspan: '10', class: 'empty', text: err.message })));
    $('pager').textContent = '';
    return;
  }
  if (seq !== boardSeq) return; // a newer request already won

  // The server may clamp the page (e.g. filters narrowed while on page 7).
  if (page.page && page.page !== state.page) state.page = page.page;

  state.visible = page.jobs.map((j) => j.id);
  for (const job of page.jobs) state.known.set(job.id, job);

  renderRows(page.jobs);
  renderPager(page);
  syncSelectAll();
  renderActiveFilters();
}

function renderRows(jobs) {
  const body = $('rows');
  body.textContent = '';

  if (!jobs.length) {
    const tracked = state.stats?.totals?.jobsTracked ?? 0;
    const cell = el('td', { colspan: '10' });
    const box = el('div', { class: 'empty' });
    box.append(el('div', { class: 'big', text: tracked === 0 ? 'No jobs yet' : 'Nothing matches these filters' }));
    if (tracked === 0) {
      box.append('Run ', el('b', { text: 'Find new jobs' }), ' to discover and score postings.');
    } else {
      box.append(el('button', { class: 'small', 'data-action': 'reset-filters', text: 'Reset filters' }));
    }
    cell.append(box);
    body.append(el('tr', {}, cell));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const job of jobs) frag.append(rowFor(job));
  body.append(frag);
}

function rowFor(job) {
  const selected = job.id === state.selectedId;
  const tr = el('tr', {
    class: 'job',
    'data-id': job.id,
    'data-action': 'select',
    'aria-selected': String(selected),
    tabindex: '0',
    role: 'row',
  });

  // checkbox
  const check = el('input', {
    type: 'checkbox', 'data-action': 'toggle-select', 'data-id': job.id,
    'aria-label': `Select ${job.company ?? ''} ${job.title ?? ''}`.trim(),
  });
  check.checked = state.selected.has(job.id);
  tr.append(el('td', { class: 'check' }, check));

  // grade + score
  const grade = job.grade;
  tr.append(el('td', {},
    el('span', {
      class: `grade ${grade ? grade.letter : 'none'}`,
      title: grade ? `${grade.label} · score ${job.score}` : 'Not scored yet',
      text: grade ? grade.letter : '—',
    }),
    el('div', { class: 'faint', text: job.score ?? '—' })));

  tr.append(nameCellFor(job));

  // sponsorship — the badge carries its own evidence, so a claim as consequential
  // as "Confirmed" can be checked on hover instead of taken on trust.
  tr.append(el('td', {}, el('span', {
    class: `chip ${esc(job.sponsorship ?? '')}`,
    title: sponsorshipTitle(job),
    text: job.sponsorship ?? '—',
  })));

  // employment type
  tr.append(el('td', {}, typeChip(job)));

  // posted
  const postedCell = el('td', { class: 'nowrap' },
    el('span', { class: `dot ${job.postedConfidence}`, title: `Posting date ${job.postedConfidence}` }),
    job.postedLabel);
  if (job.postedLast24h) postedCell.append(' ', el('span', { class: 'chip good', text: 'new' }));
  tr.append(postedCell);

  // resume — one click straight to the tailored document
  const resumeCell = el('td', { class: 'nowrap' });
  resumeCell.append(el('span', {
    class: `rs ${job.resumeStatus}`,
    text: job.resumeStatus === 'tailored' ? 'tailored' : job.resumeStatus === 'prepared' ? 'packet' : '—',
  }));
  if (job.resumeDocxPath || job.resumePdfPath) {
    resumeCell.append(' ', el('button', {
      class: 'small ghost', 'data-action': 'preview-resume', 'data-id': job.id,
      title: 'Preview the tailored resume',
      'aria-label': `Preview tailored resume for ${job.company ?? ''} ${job.title ?? ''}`.trim(),
      text: '👁',
    }));
  }
  tr.append(resumeCell);

  tr.append(el('td', { class: 'muted', text: job.atsPlatform ?? '—' }));
  tr.append(el('td', {}, progressBar(job.progress)));

  // WHY a job is blocked/discarded/skipped was carried only by a `title=`
  // tooltip plus a bare ⓘ glyph — invisible on touch, unreliable for screen
  // readers, and the single most useful thing in the column. It is now real
  // text, clamped to one line so the row height stays stable.
  const statusCell = el('td', { class: `st-${job.appStatus}` });
  statusCell.append(statusLabel(job));
  if (job.statusReason) {
    statusCell.append(el('div', {
      class: 'statusreason', title: job.statusReason, text: job.statusReason,
    }));
  }
  tr.append(statusCell);

  return tr;
}

/** Longest title rendered in full before eliding. */
const TITLE_MAX_CHARS = 72;

/**
 * The Company / role cell.
 *
 * Three deliberate decisions:
 *
 *  1. The ROLE is the link and the primary line. Reaching a posting previously
 *     took two clicks and a context switch (select the row, then "Open posting"
 *     in the detail rail) even though every row already carries its URL —
 *     measured: 0 of 2,219 open rows lacked one. The role also leads visually,
 *     because you scan this board by role; it used to be the quietest text in
 *     the cell (`.muted`) under a bold company name.
 *
 *  2. Aggregator listings are MARKED. Measured on real data, 1,061 of 2,219
 *     open rows (48%) point at LinkedIn/Indeed/Dice rather than an employer's
 *     own form, and the app already warns about exactly that in the detail rail
 *     ("not a reliable application form"). Linking every title without a marker
 *     would silently bypass that warning on half the board, so the source is
 *     named inline — you can see what you are about to open.
 *
 *  3. Long titles are elided. Real titles reach 150 characters (3.5% exceed 72),
 *     and the cell has no width constraint, so those stretched the column and
 *     forced the whole table to scroll sideways. The full text stays available
 *     as the link's tooltip and in the detail rail.
 */
function nameCellFor(job) {
  const cell = el('td', { class: 'namecell' });
  const title = String(job.title ?? '').trim() || 'Title not identified';
  const shown = title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : title;

  if (job.url) {
    const aggregator = isAggregatorUrl(job.url);
    const link = el('a', {
      class: 'rolelink',
      href: job.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      // `data-action` keeps this inside the one delegated-dispatch convention the
      // rest of the UI uses; the dispatcher lets real links navigate.
      'data-action': 'open-posting',
      title: aggregator
        ? `${title}\n\nOpens ${hostLabel(job.url)} — an aggregator listing, not the employer's own application form.`
        : title,
      'aria-label': `${title} at ${job.company || 'company on posting'} — opens the posting in a new tab`,
      text: shown,
    });
    cell.append(link);
    if (aggregator) {
      cell.append(' ', el('span', {
        class: 'chip agg',
        title: 'Aggregator listing — follow Apply through to the employer site, then save that direct URL here.',
        text: hostLabel(job.url),
      }));
    }
  } else {
    // No URL means nothing to open — say so rather than render a dead link.
    cell.append(el('span', { class: 'rolelink none', title, text: shown }));
  }

  const meta = el('div', { class: 'namemeta' });
  meta.append(el('span', { class: 'co', text: job.company || 'Company on posting' }));
  if (job.remote) meta.append(' ', el('span', { class: 'rs', text: 'remote' }));
  if (job.location) meta.append(el('span', { class: 'faint', text: ` · ${job.location}` }));
  cell.append(meta);
  return cell;
}

/**
 * Brands whose own capitalisation is not just "first letter upper" — naive
 * title-casing renders these as "Linkedin"/"Ziprecruiter", which reads as a bug.
 */
const HOST_BRANDS = {
  linkedin: 'LinkedIn',
  ziprecruiter: 'ZipRecruiter',
  simplyhired: 'SimplyHired',
};

/** Short, human host label for a posting URL ("LinkedIn", "Indeed"). */
function hostLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    const name = host.split('.')[0].toLowerCase();
    return HOST_BRANDS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
  } catch { return 'link'; }
}

function typeChip(job) {
  const cat = job.employmentCategory ?? 'unknown';
  if (cat === 'unknown') return el('span', { class: 'chip', title: 'Employment type unknown', text: '—' });
  const label = job.employmentLabel ?? cat;
  const contract = ['contract', 'contract_to_hire', 'part_time'].includes(cat);
  return el('span', {
    class: `chip ${contract ? 'bad' : 'good'}`,
    title: `Employment type: ${label}`,
    text: label,
  });
}

/**
 * Hover text for the sponsorship badge: the prose the verdict was read from.
 *
 * A sponsorship verdict decides whether a job is worth applying to at all, and
 * it used to be shown as a bare word with nothing behind it. That is how six
 * Humana rows displayed a green "Confirmed" while their JDs said "This role is
 * not eligible for work visa sponsorship" — the badge asserted a conclusion no
 * one could check. Rows scored before the signals column existed simply have no
 * evidence to show, so they say so rather than implying the badge is verified.
 */
function sponsorshipTitle(job) {
  const parts = [];
  const signals = job.sponsorshipSignals ?? [];
  if (signals.length) parts.push(`Read from the posting: "${signals.join('"; "')}"`);
  else if (job.sponsorship) parts.push('No recorded evidence — re-score this job to capture it.');
  if (job.sponsorshipGated) {
    parts.push('Strong fit parked by the sponsorship gate — verify the employer sponsors.');
  }
  if (job.sponsorship === 'Denied') {
    parts.push('The posting explicitly refuses sponsorship.');
  }
  return parts.join('\n');
}

function progressBar(progress) {
  if (!progress) return '';
  const wrap = el('div', {
    class: `bar${progress.offRamp ? ' off' : ''}`,
    title: progress.offRamp ? progress.stage : `${progress.stage} (${progress.percent}%)`,
  });
  const fill = el('i');
  fill.style.width = progress.offRamp ? '100%' : `${progress.percent}%`;
  wrap.append(fill);
  return wrap;
}

const STATUS_LABELS = {
  ready_for_submit: 'Ready for your review',
  needs_review: 'Review resume',
  approved: 'Ready to auto-fill',
  submitted: 'Submitted',
  submit_unverified: 'Verify submission',
  date_unconfirmed: 'Date unconfirmed',
};

function statusLabel(job) {
  return job.attention?.label || STATUS_LABELS[job.appStatus] || job.appStatus.replace(/_/g, ' ');
}

function renderPager(page) {
  const host = $('pager');
  host.textContent = '';
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);

  const count = el('span', { class: 'count' });
  count.append('Showing ', el('b', { text: `${fmt(from)}–${fmt(to)}` }), ' of ', el('b', { text: fmt(page.total) }));
  if (page.total > page.limit) count.append(` · page ${page.page} of ${page.pages}`);
  host.append(count);

  if (page.pages > 1) {
    host.append(
      el('button', { class: 'small', 'data-action': 'page', 'data-page': '1', disabled: page.page <= 1, text: '« First' }),
      el('button', { class: 'small', 'data-action': 'page', 'data-page': String(page.page - 1), disabled: page.page <= 1, text: '‹ Prev' }),
      el('button', { class: 'small', 'data-action': 'page', 'data-page': String(page.page + 1), disabled: page.page >= page.pages, text: 'Next ›' }),
      el('button', { class: 'small', 'data-action': 'page', 'data-page': String(page.pages), disabled: page.page >= page.pages, text: 'Last »' }),
    );
  }
  if (state.selected.size) {
    host.append(el('span', { class: 'muted', text: `${state.selected.size} selected across pages` }));
  }
}

/* ──────────────────────── detail rail ──────────────────────── */

async function selectJob(id, { focusRow = false } = {}) {
  state.selectedId = id;
  for (const tr of $('rows').querySelectorAll('tr.job')) {
    tr.setAttribute('aria-selected', String(tr.dataset.id === id));
  }
  if (focusRow) {
    $('rows').querySelector(`tr.job[data-id="${cssEscape(id)}"]`)?.focus();
  }
  history.replaceState(null, '', `#job=${encodeURIComponent(id)}`);

  const host = $('detail');
  let job;
  try {
    job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    host.textContent = '';
    host.append(el('div', { class: 'panel empty', text: err.message }));
    return;
  }
  if (state.selectedId !== id) return; // user moved on
  state.detailJob = job;
  state.known.set(job.id, { ...(state.known.get(job.id) ?? {}), ...job });
  renderDetail(job);
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function renderDetail(job) {
  const host = $('detail');
  host.textContent = '';
  const panel = el('div', { class: 'panel' });

  // header
  const head = el('div', { class: 'detail-head' });
  head.append(el('span', {
    class: `grade big ${job.grade ? job.grade.letter : 'none'}`,
    text: job.grade ? job.grade.letter : '—',
  }));
  const headMain = el('div', { class: 'grow-1' });
  headMain.append(el('h2', { text: `${job.company || 'Company on posting'} — ${job.title}` }));
  const meta = [job.location, job.remote ? 'remote' : null, job.postedLabel, `via ${job.source}`,
    job.atsPlatform ? `ATS ${job.atsPlatform}` : null].filter(Boolean).join(' · ');
  headMain.append(el('div', { class: 'muted', text: meta }));

  const chips = el('div', { class: 'chiprow' });
  if (job.score != null) {
    chips.append(el('span', { class: 'chip info', title: 'Skills-match score', text: `score ${job.score}/100` }));
  }
  chips.append(el('span', { class: `chip ${job.fit}`, text: fitLabel(job.fit) }));
  chips.append(el('span', {
    class: `chip ${esc(job.sponsorship ?? '')}`,
    title: sponsorshipTitle(job),
    text: `sponsorship: ${job.sponsorship ?? 'unknown'}`,
  }));
  if (job.employmentLabel) chips.append(el('span', { class: 'chip', text: job.employmentLabel }));
  chips.append(el('span', { class: `chip st-${job.appStatus}`, text: statusLabel(job) }));
  if (job.atsScore != null) {
    chips.append(el('span', { class: 'chip', title: 'Resume/JD keyword match from the ATS report', text: `ATS ${job.atsScore}%` }));
  }
  headMain.append(chips);
  head.append(headMain);
  panel.append(head);

  panel.append(stepper(job.progress));

  // attention
  if (job.statusReason && ['blocked', 'failed', 'cancelled', 'rejected', 'discarded', 'skipped',
    'date_unconfirmed', 'submit_unverified'].includes(job.appStatus)) {
    panel.append(el('h3', { text: 'Needs attention' }));
    const box = el('div', { class: 'attention' });
    box.append(el('span', { class: 'mark', text: '!' }));
    const detail = el('div', {});
    detail.append(el('b', { text: statusLabel(job) }), el('br'),
      job.attention?.summary || job.statusReason);
    if (job.attention?.summary && job.statusReason !== job.attention.summary) {
      const more = el('details', {});
      more.append(el('summary', { class: 'muted', text: 'Technical detail' }),
        el('div', { class: 'muted', text: job.statusReason }));
      detail.append(more);
    }
    box.append(detail);
    panel.append(box);
  }

  // next best action
  panel.append(el('h3', { text: 'Do this next' }));
  panel.append(nextBestAction(job));

  // resume card — the feature the workflow revolves around
  panel.append(resumeCard(job));

  // quick actions
  const actions = el('div', { class: 'actions' });
  // A row with no stored URL used to render a dead <a> with no href that looked
  // clickable and did nothing. Say what is missing instead.
  if (job.url) {
    actions.append(el('a', { class: 'btn', href: job.url, target: '_blank', rel: 'noopener', text: 'Open posting ↗' }));
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
  if (['ready_for_submit', 'blocked', 'approved', 'submit_unverified'].includes(job.appStatus)) {
    actions.append(el('button', { class: 'small', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: 'Mark submitted' }));
  }
  panel.append(actions);
  panel.append(el('div', { class: 'linkhealth', id: 'linkHealth', 'aria-live': 'polite' }));

  // submission record
  if (job.appStatus === 'submitted') {
    panel.append(el('h3', { text: 'Submission record' }));
    const box = el('div', { class: 'why' });
    box.append(`Submitted by you on ${shortStamp(job.appliedAt)}`);
    if (job.submittedConfirmation) {
      box.append(el('br'), 'Confirmation: ', el('b', { text: job.submittedConfirmation }));
    }
    panel.append(box);
  }

  // fit explanation
  panel.append(el('h3', { text: `Why this ${job.fit === 'strong' ? 'is' : job.fit === 'no_fit' ? 'is not' : 'may be'} a fit` }));
  panel.append(el('div', { class: 'why', text: job.explanation ?? job.discardReason ?? 'Not scored yet.' }));

  panel.append(el('h3', { text: 'Your skills found in this posting' }));
  panel.append(keywordList(job.matchedKeywords, 'good'));
  panel.append(el('h3', { text: 'Asked for, not evidenced in your resume' }));
  panel.append(keywordList(job.missingKeywords, 'bad'));

  // notes
  panel.append(el('h3', { text: 'Your notes' }));
  const notes = el('div', { class: 'notes' });
  const textarea = el('textarea', {
    id: 'noteBox', rows: '3', placeholder: 'Private reminders — saved with this job and exported to CSV…',
  });
  textarea.value = job.notes ?? '';
  notes.append(textarea, el('div', { class: 'actions' },
    el('button', { class: 'small primary', 'data-action': 'save-note', 'data-id': job.id, text: 'Save note' })));
  panel.append(notes);

  // assist history
  if (job.assistFilledCount != null) {
    panel.append(el('h3', { text: 'Last assisted fill' }));
    const box = el('div', {});
    box.append(`${job.assistFilledCount} field(s) filled`);
    if (job.assistBlockers?.length) {
      const ul = el('ul', { class: 'plan' });
      for (const blocker of job.assistBlockers) ul.append(el('li', { class: 'st-blocked', text: blocker }));
      box.append(ul);
    } else box.append(' · no blockers');
    panel.append(box);
  }

  if (job.packet) panel.append(packetSection(job.packet));

  // job id (for the browser extension)
  panel.append(el('h3', { text: 'Job id' }));
  const idRow = el('div', { class: 'row-gap' });
  idRow.append(el('code', { class: 'jobid', text: job.id }),
    el('button', { class: 'small', 'data-action': 'copy-id', 'data-id': job.id, text: 'Copy' }));
  panel.append(idRow);

  if (job.events?.length) {
    panel.append(el('h3', { text: 'Audit trail' }));
    const ul = el('ul', { class: 'plan' });
    for (const event of job.events) {
      ul.append(el('li', {},
        el('span', { class: 'faint', text: shortStamp(event.at) }), ` ${event.type} — ${event.message ?? ''}`));
    }
    panel.append(ul);
  }

  host.append(panel);
}

function fitLabel(fit) {
  return { strong: 'strong fit', medium: 'medium fit', weak: 'weak fit', no_fit: 'no fit', unscored: 'unscored' }[fit] ?? fit;
}

function keywordList(list = [], tone = '') {
  if (!list.length) return el('div', { class: 'muted', text: 'none' });
  const wrap = el('div', { class: 'kwlist' });
  for (const kw of list) wrap.append(el('span', { class: `chip ${tone}`, text: kw }));
  return wrap;
}

function stepper(progress) {
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
function isAggregatorUrl(url) {
  try {
    return /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|simplyhired|monster|dice)\./i
      .test(new URL(url).hostname);
  } catch { return false; }
}

function nextBestAction(job) {
  const box = el('div', { class: 'nba' });
  const { text, buttons } = actionPlan(job);
  box.append(el('div', { class: 'nba-text', text }));
  const row = el('div', { class: 'nba-actions' });
  for (const button of buttons) row.append(button);
  box.append(row);
  return box;
}

const autofillButton = (id, label = '⚡ Auto-fill application') => el('button', {
  class: 'small primary', 'data-action': 'autofill-one', 'data-id': id,
  title: 'Prepare a packet if needed, approve it, open the posting, fill everything it can — and stop before Submit.',
  text: label,
});

function actionPlan(job) {
  const openPosting = () => el('a', {
    class: 'btn small', href: job.url, target: '_blank', rel: 'noopener', text: 'Open posting ↗',
  });
  const markSubmitted = () => el('button', {
    class: 'small primary', 'data-action': 'open-submit-dialog', 'data-id': job.id, text: 'I submitted it myself',
  });

  if (job.appStatus === 'submitted') {
    return { text: 'Submitted — nothing further to do.', buttons: [] };
  }
  if (job.appStatus === 'submit_unverified') {
    return {
      text: 'Auto-submit clicked Submit but no confirmation was detected. Check the ATS or your email. '
        + 'This is NOT counted as applied until you confirm.',
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
    return {
      text: job.attention?.summary
        || 'The assistant stopped because this step needs you. Complete it in the browser, then retry auto-fill.',
      buttons: [openPosting(), autofillButton(job.id, '↻ Retry auto-fill')],
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
function pageLabel(tailoring) {
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
function resumeCard(job) {
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

function packetSection(packet) {
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

function resumeChangeLabel(change = {}) {
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

async function openResumePreview(id) {
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

/* ─────────────────────────── dialogs ─────────────────────────── */

let lastFocused = null;

function openDialog(dialog) {
  lastFocused = document.activeElement;
  if (!dialog.open) dialog.showModal();
  // <dialog> gives us Escape, backdrop semantics, and a focus trap natively —
  // the previous hand-rolled overlays had none of those.
  // :not([hidden]) matters: focusing a hidden file input is a silent no-op that
  // leaves the caret nowhere.
  dialog.querySelector('input:not([hidden]), textarea, button.primary, button')?.focus();
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

document.addEventListener('close', (event) => {
  if (event.target.tagName === 'DIALOG') lastFocused?.focus?.();
}, true);

// Clicking the backdrop (outside the panel) closes the dialog.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function confirmAction(message, onConfirm) {
  $('confirmBody').textContent = '';
  for (const line of String(message).split('\n')) {
    $('confirmBody').append(el('p', { class: line.startsWith('  ') ? 'muted' : '', text: line.trim() }));
  }
  const dialog = $('dlgConfirm');
  const go = $('confirmGo');
  const clone = go.cloneNode(true);
  go.replaceWith(clone);
  clone.addEventListener('click', () => { dialog.close(); onConfirm(); });
  openDialog(dialog);
}

/* ───────────────────── mutations + refresh ───────────────────── */

let refreshTimer = null;

/** Coalesced background refresh — many actions, one reload. */
function scheduleRefresh(delay = 350) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, delay);
}

async function refreshAll() {
  clearTimeout(refreshTimer);
  await Promise.allSettled([loadStats(), loadBoard()]);
  loadSections();
  // A prepare/re-tailor run replaces the packet and its tailoring audit on
  // disk. Refresh the open detail rail too; otherwise it keeps displaying the
  // packet object fetched before the run and makes regeneration look inert.
  if (state.selectedId) await selectJob(state.selectedId);
}

/** Update one row's derived fields locally so the UI responds immediately. */
function patchRow(id, patch) {
  const known = state.known.get(id);
  if (known) state.known.set(id, { ...known, ...patch });
  const tr = $('rows').querySelector(`tr.job[data-id="${cssEscape(id)}"]`);
  if (tr && known) tr.replaceWith(rowFor({ ...known, ...patch }));
}

async function decide(id, decision) {
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/decision`, { decision });
    toast(decision === 'clear' ? 'Decision cleared' : `Marked ${decision}`, 'good');
    patchRow(id, { appStatus: result.appStatus, userDecision: result.userDecision });
    if (state.selectedId === id) selectJob(id);
    scheduleRefresh();
  } catch (err) { toast(err.message, 'bad'); }
}

async function simpleAction(id, action, okMessage) {
  try {
    await postJson(`/api/jobs/${encodeURIComponent(id)}/${action}`);
    toast(okMessage, 'good');
    if (state.selectedId === id) selectJob(id);
    scheduleRefresh();
  } catch (err) { toast(err.message, 'bad'); }
}

async function runPhase(phase) {
  if (state.running) { toast('A run is already in progress.', 'bad'); return; }
  try {
    await postJson('/api/run', { phase });
    toast(`${phase} started…`);
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

async function autofillOne(id) {
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  const job = state.known.get(id);
  if (job && isAggregatorUrl(job.url)) {
    toast('Use the direct employer/ATS URL for auto-fill. Open the listing and save its Apply URL.', 'bad');
    return;
  }
  try {
    await postJson(`/api/jobs/${encodeURIComponent(id)}/auto-apply`, {});
    toast('Auto-fill started — it stops before Submit.');
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

async function prepareOne(id) {
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  try {
    await postJson('/api/prepare-batch', { jobIds: [id] });
    toast('Preparing the tailored resume + packet…');
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

async function checkLink(id) {
  const box = $('linkHealth');
  if (box) { box.className = 'linkhealth'; box.textContent = 'Checking the saved posting link…'; }
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/check-link`);
    const tone = result.status === 'reachable' ? 'good'
      : ['closed', 'invalid', 'error'].includes(result.status) ? 'bad' : '';
    const text = `${result.message}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`;
    if (box) { box.className = `linkhealth ${tone}`.trim(); box.textContent = text; }
    // Always surface it as a toast too: the inline slot only exists while the
    // detail rail is open, and the old build silently dropped the result.
    toast(text, tone);
  } catch (err) {
    if (box) { box.className = 'linkhealth bad'; box.textContent = err.message; }
    toast(err.message, 'bad');
  }
}

/* ───────────────────────── selection ───────────────────────── */

function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  syncSelectionBar();
  syncSelectAll();
}

function syncSelectAll() {
  const all = state.visible.length > 0 && state.visible.every((id) => state.selected.has(id));
  const some = state.visible.some((id) => state.selected.has(id));
  const box = $('selAll');
  box.checked = all;
  box.indeterminate = !all && some;
}

function syncSelectionBar() {
  const n = state.selected.size;
  $('selCount').textContent = `${n} selected`;
  $('selbar').dataset.open = String(n > 0);
  $('cmpBtn').disabled = n < 2;
  const autofill = $('autoApplyBtn');
  autofill.disabled = n === 0 || state.running;
  autofill.title = state.running
    ? 'A run is in progress — wait for it to finish'
    : 'Prepare if needed, approve, open each posting, and fill it — always stopping before Submit.';
}

function clearSelection() {
  state.selected.clear();
  syncSelectionBar();
  for (const box of $('rows').querySelectorAll('input[type=checkbox]')) box.checked = false;
  syncSelectAll();
}

/**
 * Resolve every selected id to a row. Selections survive page/tab changes, so
 * some may not be loaded — fetch those rather than silently treating them as
 * unknown (the old build reported them as "closed or needs a direct link").
 */
async function selectedJobs() {
  const ids = [...state.selected];
  const missing = ids.filter((id) => !state.known.has(id));
  if (missing.length) {
    const fetched = await Promise.allSettled(
      missing.map((id) => api(`/api/jobs/${encodeURIComponent(id)}`)),
    );
    for (const result of fetched) {
      if (result.status === 'fulfilled' && result.value?.id) state.known.set(result.value.id, result.value);
    }
  }
  return ids.map((id) => state.known.get(id)).filter(Boolean);
}

async function batchAutofill() {
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  const jobs = await selectedJobs();
  if (!jobs.length) return;

  const CLOSED = new Set(['submitted', 'rejected', 'archived', 'discarded']);
  const canFill = (job) => !CLOSED.has(job.appStatus)
    && (job.appStatus !== 'blocked' || job.attention?.retryable === true);
  const actionable = jobs.filter(canFill);
  const skipped = jobs.length - actionable.length;

  if (!actionable.length) {
    toast(`All ${jobs.length} selected job(s) are already closed, submitted, or need a direct link.`, 'bad');
    return;
  }

  let message = `Auto-fill ${actionable.length} application(s)?\n`;
  message += '  For each job: tailor a resume packet if needed, approve it, open the posting, and fill '
    + 'every field it can. It always stops before the final Submit button.';
  if (skipped) message += `\n  ${skipped} selected job(s) will be skipped (closed, submitted, or not retryable).`;

  confirmAction(message, async () => {
    try {
      const result = await postJson('/api/assist-batch', { jobIds: actionable.map((j) => j.id) });
      toast(`Auto-filling ${result.queued} job(s), one browser at a time. Always stops before Submit.`);
      pollRun();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

async function batchPrepare() {
  if (state.running) { toast('A run is in progress — wait for it to finish.', 'bad'); return; }
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    const result = await postJson('/api/prepare-batch', { jobIds: ids });
    toast(`Preparing ${result.queued} packet(s)…`);
    pollRun();
  } catch (err) { toast(err.message, 'bad'); }
}

async function batchApprove() {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    const result = await postJson('/api/approve-batch', { jobIds: ids });
    const failed = result.failed.length;
    toast(`Approved ${result.approved.length}${failed ? `, ${failed} skipped (no packet yet)` : ''}`,
      failed ? '' : 'good');
    scheduleRefresh(0);
  } catch (err) { toast(err.message, 'bad'); }
}

async function batchDecide(decision) {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    const result = await postJson('/api/decide-batch', { jobIds: ids, decision });
    toast(`Marked ${result.updated.length} as ${decision}`, 'good');
    clearSelection();
    scheduleRefresh(0);
  } catch (err) { toast(err.message, 'bad'); }
}

async function showCompare() {
  const jobs = (await selectedJobs()).slice(0, 4);
  if (jobs.length < 2) { toast('Select 2–4 jobs to compare', 'bad'); return; }
  const full = await Promise.all(jobs.map((j) => api(`/api/jobs/${encodeURIComponent(j.id)}`)));

  const body = $('compareBody');
  body.textContent = '';
  const table = el('table', { class: 'minitable' });
  const rows = [
    ['Company', (j) => j.company],
    ['Role', (j) => j.title],
    ['Score', (j) => `${j.score ?? '—'} (${j.fit})`],
    ['Grade', (j) => j.grade?.letter ?? '—'],
    ['Sponsorship', (j) => j.sponsorship ?? '—'],
    ['Posted', (j) => j.postedLabel],
    ['Location', (j) => j.location ?? '—'],
    ['Type', (j) => j.employmentLabel ?? '—'],
    ['Source / ATS', (j) => `${j.source} / ${j.atsPlatform ?? '—'}`],
    ['Status', (j) => statusLabel(j)],
    ['ATS match', (j) => (j.atsScore != null ? `${j.atsScore}%` : '—')],
    ['Matched skills', (j) => (j.matchedKeywords ?? []).slice(0, 10).join(', ') || '—'],
    ['Missing', (j) => (j.missingKeywords ?? []).slice(0, 8).join(', ') || '—'],
  ];
  for (const [label, get] of rows) {
    const tr = el('tr', {}, el('th', { scope: 'row', text: label }));
    for (const job of full) tr.append(el('td', { text: String(get(job) ?? '—') }));
    table.append(tr);
  }
  body.append(table);
  openDialog($('dlgCompare'));
}

/* ─────────────────────── reports + library ─────────────────────── */

function miniTable(headers, rows) {
  if (!rows.length) return el('div', { class: 'muted', text: 'None.' });
  const table = el('table', { class: 'minitable' });
  table.append(el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))));
  const tbody = el('tbody');
  for (const row of rows) {
    tbody.append(el('tr', {}, ...row.map((cell) => (
      cell?.nodeType ? el('td', {}, cell) : el('td', { text: String(cell ?? '—') })
    ))));
  }
  table.append(tbody);
  return table;
}

async function openReports() {
  const body = $('reportsBody');
  body.textContent = '';
  body.append(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  openDialog($('dlgReports'));

  let report;
  try { report = await api('/api/reports'); }
  catch (err) { body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }

  const totals = report.dailySummary.totals;
  body.textContent = '';
  body.append(el('div', { class: 'actions' },
    el('button', { class: 'small', 'data-action': 'export-jobs', text: '⬇ All jobs + scores' }),
    el('button', { class: 'small', 'data-action': 'export-tracker', text: '⬇ Application tracker' })));

  body.append(el('h3', { text: 'Today' }));
  body.append(el('div', { class: 'muted', text:
    `${totals.discoveredToday} found · ${totals.preparedToday} prepared · ${totals.submittedToday} submitted `
    + `· ${totals.pendingReview} awaiting review · ${totals.blocked} need you` }));

  body.append(el('h3', { text: 'Daily summary' }));
  body.append(miniTable(['Day', 'Found', 'Prepared', 'Submitted'],
    report.dailySummary.daily.map((d) => [d.day, d.discovered, d.prepared, d.submitted])));

  body.append(el('h3', { text: `Application log (${report.applicationLog.length})` }));
  body.append(miniTable(['Job', 'Status', 'When', 'Confirmation', 'Blockers'],
    report.applicationLog.slice(0, 200).map((r) => [
      `${r.company} — ${r.title}`, String(r.appStatus).replace(/_/g, ' '),
      shortStamp(r.appliedAt) || '—', r.confirmation ?? '—',
      (r.blockers ?? []).join('; ') || '—',
    ])));

  body.append(el('h3', { text: `Prepared packets awaiting action (${report.preparedPackets.length})` }));
  body.append(miniTable(['Job', 'Grade', 'Sponsorship', 'Status'],
    report.preparedPackets.map((r) => [
      `${r.company} — ${r.title}`, r.grade?.letter ?? '—', r.sponsorship ?? '—',
      String(r.appStatus).replace(/_/g, ' '),
    ])));

  body.append(el('h3', { text: 'Source performance' }));
  body.append(miniTable(['Source', 'Found', 'Strong', 'Strong rate', 'Prepared', 'Submitted'],
    report.sourcePerformance.map((s) => [s.source, s.found, s.strong, `${s.strongRate}%`, s.prepared, s.submitted])));

  body.append(el('h3', { text: 'Sponsorship summary' }));
  body.append(miniTable(['Confidence', 'Jobs', 'Strong fit'],
    report.sponsorshipSummary.map((s) => [s.confidence, s.jobs, s.strongFit])));
}

async function openDocuments() {
  const body = $('documentsBody');
  body.textContent = '';
  body.append(el('div', { class: 'skeleton' }));
  openDialog($('dlgDocuments'));

  let docs;
  try { docs = await api('/api/documents'); }
  catch (err) { body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }

  body.textContent = '';
  if (docs.master) {
    body.append(el('h3', { text: 'Master resume' }));
    const row = el('div', { class: 'row-gap' });
    row.append(el('span', {
      class: docs.master.exists ? 'muted' : 'st-blocked',
      text: docs.master.exists
        ? `${kb(docs.master.bytes)}, updated ${shortStamp(docs.master.modifiedAt)}`
        : 'NOT FOUND — tailoring cannot run without it',
    }));
    row.append(el('button', {
      class: 'small', 'data-action': 'open-master',
      text: docs.master.exists ? 'View / replace…' : 'Upload it…',
    }));
    body.append(row);
    body.append(el('div', { class: 'mr-path', text: docs.master.path }));
  }
  body.append(el('h3', { text: `Tailored versions (${docs.tailored.length})` }));
  if (!docs.tailored.length) {
    body.append(el('div', { class: 'muted', text: 'No tailored resumes yet — prepare a job to generate one.' }));
    return;
  }
  body.append(miniTable(['Job', 'Prepared', 'ATS', 'Updates', 'Gaps', 'Open'],
    docs.tailored.slice(0, 200).map((d) => [
      `${d.company} — ${d.title}`,
      shortStamp(d.preparedAt) || '—',
      d.atsScore != null ? `${d.atsScore}%` : '—',
      d.tailoring?.changeCount ?? '—',
      d.tailoring?.gapCount ?? '—',
      el('button', { class: 'small', 'data-action': 'preview-resume', 'data-id': d.jobId, text: '👁 View' }),
    ])));
}

/* ───────────────────────── master resume ───────────────────────── */

const MASTER_MAX_BYTES = 8 * 1024 * 1024;
const kb = (bytes) => `${Math.max(1, Math.round(Number(bytes ?? 0) / 1024))} KB`;

/**
 * A resume line that is almost certainly a section heading, so the plain-text
 * preview keeps the document's shape instead of reading as one grey wall.
 */
function looksLikeHeading(line) {
  const text = String(line).trim();
  if (text.length > 48 || /[.;]$/.test(text)) return false;
  return text === text.toUpperCase() ? /[A-Z]/.test(text) : /^[A-Z][\w/&' -]*$/.test(text);
}

async function openMasterResume() {
  const body = $('masterBody');
  body.textContent = '';
  body.append(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  $('masterMsg').textContent = '';
  openDialog($('dlgMaster'));
  await renderMasterResume();
}

async function renderMasterResume() {
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
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

async function uploadMasterResume(file) {
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

async function restoreMasterVersion(name) {
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

async function openHealth() {
  const body = $('healthBody');
  body.textContent = '';
  body.append(el('div', { class: 'skeleton' }));
  openDialog($('dlgHealth'));
  let health;
  try { health = await api('/api/health'); }
  catch (err) { body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }

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

function download(path, filename) {
  fetch(path).then(async (res) => {
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

/* ─────────────────────── run status polling ─────────────────────── */

let pollTimer = null;
let wasRunning = false;

/**
 * Quiet background refresh for a tab left open a long time.
 *
 * `pollRun` only calls `refreshAll` when a run THIS TAB started transitions
 * from running to finished — it has no way to notice a `npm run score` (or
 * `watch`) invoked in a separate terminal, since that runs as a different OS
 * process with its own memory and never touches this tab's in-memory
 * `runState`. Without this, a tab can sit open for hours showing counts from
 * whenever it was last loaded while the database underneath has moved on —
 * exactly the shape of bug this was built to catch: a "posted 24h" number
 * that no longer has any relationship to "posted 1w" because they were
 * fetched at different, arbitrarily separated moments.
 *
 * Deliberately quiet: only when the tab is visible (no point refreshing what
 * nobody is looking at) and only when idle (a run's own progress rendering
 * already keeps itself current — refreshing over it would fight that).
 */
const BACKGROUND_REFRESH_MS = 90_000;
function scheduleBackgroundRefresh() {
  setTimeout(async () => {
    if (document.visibilityState === 'visible' && !state.lastRunStatus?.running) {
      await refreshAll();
    }
    scheduleBackgroundRefresh();
  }, BACKGROUND_REFRESH_MS);
}

function prettyResult(result) {
  if (!result) return '';
  if (result.cancelled) return `${result.phase ?? 'run'} cancelled · finished work kept`;
  if (result.phase === 'assist-batch') {
    const list = result.results ?? [];
    const filled = list.filter((x) => x.status !== 'failed').length;
    const submitted = list.filter((x) => x.submitted).length;
    const skipped = (result.skipped ?? []).length;
    const parts = [];
    if (submitted) parts.push(`${submitted} submitted`);
    parts.push(`${filled - submitted} filled for review`);
    // Skips were previously invisible, so a fully-skipped batch read as "0/0".
    if (skipped) parts.push(`${skipped} skipped`);
    return `Auto-fill done · ${parts.join(' · ')}`;
  }
  if (result.phase === 'assist') return `Assist done · ${String(result.status ?? '').replace(/_/g, ' ')}`;
  const counters = result.counters ?? {};
  // A discovery pass reports five figures, so these are grouped: "Found 14461"
  // is materially harder to read at a glance than "Found 14,461".
  if (result.phase === 'prepare-selected') return `Prepared ${fmt(counters.jobs_prepared)} packet(s)`;
  if (result.phase === 'prepare') return `Prepared ${fmt(counters.jobs_prepared)} · scored ${fmt(counters.jobs_scored)}`;
  if (result.phase === 'discover') return `Found ${fmt(counters.jobs_found)} · scored ${fmt(counters.jobs_scored)}`;
  if (result.phase === 'score') return `Re-scored ${fmt(counters.jobs_rescored ?? counters.jobs_scored)}`;
  return `${result.phase ?? 'run'} done`;
}

/** What the user asked for, in their words — not the internal phase name. */
const PHASE_LABELS = {
  discover: 'Finding new jobs',
  score: 'Re-scoring existing jobs',
  prepare: 'Finding & preparing',
  'prepare-selected': 'Preparing selected jobs',
  assist: 'Filling the application',
  'assist-batch': 'Auto-filling applications',
};

function phaseLabel(phase) {
  const key = String(phase ?? '').replace(/\s*\(.*$/, '');
  return PHASE_LABELS[key] ?? `${key || 'Run'} running`;
}

/** mm:ss since an ISO timestamp — a long run should say how long it has been. */
function elapsedSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The per-source (or per-job) breakdown behind "Details".
 *
 * Every field here was already in the run state and had nowhere to appear, so a
 * board that timed out or got throttled looked identical to one that returned
 * nothing. Rendered from state each poll so an open panel stays live.
 */
function renderRunDetails(status) {
  const host = $('runDetails');
  host.textContent = '';
  const progress = status?.progress;
  const items = progress?.items ?? [];

  if (items.length) {
    const perSource = progress.kind === 'sources';
    host.append(el('h4', { text: perSource ? 'Job boards' : 'Jobs in this batch' }));
    for (const item of items) {
      const row = el('div', { class: 'run-row' });
      row.append(el('span', { class: 'who', text: perSource ? item.source : (state.known.get(item.jobId)?.company ?? item.jobId) }));
      const bits = [];
      if (perSource) {
        if (item.found) bits.push(`${fmt(item.found)} found`);
        if (item.errors) bits.push(`${item.errors} error(s)`);
        if (item.cached) bits.push('cached');
        if (Number.isFinite(item.durationMs) && item.durationMs > 0) bits.push(`${Math.round(item.durationMs / 1000)}s`);
      } else if (item.reason) bits.push(item.reason);
      if (bits.length) row.append(el('span', { class: 'num', text: bits.join(' · ') }));
      row.append(el('span', { class: `state ${item.status ?? ''}`.trim(), text: item.status ?? '' }));
      host.append(row);
    }
  }

  // Structured per-source failures. The classifier already works out WHY
  // (category + HTTP status), keeps the sanitized provider message, and carries
  // per-category guidance — but only `impact` was rendered, so the panel said
  // "16 results are missing" and never why. Cause, provider message, the fix,
  // and the cost are all shown now.
  const rca = status?.rca ?? [];
  if (rca.length) {
    host.append(el('h4', { text: status.partial ? 'Problems (partial results kept)' : 'Problems' }));
    for (const entry of rca.slice(0, 12)) {
      const block = el('div', { class: 'run-problem' });
      const head = el('div', { class: 'run-row' });
      const cause = [
        String(entry.category ?? 'unknown').replace(/_/g, ' '),
        entry.status ? `HTTP ${entry.status}` : null,
        entry.retryCount ? `${entry.retryCount} retr${entry.retryCount === 1 ? 'y' : 'ies'}` : null,
      ].filter(Boolean).join(' · ');
      head.append(el('span', { class: 'who' }, el('b', { text: entry.source ?? entry.operation ?? 'run' })));
      head.append(el('span', { class: 'num', text: cause }));
      if (entry.count > 1) head.append(el('span', { class: 'num', text: `×${entry.count}` }));
      head.append(el('span', { class: 'state failed', text: entry.degraded ? 'degraded' : 'failed' }));
      block.append(head);
      if (entry.message) block.append(el('div', { class: 'run-why', text: entry.message }));
      if (entry.guidance) block.append(el('div', { class: 'run-fix', text: entry.guidance }));
      if (entry.impact) block.append(el('div', { class: 'run-impact', text: entry.impact }));
      host.append(block);
    }
  }

  if (!items.length && !rca.length) {
    host.append(el('div', { class: 'muted', text: 'No per-source detail was reported for this run.' }));
  }
}

function applyRunGate(status) {
  state.running = Boolean(status?.running);
  for (const id of ['btnDiscover', 'btnPrepare']) {
    const button = $(id);
    button.disabled = state.running;
    // Remember the real explanation the FIRST time, before it is replaced.
    // Reading it back from `button.title` restored the "run in progress" text
    // instead, so after one run these buttons never explained themselves again.
    if (button.dataset.title === undefined) button.dataset.title = button.title;
    button.title = state.running ? 'A run is in progress…' : button.dataset.title;
  }

  const box = $('runbox');
  const cancel = $('btnCancel');
  const details = $('btnRunDetails');
  const dismiss = $('btnRunDismiss');
  const line = $('runline');
  const progress = status?.progress;
  const finished = status?.finishedAt ?? null;
  // A finished result stays until it is dismissed OR superseded by a newer run.
  const dismissed = Boolean(finished) && state.runDismissedAt === finished;

  if (state.running) {
    box.dataset.state = 'running';
    $('runStatus').textContent = status.cancelRequested
      ? `Stopping ${phaseLabel(status.phase).toLowerCase()}…`
      : phaseLabel(status.phase);
    const meta = [];
    if (progress && Number.isFinite(progress.total) && progress.total > 0) {
      const unit = progress.kind === 'sources' ? 'sources' : 'jobs';
      meta.push(`${progress.completed ?? 0} of ${progress.total} ${unit}`);
      if (progress.currentSource) meta.push(progress.currentSource);
    }
    const elapsed = elapsedSince(status.startedAt);
    if (elapsed) meta.push(elapsed);
    $('runMeta').textContent = meta.join(' · ');

    // Determinate when the server knows the total; motion-only when it does not,
    // rather than a bar that pretends to know how far along it is.
    const total = Number(progress?.total);
    const done = Number(progress?.completed ?? 0);
    line.hidden = false;
    if (Number.isFinite(total) && total > 0) {
      line.classList.remove('indeterminate');
      $('runlineFill').style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
    } else {
      line.classList.add('indeterminate');
      $('runlineFill').style.width = '';
    }
  } else if (status?.lastError && !dismissed) {
    box.dataset.state = 'error';
    $('runStatus').textContent = 'Run failed';
    $('runMeta').textContent = status.lastError;
    line.hidden = true;
  } else if (status?.lastResult && !dismissed) {
    box.dataset.state = status.partial || (status.rca ?? []).length ? 'warn' : 'ok';
    $('runStatus').textContent = prettyResult(status.lastResult);
    $('runMeta').textContent = status.partial
      ? 'some sources failed — partial results kept' : '';
    line.hidden = true;
  } else {
    box.dataset.state = 'idle';
    line.hidden = true;
  }

  const idle = box.dataset.state === 'idle';
  cancel.hidden = !state.running;
  cancel.disabled = !state.running || status.cancelRequested;
  cancel.textContent = status?.cancelRequested ? 'Stopping…' : 'Cancel';
  dismiss.hidden = state.running || idle;
  details.hidden = idle || (!(progress?.items ?? []).length && !(status?.rca ?? []).length);
  if (details.hidden) setRunDetails(false);
  if ($('runDetails').hidden === false) renderRunDetails(status);
  // Keep the last payload so opening the panel does not need another fetch.
  state.lastRunStatus = status ?? null;

  syncSelectionBar();
}

/** Open/close the run breakdown. */
function setRunDetails(open) {
  $('runDetails').hidden = !open;
  $('btnRunDetails').setAttribute('aria-expanded', String(open));
  if (open) renderRunDetails(state.lastRunStatus);
}

async function pollRun() {
  clearTimeout(pollTimer);
  const wasDown = state.serverUp === false;
  let status;
  try {
    status = await api('/api/run/status');
  } catch {
    pollTimer = setTimeout(pollRun, 2000);
    return;
  }
  applyRunGate(status);
  if (wasDown || (!status.running && wasRunning)) refreshAll();
  wasRunning = status.running;
  pollTimer = setTimeout(pollRun, status.running ? 1500 : 5000);
}

/* ────────────────────── event delegation ────────────────────── */

const ACTIONS = {
  reload: () => location.reload(),
  'cancel-run': async () => {
    try { await postJson('/api/run/cancel'); toast('Cancelling — finished work is kept.'); pollRun(); }
    catch (err) { toast(err.message, 'bad'); }
  },
  run: (target) => runPhase(target.dataset.phase),
  'toggle-run-details': () => setRunDetails($('runDetails').hidden),
  'dismiss-run': () => {
    // Remember WHICH result was dismissed, so the next run's outcome still shows.
    state.runDismissedAt = state.lastRunStatus?.finishedAt ?? null;
    setRunDetails(false);
    applyRunGate(state.lastRunStatus);
  },
  'toggle-menu': (target) => {
    const pop = $('mainMenu');
    const open = pop.dataset.open !== 'true';
    pop.dataset.open = String(open);
    target.setAttribute('aria-expanded', String(open));
  },
  'toggle-theme': () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    savePreference('theme', next);
  },
  'open-learn': () => window.open('/learn/', '_blank', 'noopener'),
  'open-reports': openReports,
  'open-documents': openDocuments,
  'open-master': (target) => {
    // Never stack modals: opening this from the Resume library replaces it.
    closeDialog(target?.closest?.('dialog'));
    openMasterResume();
  },
  'pick-master-file': () => {
    // Reset first so re-picking the SAME file still fires 'change'.
    $('masterFile').value = '';
    $('masterFile').click();
  },
  'restore-master': (target) => restoreMasterVersion(target.dataset.name),
  'open-health': openHealth,
  'export-jobs': () => download('/api/export/jobs.csv', 'jobagent_jobs.csv'),
  'export-tracker': () => download('/api/export/tracker.csv', 'job_tracker.csv'),

  'set-tab': (target) => {
    state.activeTab = target.dataset.tab;
    // The tab view is the whole scope, so manual filters are cleared to keep
    // the badge count and the visible rows in agreement.
    for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);
    state.page = 1;
    renderTabs();
    refreshAll();
  },
  'metric-filter': (target) => {
    try { applyFilterObject(JSON.parse(target.dataset.filter)); }
    catch { /* malformed filter payload */ }
  },
  'clear-filter': (target) => {
    const id = target.dataset.filter;
    clearFilter(id);
    state.page = 1;
    refreshAll();
  },
  'reset-filters': () => resetFilters(),
  'set-posted': (target) => {
    // Clicking the active segment clears it — that IS the "any date" option, so
    // the switch needs no fourth button for "no filter".
    const next = filterValue('postedWithinHours') === target.dataset.value ? '' : target.dataset.value;
    setFilterValue('postedWithinHours', next);
    state.page = 1;
    onFilterChange();
  },
  page: (target) => {
    state.page = Math.max(1, Number(target.dataset.page) || 1);
    loadBoard();
    document.querySelector('.boardwrap')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },

  select: (target) => selectJob(target.dataset.id),
  // 'toggle-select' is intentionally absent: checkboxes are handled by the
  // 'change' listener below so keyboard toggling works identically, and
  // resolving to the input here still stops the row's select from firing.
  'clear-selection': clearSelection,
  'batch-autofill': batchAutofill,
  'batch-prepare': batchPrepare,
  'batch-approve': batchApprove,
  'batch-decide': (target) => batchDecide(target.dataset.decision),
  compare: showCompare,

  decide: (target) => decide(target.dataset.id, target.dataset.decision),
  approve: (target) => simpleAction(target.dataset.id, 'approve', 'Packet approved'),
  'reject-packet': (target) => simpleAction(target.dataset.id, 'reject-packet', 'Packet rejected'),
  assist: (target) => simpleAction(target.dataset.id, 'assist', 'Browser opening — it stops before Submit'),
  'autofill-one': (target) => autofillOne(target.dataset.id),
  'prepare-one': (target) => prepareOne(target.dataset.id),
  'check-link': (target) => checkLink(target.dataset.id),
  'preview-resume': (target) => openResumePreview(target.dataset.id),
  'copy-id': async (target) => {
    const id = target.dataset.id;
    try { await navigator.clipboard.writeText(id); }
    catch {
      const area = el('textarea', {});
      area.value = id;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast('Job id copied');
  },
  'save-note': async (target) => {
    const note = $('noteBox')?.value ?? '';
    try {
      await postJson(`/api/jobs/${encodeURIComponent(target.dataset.id)}/note`, { note });
      toast('Note saved', 'good');
    } catch (err) { toast(err.message, 'bad'); }
  },

  'open-add-url': () => {
    $('addUrlInput').value = '';
    $('addUrlMsg').textContent = '';
    $('addUrlGo').disabled = false;
    openDialog($('dlgAddUrl'));
  },
  'submit-add-url': submitAddUrl,
  'open-link-dialog': (target) => {
    const dialog = $('dlgLink');
    dialog.dataset.jobId = target.dataset.id;
    $('linkInput').value = state.known.get(target.dataset.id)?.url ?? '';
    $('linkMsg').textContent = '';
    openDialog(dialog);
  },
  'submit-link': submitLink,
  'open-submit-dialog': (target) => {
    const dialog = $('dlgSubmit');
    dialog.dataset.jobId = target.dataset.id;
    const job = state.known.get(target.dataset.id);
    $('dlgSubmitJob').textContent = job ? `${job.company} — ${job.title}` : target.dataset.id;
    $('submitConf').value = '';
    $('submitNote').value = '';
    openDialog(dialog);
  },
  'confirm-submitted': confirmSubmitted,
  'close-dialog': (target) => closeDialog(target.closest('dialog')),
};

async function submitAddUrl() {
  const url = $('addUrlInput').value.trim();
  const msg = $('addUrlMsg');
  if (!url) { msg.className = 'st-blocked'; msg.textContent = 'Paste a job URL first.'; return; }
  $('addUrlGo').disabled = true;
  msg.className = 'muted';
  msg.textContent = 'Reading and scoring the posting…';
  try {
    const result = await postJson('/api/add-url', { url });
    closeDialog($('dlgAddUrl'));
    toast(`Added ${result.company || 'job'} — scored ${result.score ?? '—'} (${result.tier})`, 'good');
    await refreshAll();
    if (result.id) selectJob(result.id);
  } catch (err) {
    msg.className = 'st-blocked';
    msg.textContent = err.message;
    $('addUrlGo').disabled = false;
  }
}

async function submitLink() {
  const dialog = $('dlgLink');
  const id = dialog.dataset.jobId;
  const url = $('linkInput').value.trim();
  const msg = $('linkMsg');
  if (!url) { msg.className = 'st-blocked'; msg.textContent = 'Paste the direct application URL.'; return; }
  try {
    await postJson(`/api/jobs/${encodeURIComponent(id)}/link`, { url });
    closeDialog(dialog);
    toast('Direct application URL saved.', 'good');
    patchRow(id, { url });
    if (state.selectedId === id) selectJob(id);
    scheduleRefresh();
  } catch (err) { msg.className = 'st-blocked'; msg.textContent = err.message; }
}

async function confirmSubmitted() {
  const dialog = $('dlgSubmit');
  const id = dialog.dataset.jobId;
  const confirmation = $('submitConf').value.trim();
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/mark-submitted`, {
      confirmationNumber: confirmation || undefined,
      verified: Boolean(confirmation),
      note: $('submitNote').value,
    });
    closeDialog(dialog);
    toast(result.verified
      ? 'Recorded as submitted with confirmation evidence.'
      : 'Recorded as reported — pending your verification. Not counted as applied yet.',
    result.verified ? 'good' : '');
    if (state.selectedId === id) selectJob(id);
    scheduleRefresh(0);
  } catch (err) { toast(err.message, 'bad'); }
}

/** Close the header menu. */
function closeMainMenu() {
  const pop = $('mainMenu');
  if (pop.dataset.open !== 'true') return;
  pop.dataset.open = 'false';
  document.querySelector('[data-action="toggle-menu"]')?.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (event) => {
  // A real link always just navigates. Rows are themselves clickable
  // (`data-action="select"`), so without this a link inside one would ALSO
  // select the row — and any future link that forgets its own `data-action`
  // would be swallowed by the row entirely. Guarding on the element clicked
  // fixes the whole class, not one instance of it.
  if (event.target.closest?.('a[href]')) return;
  const target = event.target.closest('[data-action]');
  // Any click closes the header menu except on its own trigger, which toggles.
  // Choosing an item used to LEAVE it open, hanging over the page behind it.
  if (target?.dataset.action !== 'toggle-menu') closeMainMenu();
  if (!$('runDetails').hidden && !$('runbox').contains(event.target)) setRunDetails(false);
  if (!target) return;
  const action = ACTIONS[target.dataset.action];
  if (!action) return;
  // A checkbox inside a clickable row must not also trigger row selection.
  if (target.dataset.action !== 'select') event.stopPropagation();
  if (target.tagName === 'A') return; // let real links navigate
  action(target, event);
});

// Checkbox changes fire on 'change', not 'click', for keyboard users.
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset?.action === 'toggle-select') {
    toggleSelect(target.dataset.id, target.checked);
  }
});

/* ────────────────────── keyboard support ────────────────────── */

$('rows').addEventListener('keydown', (event) => {
  const row = event.target.closest('tr.job');
  if (!row) return;
  const index = state.visible.indexOf(row.dataset.id);

  // When a link inside the row has focus, Enter belongs to the LINK. Without
  // this the handler's preventDefault() swallowed it and selected the row
  // instead — a keyboard user could focus the role link and never open it.
  if (event.key === 'Enter' && event.target.closest('a[href]')) return;

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectJob(row.dataset.id);
    return;
  }
  if (event.key === 'x' || event.key === 'X') {
    event.preventDefault();
    const box = row.querySelector('input[type=checkbox]');
    box.checked = !box.checked;
    toggleSelect(row.dataset.id, box.checked);
    return;
  }
  const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (!delta) return;
  event.preventDefault();
  const next = state.visible[index + delta];
  if (next) {
    const nextRow = $('rows').querySelector(`tr.job[data-id="${cssEscape(next)}"]`);
    nextRow?.focus();
    selectJob(next);
  }
});

/**
 * The metric tiles are spans with role="button" (they must not nest inside the
 * flex strip as real buttons), so Enter/Space has to be wired up by hand —
 * without this they were focusable but impossible to activate by keyboard.
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest?.('[role="button"][data-action]');
  if (!target || target.tagName === 'BUTTON' || target.tagName === 'A') return;
  event.preventDefault();
  target.click();
});

document.addEventListener('keydown', (event) => {
  // "/" focuses search, as in most triage tools.
  if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
    event.preventDefault();
    $('q').focus();
  }
  if (event.key !== 'Escape') return;
  closeMainMenu();
  if (!$('runDetails').hidden) {
    setRunDetails(false);
    $('btnRunDetails').focus();
    return;
  }
  // Escape in the search box clears it, the standard search-field behavior.
  if (event.target === $('q') && $('q').value) {
    $('q').value = '';
    state.page = 1;
    onFilterChange();
  }
});

$('selAll').addEventListener('change', (event) => {
  for (const id of state.visible) {
    if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
  }
  for (const box of $('rows').querySelectorAll('input[data-action="toggle-select"]')) {
    box.checked = event.target.checked;
  }
  syncSelectionBar();
});

/**
 * Mark the column the board is actually sorted by.
 *
 * This is derived from state rather than set on click, so "Reset" and the
 * initial load agree with the data: the old build left a stale indicator on
 * whichever header you last clicked, and never marked the default sort at all.
 */
function syncSortIndicator() {
  for (const th of document.querySelectorAll('th.sortable')) {
    if (th.dataset.sort === state.sort) {
      th.setAttribute('aria-sort', SORT_DIRECTION[state.sort] ?? 'descending');
    } else th.removeAttribute('aria-sort');
  }
}

/**
 * Remember VIEW preferences (sort column, rows per page) but never filters.
 * Coming back to a board that is silently narrowed is disorienting; coming back
 * to the row count and ordering you chose is just the tool remembering you.
 */
function savePreference(key, value) {
  try { localStorage.setItem(`jobagent-${key}`, String(value)); }
  catch { /* private mode */ }
}
function readPreference(key) {
  try { return localStorage.getItem(`jobagent-${key}`); }
  catch { return null; }
}

/* Header sort toggles */
for (const th of document.querySelectorAll('th.sortable')) {
  th.addEventListener('click', () => {
    state.sort = th.dataset.sort;
    state.page = 1;
    savePreference('sort', state.sort);
    syncSortIndicator();
    loadBoard();
  });
  th.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    th.click();
  });
}

/* Filter wiring */
// Free-text filters debounce on every keystroke so the board tracks what is
// typed. A bare `change` listener would only fire on blur/Enter, which reads
// as the filter being broken while you are still looking at the field.
const DEBOUNCED_TEXT_FILTERS = ['q', 'city'];
let searchTimer = null;
for (const id of DEBOUNCED_TEXT_FILTERS) {
  $(id).addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.page = 1; onFilterChange(); }, 250);
  });
}
// Every other filter control except the segmented switch (a click, not a
// change) reloads the board when it changes.
for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) {
  if (DEBOUNCED_TEXT_FILTERS.includes(id) || $(id).type === 'hidden') continue;
  $(id).addEventListener('change', () => { state.page = 1; onFilterChange(); });
}
$('pageSize').addEventListener('change', (event) => {
  state.pageSize = Number(event.target.value) || 100;
  state.page = 1;
  savePreference('pageSize', state.pageSize);
  loadBoard();
});

function onFilterChange() {
  // Touching a filter leaves the tab scope, so the badge and the board agree.
  if (state.activeTab !== 'all') {
    state.activeTab = 'all';
    renderTabs();
  }
  loadBoard();
}

/* Dialog submit-on-Enter */
$('addUrlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAddUrl(); } });
$('linkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitLink(); } });

/* Master resume upload — the hidden picker is opened by the visible button. */
$('masterFile').addEventListener('change', (event) => {
  uploadMasterResume(event.target.files?.[0]);
});

/* ───────────────────────────── boot ───────────────────────────── */

const savedTheme = readPreference('theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.dataset.theme = savedTheme;
}

function jobIdFromHash() {
  const match = location.hash.match(/^#job=(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

// Back/forward between jobs now works (the old build wrote the hash but never
// listened for changes).
window.addEventListener('hashchange', () => {
  const id = jobIdFromHash();
  if (id && id !== state.selectedId) selectJob(id);
});

// Restore the view preferences, validating both against the offered choices so
// a stale or hand-edited value can never put the board in an unreachable state.
const savedSort = readPreference('sort');
if (savedSort && Object.hasOwn(SORT_DIRECTION, savedSort)
  && document.querySelector(`th.sortable[data-sort="${savedSort}"]`)) {
  state.sort = savedSort;
}
const savedPageSize = readPreference('pageSize');
if (savedPageSize && [...$('pageSize').options].some((o) => o.value === savedPageSize)) {
  $('pageSize').value = savedPageSize;
}
state.pageSize = Number($('pageSize').value) || 100;
renderTabs();
syncSortIndicator();
refreshAll().then(() => {
  const initial = jobIdFromHash();
  if (initial) selectJob(initial);
});
pollRun();
scheduleBackgroundRefresh();
syncSelectionBar();
