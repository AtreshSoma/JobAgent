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
  /** Per-tab counts under the ACTIVE filters; null when no filter is set. */
  filteredViewCounts: null,
  /** finishedAt of a result the user dismissed; a newer run reappears. */
  runDismissedAt: null,
  /*
   * WHICH SEARCH THE BOARD IS SHOWING — 'profile' or 'role_search'.
   *
   * 'profile' is the personalized board and the default everywhere. A role
   * search never changes it; it opens its OWN list, scoped to one query, which
   * is why the query is held alongside the mode rather than in the text filter.
   * Using the text filter for this was the original leak: it made role-search
   * rows look like personalized rows that happened to match a string.
   */
  discoveryMode: 'profile',
  roleQuery: null,
  /** Last link-check result per job id, so a re-render does not erase it. */
  linkHealth: new Map(),
  /** 'today' (the action queue) or 'board'. */
  view: 'today',
  /** Last /api/today payload (or its derived fallback). */
  today: null,
  /** Tool-level blockers from /api/today, e.g. browser_unavailable. */
  systemNotices: [],
  /** True while the automation browser is missing: every Auto-fill waits. */
  browserUnavailable: false,
  /** Last /api/health (doctor) payload, fetched once when idle. */
  health: null,
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

/**
 * Which sort direction each board sort actually applies, for aria-sort.
 *
 * This doubles as the allow-list boot validates a saved sort against, so a sort
 * missing here is silently discarded on reload. `discovered` (the "Found"
 * column) was absent while the server supported it, which made it the only
 * column whose sort did not survive a refresh — and it is the one the
 * run-result flow sends you to, to see what a run actually turned up.
 */
const SORT_DIRECTION = {
  score: 'descending', posted: 'descending', company: 'ascending',
  updated: 'descending', discovered: 'descending',
};

const TABS = [
  ['all', 'All jobs', false],
  // "Priority", not "Today": the landing view is called Today now, and two
  // different things wearing one name is how a count stops being trusted.
  ['today', 'Priority', true],
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
/** Tags that only exist in the SVG namespace — `createElement` yields an inert
 *  HTMLUnknownElement for these, which renders as nothing at all. */
const SVG_TAGS = new Set(['svg', 'polyline', 'circle', 'path', 'line', 'g', 'rect', 'text']);

function el(tag, attrs = {}, ...children) {
  const svg = SVG_TAGS.has(tag);
  const node = svg
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    // `className` on an SVG element is a read-only SVGAnimatedString.
    if (k === 'class') { if (svg) node.setAttribute('class', v); else node.className = v; }
    // There is deliberately no `html` key. It existed as an innerHTML escape
    // hatch; nothing needed it, and every caller that one day reached for it
    // with a job title or a provider message would have been an injection.
    else if (k === 'text') node.textContent = v;
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

/**
 * The URL, but only if it is safe to put in an href: absolute http(s) only.
 *
 * Job URLs come from third-party feeds and from anything a user pastes into
 * "Add by URL". `javascript:` and `data:` hrefs would execute or render on
 * click — the CSP blocks inline script, but a link is the one place a URL is
 * handed to the browser to act on, so it is checked where it is used.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
function safeHref(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch { return null; }
}

/**
 * Run `fn` with `button` marked busy, and refuse re-entry while it runs.
 *
 * Every mutating button used to be clickable again the instant it was clicked,
 * so an impatient double click on "Add & score", "I submitted it myself" or a
 * run button fired the request twice. The guard is the `aria-busy` flag rather
 * than `disabled`: disabling a focused button throws focus to <body>, which
 * strands a keyboard user in the middle of the page every time they press one.
 *
 * @template T
 * @param {Element|null|undefined} button
 * @param {() => T|Promise<T>} fn
 * @param {{ label?: string }} [options] text to show while busy
 * @returns {Promise<T|undefined>}
 */
async function withBusy(button, fn, { label } = {}) {
  if (!button || button.nodeType !== 1) return fn();
  if (button.getAttribute('aria-busy') === 'true') return undefined;
  const restore = label ? [...button.childNodes] : null;
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-disabled', 'true');
  button.classList.add('is-busy');
  if (label) button.textContent = label;
  try {
    return await fn();
  } finally {
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
    button.classList.remove('is-busy');
    if (restore) button.replaceChildren(...restore);
  }
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

/**
 * The one place the page talks to the server.
 *
 * Every non-GET request carries `X-Job-Agent: 1`. A cross-site form or image
 * cannot set a custom header without a CORS preflight the server never grants,
 * so the header lets the server tell its own page from a drive-by POST — and
 * because it is added HERE, no mutation can be written that forgets it.
 *
 * Errors carry `status`, so a caller can tell "this server has no such route"
 * (an older process) from a real failure and fall back instead of breaking.
 */
async function api(path, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const headers = { ...(options.headers ?? {}) };
  if (method !== 'GET' && method !== 'HEAD') headers['X-Job-Agent'] = '1';
  let res;
  try {
    res = await fetch(path, { ...options, method, headers });
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
      throw Object.assign(new Error('This feature is newer than the dashboard process that is running. '
        + 'Stop it and run "npm run dashboard" again, then reload this page.'), { status: 404, noRoute: true });
    }
    throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
  }
  return body;
}

/**
 * GET an endpoint that an older server may not have. Resolves to `null` on a
 * 404 so the caller can fall back; every other failure still throws.
 */
async function apiOptional(path) {
  try { return await api(path); }
  catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
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
  // Scope every board read to the active mode. Omitted for 'profile' because
  // that is the server's default too, so an older client and a newer server
  // agree on what an unscoped request means.
  if (state.discoveryMode === 'role_search') {
    p.set('discoveryMode', 'role_search');
    if (state.roleQuery) p.set('searchQuery', state.roleQuery);
  }
  if (!forCount) {
    p.set('limit', String(state.pageSize));
    p.set('page', String(state.page));
    // Only worth computing when the tab counts in /api/stats would NOT already
    // be exactly right — otherwise this is eight predicate passes over the
    // corpus for an answer we already have.
    //
    // Two cases need them. A filter narrowing the board is the obvious one. The
    // other is role-search mode: /api/stats describes the PERSONALIZED board,
    // so while the board is showing a role search the badges were counting a
    // different set of rows than the tabs would open — the same
    // "count doesn't match what clicking it opens" fault the board's own
    // filters were built to prevent.
    if (hasActiveFilters() || state.discoveryMode === 'role_search') {
      p.set('withViewCounts', 'true');
    }
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
  // The tab is a scope like any other, and now that filters stack on top of it
  // the chip row is the one place that shows the WHOLE scope in one line.
  // Without it, "12 results" inside Needs review looks like 12 results overall.
  if (state.activeTab !== 'all') {
    const tab = TABS.find(([key]) => key === state.activeTab);
    if (tab) {
      host.append(el('span', { class: 'pill pill-scope' }, `In: ${tab[1]}`,
        el('button', { 'data-action': 'clear-tab', 'aria-label': `Leave the ${tab[1]} tab`, text: '✕' })));
    }
  }
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

  syncFilterSheetCount();
  // Every path that writes the query without an `input` event lands here —
  // Reset, "Clear all", dismissing the search chip, a restored URL, a metric
  // tile applying a filter object. One call at the single point they all share
  // beats remembering to add one to each of them.
  syncBoardSearchAction();

  for (const [id, label] of chips) {
    host.append(el('span', { class: 'pill' }, label,
      el('button', { 'data-action': 'clear-filter', 'data-filter': id, 'aria-label': `Clear filter ${label}`, text: '✕' })));
  }
  if (chips.length > 1) {
    host.append(el('button', { class: 'small ghost', 'data-action': 'reset-filters', text: 'Clear all' }));
  }
}

function resetFilters({ keepTab = false, silent = false } = {}) {
  if (!keepTab) state.activeTab = 'all';
  for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);
  state.sort = 'score';
  savePreference('sort', state.sort);
  syncSortIndicator();
  state.page = 1;
  renderTabs();
  // `silent` is for callers that are mid-transition and will refresh once
  // themselves — switching board modes clears filters AND changes scope, and
  // refreshing here would fetch the old scope with the new filters first.
  if (!silent) loadBoard();
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
  setView('board');
  loadBoard();
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
  // A REAL button when it does something, a plain span when it does not.
  // These were spans carrying role="button" + tabindex, which meant Enter and
  // Space had to be hand-wired in a global keydown listener — behaviour every
  // browser already gives a <button> for free, and which silently breaks the
  // moment that listener is refactored. The flex strip does not care which
  // element it lays out.
  if (filter) {
    return el('button', {
      ...attrs,
      type: 'button',
      'data-action': 'metric-filter',
      'data-filter': JSON.stringify(filter),
      'aria-label': `${fmt(value)} ${label} — filter the board to these`,
    }, el('b', { text: known ? fmt(value) : '—' }), el('span', { class: 'l', text: label }));
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

  // This strip is rebuilt from scratch on every stats load, so the profile
  // pill has to be re-added here or it would vanish on the next poll.
  renderHealthProfileFlag();
}

function renderTabs() {
  // When filters are active the board response carries counts computed against
  // those same filters, so a badge never promises rows the tab would not show.
  const filtered = state.filteredViewCounts;
  const views = filtered ?? state.stats?.views ?? {};
  const host = $('tabs');
  const keptFocus = host.contains(document.activeElement);
  host.textContent = '';
  for (const [key, label, urgent] of TABS) {
    const count = views[key] ?? 0;
    const selected = state.activeTab === key;
    host.append(el('button', {
      class: `tab${urgent && count > 0 ? ' urgent' : ''}${filtered ? ' scoped' : ''}`,
      role: 'tab',
      id: `tab-${key}`,
      'aria-selected': String(selected),
      // The tabs announced themselves as tabs while controlling nothing, so a
      // screen reader had no way to know what changed when one was activated.
      'aria-controls': 'boardwrap',
      // Roving tabindex: a tablist is ONE tab stop and the arrow keys move
      // within it. Eight separate stops between the header and the board is
      // exactly what the skip link exists to avoid.
      tabindex: selected ? '0' : '-1',
      'data-action': 'set-tab',
      'data-tab': key,
      title: filtered
        ? `${fmt(count)} of these match the filters you have set`
        : `${fmt(count)} job(s)`,
    }, label, el('span', { class: 'badge', text: fmt(count) })));
  }
  // Name the panel after whichever tab is currently showing in it.
  $('boardwrap').setAttribute('aria-labelledby', `tab-${state.activeTab}`);

  // These buttons are destroyed and rebuilt on every render — including the
  // background refresh a moment after a tab is activated. If focus was inside
  // the tablist it would land on <body>, stranding a keyboard user mid-row and
  // breaking arrow-key navigation after exactly one press.
  if (keptFocus) $(`tab-${state.activeTab}`)?.focus();
}

/**
 * How many rows a breakdown shows before it offers the rest.
 *
 * Measured: the location breakdown listed 56 rows and the source breakdown 16,
 * which made the analytics section 3,041px — 28% of a 10,738px page — to show
 * numbers whose whole job is "which few dominate?". A long tail of one-job
 * states answers nothing that the top eight do not.
 */
const BREAKDOWN_ROWS = 8;

/**
 * Fill a breakdown table with at most `BREAKDOWN_ROWS` rows, plus a control
 * that reveals the rest in place.
 *
 * The tail is BUILT but hidden rather than dropped, so expanding costs no
 * request and the numbers can never disagree with the summary above them.
 *
 * @param {HTMLElement} body tbody to fill
 * @param {any[]} entries every row, already sorted
 * @param {(entry:any, index:number) => HTMLElement} rowFn builds one <tr>
 * @param {number} colspan width of the "show all" row
 */
function fillBreakdown(body, entries, rowFn, colspan) {
  body.textContent = '';
  entries.forEach((entry, i) => {
    const tr = rowFn(entry, i);
    if (i >= BREAKDOWN_ROWS) tr.classList.add('tail');
    body.append(tr);
  });
  const hidden = entries.length - BREAKDOWN_ROWS;
  if (hidden <= 0) return;
  const cell = el('td', { colspan: String(colspan) });
  cell.append(el('button', {
    type: 'button', class: 'small ghost breakdown-more',
    'data-action': 'toggle-breakdown',
    'aria-expanded': 'false',
    text: `Show all ${fmt(entries.length)} ▾`,
  }));
  body.append(el('tr', { class: 'more-row' }, cell));
}

/**
 * Confidence is an ORDERED scale, so it is listed in scale order.
 *
 * It was sorted by count, which produced Unconfirmed(118k), Unclassified(9.1k),
 * Denied(2.4k), Likely(2.2k), Confirmed(155) — the scale shuffled into a
 * ranking, so "is this getting better or worse" could not be read off it at
 * all. Sorting an ordinal scale by frequency destroys the only thing it means.
 */
const SPONSORSHIP_SCALE = ['Confirmed', 'Likely', 'Unconfirmed', 'Denied', 'Unclassified'];

function renderAnalytics(stats) {
  const srcEntries = Object.entries(stats.bySource).sort((a, b) => b[1].found - a[1].found);
  const srcMax = Math.max(0, ...srcEntries.map(([, v]) => v.found));
  const srcRows = $('srcRows');

  // The lead states the diagnostic the table is there to support: how much of
  // the corpus rides on a handful of boards. Concentration is what you act on —
  // if the top three are 80% of everything, three outages are a dead pipeline.
  const foundTotal = srcEntries.reduce((sum, [, v]) => sum + v.found, 0);
  const topThree = srcEntries.slice(0, 3).reduce((sum, [, v]) => sum + v.found, 0);
  $('sourceLead').textContent = srcEntries.length
    ? `${srcEntries.length} sources · top 3 produce ${foundTotal ? Math.round((topThree / foundTotal) * 100) : 0}% of everything found`
    : 'Nothing found yet.';

  if (!srcEntries.length) {
    srcRows.textContent = '';
    srcRows.append(el('tr', {}, el('td', { colspan: '3', class: 'muted', text: 'No jobs yet — run “Find new jobs”.' })));
  } else {
    fillBreakdown(srcRows, srcEntries, ([src, v]) => el('tr', {},
      el('td', {}, el('button', {
        class: 'small ghost cell-link', 'data-action': 'metric-filter',
        'data-filter': JSON.stringify({ source: src }), text: src,
      })),
      el('td', { class: 'r' }, el('span', { class: 'num-with-bar' },
        el('span', { class: 'n', text: fmt(v.found) }), bar(v.found, srcMax))),
      // Volume next to yield, which is the comparison the old five-column table
      // buried: one source can supply a third of the corpus and one strong fit.
      el('td', { class: 'r' }, el('b', { class: v.strong > 0 ? 'yield-on' : 'yield-off', text: fmt(v.strong) }))), 3);
  }

  // Nationwide coverage, made inspectable: which states the board actually
  // holds jobs from. An empty or lopsided list here is a real coverage gap, not
  // a display quirk.
  const stateRows = $('stateRows');
  stateRows.textContent = '';
  const stateEntries = Object.entries(stats.byState ?? {})
    .sort((a, b) => b[1].count - a[1].count);
  const stateMax = Math.max(0, ...stateEntries.map(([, v]) => v.count));
  const coverage = stats.coverage;
  $('stateLead').textContent = coverage?.statesPossible
    ? `${coverage.statesCovered} of ${coverage.statesPossible} US states and territories represented`
    : `${stateEntries.length} location(s)`;

  if (!stateEntries.length) {
    stateRows.append(el('tr', {}, el('td', { colspan: '3', class: 'muted', text: 'No jobs yet.' })));
  } else {
    fillBreakdown(stateRows, stateEntries, ([code, v]) => {
      const label = code === 'US' || code === 'unknown' ? v.name : `${v.name} (${code})`;
      return el('tr', {},
        el('td', { class: 'ellipsis', title: label, text: label }),
        el('td', { class: 'r' }, el('span', { class: 'num-with-bar' },
          el('span', { class: 'n', text: fmt(v.count) }), bar(v.count, stateMax))),
        el('td', { class: 'r' }, el('b', { class: v.strong > 0 ? 'yield-on' : 'yield-off', text: fmt(v.strong) })));
    }, 3);
  }

  const spon = stats.bySponsorship ?? {};
  const sponRows = $('sponRows');
  sponRows.textContent = '';
  const sponMax = Math.max(0, ...Object.values(spon).map((v) => v.count));
  const viable = (spon.Confirmed?.count ?? 0) + (spon.Likely?.count ?? 0);
  const unknown = (spon.Unconfirmed?.count ?? 0) + (spon.Unclassified?.count ?? 0);
  $('sponsorLead').textContent = `${fmt(viable)} confirmed or likely · ${fmt(unknown)} still unknown`;
  for (const key of SPONSORSHIP_SCALE) {
    const v = spon[key];
    if (!v) continue;
    sponRows.append(el('tr', {},
      el('td', {}, el('span', { class: `chip ${esc(key)}`, text: key })),
      el('td', { class: 'r' }, el('span', { class: 'num-with-bar' },
        el('span', { class: 'n', text: fmt(v.count) }), bar(v.count, sponMax))),
      el('td', { class: 'r' }, el('b', { class: v.strong > 0 ? 'yield-on' : 'yield-off', text: fmt(v.strong) }))));
  }

  renderDailyTrend(stats.daily ?? []);
  renderNextActions(stats.nextActions ?? []);
}

/* ─────────────────────── next actions ───────────────────────
 * This was six identical blue sentences in a bulleted list.
 *
 * Three things were wrong with that, and they compound:
 *
 *  1. It RESTATED the tabs. "179 prepared packet(s) await your approval" is the
 *     Needs review tab; "20 blocked" is Needs you; "224 strong-fit… no decision"
 *     is Best matches; "249 … sponsorship check" is the verify-sponsor chip.
 *     Four of six items repeated a number sitting 200px away, in a third visual
 *     language — the exact thing the nine-tile metric strip was deleted for.
 *  2. The COUNT — the only scannable thing in each line — was buried mid-
 *     sentence in link-coloured prose, so nothing could be skimmed.
 *  3. The order of this list is a real priority ranking, and rendering every
 *     item identically threw that away.
 *
 * So: the top-ranked action is PROMOTED (its count set as a figure, its verb as
 * the headline, its guidance kept underneath, and an explicit button), the rest
 * become one scannable line each with counts right-aligned in a fixed column,
 * and notices about the tool rather than the jobs are separated out entirely.
 * Verb-first phrasing is what keeps this panel answering a different question
 * from the tabs: they say where the work IS, this says what to DO first.
 */
function actionButton(action, className) {
  const attrs = { class: className, type: 'button' };
  if (action.filter) {
    attrs['data-action'] = 'metric-filter';
    attrs['data-filter'] = JSON.stringify(action.filter);
  } else {
    // A system notice has no board filter; its action is to run discovery.
    attrs['data-action'] = 'run';
    attrs['data-phase'] = 'discover';
  }
  // The composed sentence is the accessible name, so a screen reader still gets
  // the full guidance rather than "179, Approve prepared packets".
  attrs['aria-label'] = action.text;
  return el('button', attrs);
}

function renderNextActions(list) {
  const host = $('nextActions');
  host.textContent = '';
  host.append(el('h2', { text: 'Next' }));

  const jobs = list.filter((a) => a.kind !== 'system');
  const notices = list.filter((a) => a.kind === 'system');

  if (!jobs.length && !notices.length) {
    host.append(el('div', { class: 'muted', text: 'All caught up — nothing waiting on you.' }));
    return;
  }

  const [first, ...rest] = jobs;
  if (first) {
    const primary = actionButton(first, 'na-primary');
    primary.append(el('span', { class: 'na-count', text: fmt(first.count) }));
    const body = el('span', { class: 'na-body' });
    body.append(el('b', { text: first.verb }));
    body.append(el('span', { class: 'na-detail', text: first.detail }));
    primary.append(body);
    primary.append(el('span', { class: 'na-go', 'aria-hidden': 'true', text: '→' }));
    host.append(primary);
  }

  if (rest.length) {
    const ul = el('ul', { class: 'na-list' });
    for (const action of rest) {
      const button = actionButton(action, 'na-row');
      button.append(el('span', { class: 'na-n', text: fmt(action.count) }));
      button.append(el('span', { class: 'na-verb', text: action.verb }));
      button.append(el('span', { class: 'na-go', 'aria-hidden': 'true', text: '→' }));
      button.title = action.detail;
      ul.append(el('li', {}, button));
    }
    host.append(ul);
  }

  // Not a queue of jobs — a fact about the tool. Kept visually apart so it does
  // not read as "the fifth most important job to work on".
  for (const notice of notices) {
    const note = el('div', { class: 'na-note' });
    note.append(el('span', { class: 'na-note-text', text: notice.detail }));
    const run = actionButton(notice, 'small');
    run.append(notice.verb);
    note.append(run);
    host.append(note);
  }
}

/* ─────────────────── daily trend: small multiples ───────────────────
 * This was a four-column table, which is the wrong form twice over: the data's
 * job is CHANGE OVER TIME (a table makes you read seven numbers and hold the
 * shape in your head), and the three measures differ by three orders of
 * magnitude — a run finds thousands, prepares a handful, submits one or two.
 *
 * Plotting them together would need two y-axes, which is the single worst thing
 * a chart can do. Small multiples are the honest answer: one facet per measure,
 * each with its OWN scale, sharing the x axis. Each facet is a single series, so
 * identity comes from its title rather than from colour — no categorical
 * palette, no legend, and nothing for a colour-blind reader to tell apart.
 *
 * The numbers stay readable as a table for assistive tech and for anyone who
 * wants the exact figures.
 */
const TREND_FACETS = [
  { key: 'discovered', label: 'Found' },
  { key: 'prepared', label: 'Prepared' },
  { key: 'submitted', label: 'Submitted' },
];

/** One 7-point sparkline. Returns an <svg>, or null when there is nothing to draw. */
function sparkline(values, { width = 168, height = 30, pad = 4 } = {}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const span = max > 0 ? max : 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const y = (v) => height - pad - (v / span) * (height - pad * 2);
  const pts = values.map((v, i) => [pad + i * stepX, y(v)]);

  const svg = el('svg', {
    class: 'spark', viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
  });
  // A flat run of zeros is a real answer ("nothing happened"), so it draws a
  // baseline rather than disappearing.
  svg.append(el('polyline', {
    class: 'spark-line',
    points: pts.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(' '),
  }));
  // End marker carries a surface-coloured ring so it stays legible where the
  // line doubles back under it.
  const [lx, ly] = pts[pts.length - 1];
  svg.append(el('circle', { class: 'spark-end', cx: lx.toFixed(1), cy: ly.toFixed(1), r: '3.5' }));
  return svg;
}

function renderDailyTrend(daily) {
  const host = $('dailyTrend');
  host.textContent = '';
  if (!daily.length) {
    $('activityLead').textContent = 'No activity recorded yet.';
    host.append(el('div', { class: 'muted', text: 'No activity recorded yet.' }));
    return;
  }
  const days = daily.map((d) => d.day.slice(5));

  // The card's own question is "is the pipeline moving?", and the three facets
  // answer "by how much". How MANY of the last seven days saw anything at all
  // is the part neither facet shows: seven quiet days and one huge one average
  // out to a healthy-looking week.
  const activeDays = daily.filter((d) => (Number(d.discovered) || 0) > 0).length;
  $('activityLead').textContent = activeDays === daily.length
    ? `Discovery found something on all ${daily.length} of the last ${daily.length} days`
    : `Discovery found something on ${activeDays} of the last ${daily.length} days`;

  for (const facet of TREND_FACETS) {
    const values = daily.map((d) => Number(d[facet.key]) || 0);
    const latest = values[values.length - 1];
    const total = values.reduce((a, b) => a + b, 0);

    const row = el('div', { class: 'trend' });
    const head = el('div', { class: 'trend-head' });
    head.append(el('span', { class: 'trend-label', text: facet.label }));
    // The card promises "last 7 days", so the WEEK is the headline. Leading
    // with the latest day instead put a bold "0" at the top of every facet
    // first thing each morning — technically true and completely useless, with
    // the number that answers the question demoted to a footnote beside it.
    head.append(el('b', { class: 'trend-now', text: fmt(total) }));
    row.append(head);
    const chart = sparkline(values);
    if (chart) row.append(chart);
    row.append(el('span', { class: 'trend-sum', text: `${fmt(latest)} today` }));
    host.append(row);
  }

  // The exact figures, for a screen reader and for anyone who wants to read
  // rather than eyeball. `sr-only` rather than removed: a chart without its
  // numbers available is a chart that excludes people.
  const table = el('table', { class: 'sr-only' });
  table.append(el('caption', { text: 'Daily activity for the last 7 days' }));
  const head = el('tr', {}, el('th', { scope: 'col', text: 'Day' }));
  for (const facet of TREND_FACETS) head.append(el('th', { scope: 'col', text: facet.label }));
  table.append(el('thead', {}, head));
  const body = el('tbody', {});
  daily.forEach((d, i) => {
    const tr = el('tr', {}, el('th', { scope: 'row', text: days[i] }));
    for (const facet of TREND_FACETS) tr.append(el('td', { text: fmt(Number(d[facet.key]) || 0) }));
    body.append(tr);
  });
  table.append(body);
  host.append(table);
}

function bar(value, max) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const wrap = el('span', { class: 'mini', title: fmt(value) });
  const fill = el('i');
  fill.style.width = `${pct}%`;
  wrap.append(fill);
  return wrap;
}

/*
 * /api/stats reads the whole corpus — ~6s cold on a 120k-row store — and it
 * was fetched after EVERY click. It is now single-flight (concurrent callers
 * share one request) and throttled to once a minute, with a trailing refetch
 * so a burst of decisions still ends with fresh numbers. `force` is for the
 * moments the numbers are known to have moved a lot: boot and the end of a run.
 */
const STATS_MIN_INTERVAL_MS = 60_000;
let statsInFlight = null;
let statsFetchedAt = 0;
let statsTrailing = null;

function loadStats({ force = false } = {}) {
  if (statsInFlight) return statsInFlight;
  const wait = STATS_MIN_INTERVAL_MS - (Date.now() - statsFetchedAt);
  if (!force && wait > 0) {
    if (!statsTrailing) statsTrailing = setTimeout(() => { statsTrailing = null; loadStats(); }, wait);
    return Promise.resolve(state.stats);
  }
  clearTimeout(statsTrailing);
  statsTrailing = null;
  statsInFlight = fetchStats().finally(() => {
    statsInFlight = null;
    statsFetchedAt = Date.now();
  });
  return statsInFlight;
}

async function fetchStats() {
  const stats = await api('/api/stats');
  state.stats = stats;
  // Served from cache while the server recomputes: say so, and come back for
  // the real numbers shortly rather than waiting out the throttle.
  if (stats.stale) setTimeout(() => loadStats({ force: true }), 10_000);
  renderBoardStatus();
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

/**
 * "What is failing" — the only thing on the page that reads /api/sections —
 * lives inside the collapsed Discovery health disclosure, so it is fetched
 * only while that is open, and only the one section it draws. A server that
 * predates `?only=` returns everything, which reads the same.
 */
async function loadSections() {
  if ($('analytics').hidden) return;
  const sections = await api('/api/sections?only=blockedByReason').catch(() => null);
  if (!sections) return;
  const host = $('blockRows');
  host.textContent = '';
  const rows = sections.blockedByReason ?? [];
  const total = rows.reduce((sum, r) => sum + (Number(r.count) || 0), 0);
  $('blockLead').textContent = rows.length
    ? `${fmt(total)} job(s) stopped, across ${rows.length} distinct cause(s)`
    : 'Nothing is failing right now.';
  if (!rows.length) {
    host.append(el('tr', {}, el('td', { colspan: '2', class: 'muted', text: 'Nothing blocked' })));
    return;
  }
  for (const entry of rows) {
    host.append(el('tr', {},
      // These reasons come from live automation failures, so some are raw
      // driver messages ("field Start date year*: locator.fill: Error: Cannot
      // type text into input[type=nu…"). Unclamped, one of them set the height
      // of the whole card. Full text stays on hover and in the row itself.
      el('td', { class: 'clamp-2', title: entry.reason, text: entry.reason }),
      el('td', { class: 'r', text: fmt(entry.count) })));
  }
}

/* ──────────────────────────── board ──────────────────────────── */

let boardSeq = 0;

/**
 * One quiet line saying how fresh the board is. A 2px sweep along the top of
 * the table was the only sign a query was running, and nothing at all said
 * how old the numbers were — or that the server was serving cached ones.
 */
const boardStatus = { loading: false, updatedAt: 0 };

function renderBoardStatus() {
  const node = $('boardStatus');
  if (!node) return;
  const parts = [];
  if (boardStatus.loading) parts.push('Refreshing…');
  else if (boardStatus.updatedAt) {
    const secs = Math.round((Date.now() - boardStatus.updatedAt) / 1000);
    parts.push(secs < 5 ? 'Updated just now'
      : secs < 60 ? `Updated ${secs} s ago` : `Updated ${Math.floor(secs / 60)} min ago`);
  }
  if (state.stats?.stale) parts.push('Showing cached numbers — recalculating');
  node.textContent = parts.join(' · ');
  node.classList.toggle('busy', boardStatus.loading);
}
setInterval(renderBoardStatus, 10_000);

/** Reload the board page once, however many mutations asked for it. */
let boardReloadTimer = null;
function scheduleBoardReload(delay = 300) {
  clearTimeout(boardReloadTimer);
  boardReloadTimer = setTimeout(loadBoard, delay);
}

/**
 * How many columns a full-width message row must span.
 *
 * Counted from the header rather than written as a literal. Three separate
 * `colspan: '11'` literals had to be found and changed by hand every time a
 * column was added or removed, and a missed one silently narrows the empty
 * state to part of the table.
 */
const boardColSpan = () => String(document.querySelectorAll('#board thead th').length);

async function loadBoard() {
  const seq = ++boardSeq;
  const body = $('rows');
  if (!body.children.length) {
    body.append(el('tr', {}, el('td', { colspan: boardColSpan() },
      el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }))));
  }
  // Skeletons only appear on an EMPTY board, so every subsequent query showed
  // the previous result set, unchanged and unmarked, until it returned.
  // Measured: opening the "tracked" fact reads all 132,531 rows and takes ~7s,
  // during which the board silently displayed the wrong 100 jobs. Dimming the
  // stale rows and disabling their controls says "this is being replaced"
  // without the layout jump of throwing them away.
  $('boardwrap').dataset.loading = 'true';

  boardStatus.loading = true;
  renderBoardStatus();
  let page;
  try {
    // Slim rows: the board draws ~20 fields and the full row carries the
    // explanation, keyword lists, paths and signals (~2 KB each). The detail
    // rail fetches the full job by id when it opens one.
    const params = filterParams();
    params.set('fields', 'board');
    page = await api(`/api/jobs?${params}`);
  } catch (err) {
    if (seq !== boardSeq) return;
    boardStatus.loading = false;
    renderBoardStatus();
    $('boardwrap').dataset.loading = 'false';
    body.textContent = '';
    body.append(el('tr', {}, el('td', { colspan: boardColSpan(), class: 'empty', text: err.message })));
    $('pager').textContent = '';
    return;
  }
  if (seq !== boardSeq) return; // a newer request already won
  $('boardwrap').dataset.loading = 'false';
  boardStatus.loading = false;
  boardStatus.updatedAt = Date.now();
  renderBoardStatus();

  // The server may clamp the page (e.g. filters narrowed while on page 7).
  if (page.page && page.page !== state.page) state.page = page.page;

  state.visible = page.jobs.map((j) => j.id);
  for (const job of page.jobs) state.known.set(job.id, job);

  // Absent when no filter is active — the unfiltered stats counts are then the
  // right ones, so clearing this is what restores them.
  state.filteredViewCounts = page.viewCounts ?? null;

  renderRows(page.jobs);
  renderPager(page);
  renderTabs();
  syncSelectAll();
  renderActiveFilters();
}

/**
 * Remember which board control has focus, so a re-render can put it back.
 *
 * Every board reload replaced all 100 rows, so a keyboard user sitting on a
 * row — or on its checkbox — was dropped onto <body> by a refresh they did not
 * cause. Recorded by job id and control, never by node, because the nodes are
 * the thing being replaced.
 */
function captureRowFocus() {
  const active = document.activeElement;
  const row = active?.closest?.('#rows tr.job');
  if (!row) return null;
  return {
    id: row.dataset.id,
    action: active === row ? null : active.dataset?.action ?? null,
    index: [...$('rows').querySelectorAll('tr.job')].indexOf(row),
  };
}

function restoreRowFocus(spec) {
  if (!spec) return;
  const rows = [...$('rows').querySelectorAll('tr.job')];
  // The focused job may have left the page (rejected, filtered out): the row
  // now in its position is where a keyboard user expects to be.
  const row = rows.find((tr) => tr.dataset.id === spec.id) ?? rows[Math.min(spec.index, rows.length - 1)];
  if (!row) { $('boardwrap').focus({ preventScroll: true }); return; }
  const target = row.dataset.id === spec.id && spec.action
    ? row.querySelector(`[data-action="${cssEscape(spec.action)}"]`) : null;
  (target ?? row).focus({ preventScroll: true });
}

function renderRows(jobs) {
  const body = $('rows');
  const focus = captureRowFocus();
  body.textContent = '';

  if (!jobs.length) {
    const tracked = state.stats?.totals?.jobsTracked ?? 0;
    const cell = el('td', { colspan: boardColSpan() });
    const box = el('div', { class: 'empty' });
    box.append(el('div', { class: 'big', text: tracked === 0 ? 'No jobs yet' : 'Nothing matches these filters' }));
    if (tracked === 0) {
      box.append('Run ', el('b', { text: 'Find new jobs' }), ' to discover and score postings.');
    } else {
      const actions = el('div', { class: 'row-gap empty-actions' });
      actions.append(el('button', { class: 'small', 'data-action': 'reset-filters', text: 'Reset filters' }));
      // THE MOMENT THE ESCALATION IS ACTUALLY WANTED. "Nothing here matches
      // what I typed" is precisely when someone wants to ask the job boards
      // for it, and the only thing offered was to clear the search that had
      // just failed them. `data-query` carries the phrase, so the dialog opens
      // on it rather than empty.
      const query = $('q').value.trim();
      if (query) {
        actions.append(el('button', {
          class: 'small primary', 'data-action': 'open-job-search', 'data-query': query,
          text: `Search job boards for “${query}”`,
        }));
      }
      box.append(actions);
    }
    cell.append(box);
    body.append(el('tr', {}, cell));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const job of jobs) frag.append(rowFor(job));
  body.append(frag);
  restoreRowFocus(focus);
}

function rowFor(job) {
  const selected = job.id === state.selectedId;
  // `aria-selected` is only meaningful on a row inside a grid/treegrid. This is
  // a plain table, so it was invalid ARIA on all 100 rows — and it described
  // the wrong thing anyway: the highlighted row is the one whose detail is
  // open, not one of a multi-select (that is the checkbox). `aria-current` is
  // valid anywhere and says exactly that.
  const tr = el('tr', {
    class: 'job',
    'data-id': job.id,
    'data-action': 'select',
    ...(selected ? { 'aria-current': 'true' } : {}),
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

  // grade + score. The letter alone carries no meaning to a screen reader —
  // "A" is a letter, not a verdict — and the label explaining it ("Excellent
  // fit") lived only in a tooltip.
  const grade = job.grade;
  tr.append(el('td', {},
    el('span', {
      class: `grade ${grade ? grade.letter : 'none'}`,
      role: 'img',
      'aria-label': grade ? `grade ${grade.letter}, ${grade.label}, score ${job.score}` : 'not scored yet',
      title: grade ? `${grade.label} · score ${job.score}` : 'Not scored yet',
      text: grade ? grade.letter : '—',
    }),
    el('div', { class: 'faint', 'aria-hidden': 'true', text: job.score ?? '—' })));

  tr.append(nameCellFor(job));

  // sponsorship — the badge carries its own evidence, so a claim as consequential
  // as "Confirmed" can be checked on hover instead of taken on trust.
  tr.append(el('td', { 'data-label': 'Sponsor' }, el('span', {
    class: `chip ${esc(job.sponsorship ?? '')}`,
    title: sponsorshipTitle(job),
    text: job.sponsorship ?? '—',
  })));

  // posted
  // The dot is a coloured 7px circle with no text: a `title` on an empty span is
  // announced inconsistently at best, so the confidence of a posting date —
  // which decides whether the date can be trusted at all — reached neither a
  // screen reader nor a touch user. `role="img"` + a label makes it a real
  // graphic with a real name.
  const postedCell = el('td', { class: 'nowrap', 'data-label': 'Posted' },
    el('span', {
      class: `dot ${job.postedConfidence}`,
      role: 'img',
      'aria-label': `posting date ${job.postedConfidence}`,
      title: `Posting date ${job.postedConfidence}`,
    }),
    job.postedLabel);
  if (job.postedLast24h) postedCell.append(' ', el('span', { class: 'chip good', text: 'new' }));
  tr.append(postedCell);

  // found — when THIS agent first discovered the job, which is a different
  // question from when the employer posted it. A months-old posting can be a
  // brand-new find (a board was only just added), and that is exactly the row
  // a user checking "what did the last run turn up?" wants to see.
  tr.append(el('td', { class: 'nowrap', 'data-label': 'Found', title: job.createdAt ?? '' },
    relTime(job.createdAt) || '—'));

  // resume — one click straight to the tailored document.
  //
  // The state chip and a separate 👁 button used to sit side by side, needing
  // 112px in a 96px column, so the button was clipped away by the cell's own
  // overflow. They said the same thing anyway: the chip names the state, the
  // button opened the document that state refers to. One control now does
  // both — narrower, and a 60px click target instead of a 22px one.
  const label = job.resumeStatus === 'tailored' ? 'tailored'
    : job.resumeStatus === 'prepared' ? 'packet' : '—';
  // Slim board rows may carry a `hasResumeDoc` flag instead of the file paths
  // (paths are detail-only data); either one means there is something to open.
  const hasDoc = Boolean(job.hasResumeDoc ?? (job.resumeDocxPath || job.resumePdfPath));
  tr.append(el('td', { class: 'nowrap', 'data-label': 'Resume' }, hasDoc
    ? el('button', {
      class: `rs ${job.resumeStatus} rs-open`, 'data-action': 'preview-resume', 'data-id': job.id,
      title: 'Preview the tailored resume',
      'aria-label': `Preview tailored resume for ${job.company ?? ''} ${job.title ?? ''}`.trim(),
      text: label,
    })
    : el('span', { class: `rs ${job.resumeStatus}`, text: label })));

  // WHY a job is blocked/discarded/skipped was carried only by a `title=`
  // tooltip plus a bare ⓘ glyph — invisible on touch, unreliable for screen
  // readers, and the single most useful thing in the column. It is now real
  // text, clamped to one line so the row height stays stable.
  //
  // Progress lives here too. As its own column it was an unlabelled 80px bar
  // that only made sense once you had read the status beside it, so the two
  // were always read together while being laid out apart.
  const statusCell = el('td', { class: `st-${job.appStatus}`, 'data-label': 'Status' });
  statusCell.append(statusLabel(job));
  const bar = progressBar(job.progress);
  if (bar) statusCell.append(bar);
  if (job.statusReason) {
    statusCell.append(el('div', {
      class: 'statusreason', title: job.statusReason, text: job.statusReason,
    }));
  }
  tr.append(statusCell);

  // The card layout sets `display: block/flex` on these cells, which drops
  // their implicit `cell` role in every engine. Stating it keeps the board a
  // table for assistive tech at every width.
  for (const cell of tr.children) cell.setAttribute('role', 'cell');
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
  let aggChip = null;
  const title = String(job.title ?? '').trim() || 'Title not identified';
  const shown = title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : title;

  // Only an absolute http(s) URL becomes a link; anything else (a feed that
  // handed us `javascript:` or a bare path) is rendered as plain text.
  const href = safeHref(job.url);
  if (href) {
    const aggregator = isAggregatorUrl(job.url);
    const link = el('a', {
      class: 'rolelink',
      href,
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
      // Sits on the META line, not on a line of its own under the role. It
      // qualifies where the link GOES, which is the same kind of fact as the
      // company and location it now sits beside — and a standalone line per
      // aggregator row cost a third of the row height on 48% of the board.
      aggChip = el('span', {
        class: 'chip agg',
        title: 'Aggregator listing — follow Apply through to the employer site, then save that direct URL here.',
        text: hostLabel(job.url),
      });
    }
  } else {
    // No URL means nothing to open — say so rather than render a dead link.
    cell.append(el('span', { class: 'rolelink none', title, text: shown }));
  }

  const meta = el('div', { class: 'namemeta' });
  meta.append(el('span', { class: 'co', text: job.company || 'Company on posting' }));
  if (job.remote) meta.append(' ', el('span', { class: 'rs', text: 'remote' }));
  if (job.location) meta.append(el('span', { class: 'faint', text: ` · ${job.location}` }));
  // WHERE YOU WILL APPLY — one slot, because the two facts are alternatives,
  // not additions. An aggregator listing has no employer ATS to name, and a
  // row that goes straight to Workday is not an aggregator. Naming whichever
  // one applies replaces a whole 92px column that read "—" on most rows.
  if (aggChip) meta.append(' ', aggChip);
  else if (job.atsPlatform) {
    meta.append(' ', el('span', {
      class: 'chip ats-flag',
      title: `Applications for this job are handled by ${job.atsPlatform}`,
      text: job.atsPlatform,
    }));
  }
  // Employment type, but only when it is worth a reader's attention. It had a
  // column of its own that said "Full-time" on almost every row — 85px of width
  // spent restating the default. Contract/part-time genuinely changes whether a
  // job is worth applying to, so THAT is what gets shown, next to the company
  // it qualifies rather than in a column of its own.
  const exception = typeException(job);
  if (exception) meta.append(' ', exception);
  cell.append(meta);
  return cell;
}

/** Employment types worth calling out; full-time and unknown are the silent default. */
const NOTABLE_TYPES = { contract: 'contract', contract_to_hire: 'contract→hire', part_time: 'part-time' };

/**
 * A chip for a non-standard employment type, or null when there is nothing to
 * say. Returning null is the point: the old `typeChip` always rendered
 * something, including a bare "—" for the 'unknown' case.
 */
function typeException(job) {
  const label = NOTABLE_TYPES[job.employmentCategory];
  if (!label) return null;
  return el('span', {
    class: 'chip bad type-flag',
    title: `Employment type: ${job.employmentLabel ?? job.employmentCategory}`,
    text: label,
  });
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

/**
 * The sponsorship verdict AND the words it was read from, as real text.
 *
 * This was a `title=` tooltip and nothing else — reachable only by hovering a
 * mouse over a chip, so on a touch screen or with a screen reader the most
 * consequential claim on the board ("does this employer sponsor?") had no
 * evidence attached at all. That is exactly the shape of the failure this
 * tooltip was added for: six rows once showed a green "Confirmed" while their
 * postings said the role was not eligible for sponsorship, and only a hover
 * could reveal it. A verdict a user is expected to act on has to show its work
 * where the user is looking.
 */
function sponsorshipEvidence(job) {
  const wrap = el('div', {});
  const verdict = job.sponsorship ?? 'unknown';
  wrap.append(el('div', { class: 'chiprow' },
    el('span', { class: `chip ${esc(job.sponsorship ?? '')}`, text: verdict }),
    job.sponsorshipGated
      ? el('span', { class: 'chip warn', text: 'parked until you verify' })
      : ''));

  const signals = job.sponsorshipSignals ?? [];
  if (signals.length) {
    wrap.append(el('div', { class: 'muted evidence-label', text: 'Read from the posting:' }));
    const list = el('ul', { class: 'plan evidence-quotes' });
    for (const signal of signals) list.append(el('li', {}, el('q', { text: signal })));
    wrap.append(list);
  } else if (job.sponsorship) {
    wrap.append(el('div', { class: 'muted', text: 'No recorded evidence — re-score this job to capture it.' }));
  }
  if (job.sponsorship === 'Denied') {
    wrap.append(el('div', { class: 'attention' },
      el('span', { class: 'mark', text: '!' }),
      el('div', { text: 'The posting explicitly refuses sponsorship.' })));
  }
  return wrap;
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
  // Deliberately NOT "Scored". These rows arrived as a title with no
  // description, so nothing has judged them; folding them into "Scored" put
  // 5,029 unread jobs inside a tile of 5,175.
  needs_description: 'Description not fetched',
  ready_for_submit: 'Ready for your review',
  needs_review: 'Review resume',
  approved: 'Ready to auto-fill',
  submitted: 'Submitted',
  submit_unverified: 'Verify submission',
  date_unconfirmed: 'Date unconfirmed',
  blocked: 'Needs you',
  failed: 'Failed',
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
  announceBoard(page);
}

/**
 * Say out loud what the board now holds.
 *
 * Debounced, and silent when the count has not moved: every keystroke in the
 * search box reloads the board, and a live region that repeats "1,204 jobs"
 * five times while you type is worse than one that says nothing.
 */
let announceTimer = null;
let lastAnnounced = null;
function announceBoard(page) {
  const tab = TABS.find(([key]) => key === state.activeTab);
  const scope = state.activeTab === 'all' ? '' : ` in ${tab ? tab[1] : state.activeTab}`;
  const filters = hasActiveFilters() ? ', filtered' : '';
  const message = page.total === 0
    ? `No jobs match${scope ? ` ${scope.trim()}` : ''}${filters}.`
    : `${fmt(page.total)} job${page.total === 1 ? '' : 's'}${scope}${filters}.`;
  if (message === lastAnnounced) return;
  lastAnnounced = message;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { $('boardAnnounce').textContent = message; }, 500);
}

/* ──────────────────────── detail rail ──────────────────────── */

/**
 * Narrow layouts show the detail in a sheet; wide ones in the sticky rail.
 *
 * At <=1240px the page is one column, and the rail used to land UNDER the
 * whole board: selecting a row changed something ~7,000px below the viewport
 * and nothing on screen. The sheet opens where the user is looking.
 */
const SHEET_QUERY = matchMedia('(max-width: 1240px)');
const isSheetLayout = () => SHEET_QUERY.matches;

let selectTimer = null;

/** Mark the open job's row, and only that row. */
function markCurrentRow(id) {
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
async function selectJob(id, { focusRow = false, user = false, defer = 0 } = {}) {
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

async function loadDetail(id) {
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

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

/** The element that scrolls the detail: the sheet body, or the sticky rail. */
function railScroller() {
  const sheet = $('dlgDetail');
  return sheet?.open ? $('dlgDetailBody') : document.querySelector('.rail-sticky');
}

/** Put #detail wherever the current layout shows it. */
function placeDetail() {
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
let sheetReturnId = null;

function openDetailSheet(id) {
  const sheet = $('dlgDetail');
  sheetReturnId = id;
  placeDetail();
  if (!sheet.open) sheet.showModal();
  // Focus goes to the sheet's heading, not its first button: landing on
  // "Open posting" or "Reject" is one Enter away from an action nobody chose.
  $('dlgDetailTitle').focus();
}

/** The control that represents a job wherever it is currently visible. */
function jobAnchor(id) {
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
const railSection = (key, ...children) => el('div', { class: 'rail-sec', 'data-section': key }, ...children);

function renderDetail(job) {
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
function keepSection(node, key) {
  return node.contains(document.activeElement) || (key === 'notes' && note.isDirty());
}

/** Re-apply the open/closed state of keyed <details> to their replacement. */
function carryOpenDetails(from, to) {
  for (const open of from.querySelectorAll('details[data-key][open]')) {
    to.querySelector(`details[data-key="${cssEscape(open.dataset.key)}"]`)?.setAttribute('open', '');
  }
}

function reconcileDetail(panel, sections) {
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
function verdictLabel(job) {
  return job.grade?.label ?? fitLabel(job.fit);
}

function detailSections(job) {
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

const NOTE_DEBOUNCE_MS = 1200;

const note = {
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

function notesEditor(job) {
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

function setNoteStatus(kind, detail = '') {
  const node = $('noteStatus');
  if (!node) return;
  const text = {
    saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: `Couldn’t save — ${detail}`,
  }[kind] ?? '';
  node.textContent = text;
  node.className = `note-status ${kind === 'error' ? 'st-blocked' : kind === 'dirty' ? 'warn-text' : 'faint'}`;
}

async function saveNote() {
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
function flushNote() {
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
const DECISION_REASONS = [
  ['salary', 'Salary'], ['location', 'Location'], ['seniority', 'Seniority'],
  ['sponsorship', 'Sponsorship'], ['stack', 'Stack'], ['company', 'Company'],
  ['stale', 'Stale'], ['other', 'Other'],
];
const reasonLabel = (key) => DECISION_REASONS.find(([k]) => k === key)?.[1] ?? String(key ?? '');

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
  for (const button of buttons) if (button) row.append(button);
  box.append(row);
  return box;
}

const autofillButton = (id, label = '⚡ Auto-fill application') => {
  const blocked = autofillBlockedReason();
  return el('button', {
    class: 'small primary', 'data-action': 'autofill-one', 'data-id': id,
    disabled: Boolean(blocked),
    title: blocked ?? 'Prepare a packet if needed, approve it, open the posting, fill everything it can — and stop before Submit.',
    text: label,
  });
};

/** Where the filler's inputs live — offered wherever an auto-fill can stall. */
const setupLinks = () => [
  el('button', { class: 'small ghost', 'data-action': 'open-profile', title: 'What the filler types, and how it answers form questions', text: '👤 Application profile' }),
  el('button', { class: 'small ghost', 'data-action': 'open-master', title: 'The resume every tailored version is built from', text: '🧾 Master resume' }),
];

function actionPlan(job) {
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

/**
 * Where focus goes back to when each dialog closes.
 *
 * One shared variable was enough while dialogs never stacked. The detail sheet
 * now opens others on top of itself (Replace URL, I submitted it myself), and
 * the second dialog overwrote the first's return point, so closing the sheet
 * sent focus into a closed dialog. Each dialog now remembers its own.
 */
const lastFocused = new WeakMap();

function openDialog(dialog) {
  // Opened from a menu item: that item is about to be hidden with its menu, so
  // the menu's trigger is where focus should come back to.
  const from = document.activeElement;
  const menu = from?.closest?.('.menu-pop');
  if (!dialog.open) lastFocused.set(dialog, menu ? menuTrigger(menu) ?? from : from);
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
  const dialog = event.target;
  if (dialog.tagName !== 'DIALOG') return;
  if (dialog.id === 'dlgDetail') {
    // Back to the job the sheet showed, wherever it is on screen now (the row
    // may have been re-rendered while the sheet was open).
    (sheetReturnId && jobAnchor(sheetReturnId))?.focus();
    return;
  }
  const back = lastFocused.get(dialog);
  if (back?.isConnected) back.focus?.();
}, true);

// Clicking the backdrop (outside the panel) closes the dialog.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

/** What "Continue" in the confirm dialog will do; consumed exactly once. */
let pendingConfirm = null;

function confirmAction(message, onConfirm) {
  $('confirmBody').textContent = '';
  for (const line of String(message).split('\n')) {
    $('confirmBody').append(el('p', { class: line.startsWith('  ') ? 'muted' : '', text: line.trim() }));
  }
  // Held in a variable rather than wired by cloning the button: the form's one
  // submit handler runs it, so Enter and a click behave identically and a
  // double submit finds nothing left to run.
  pendingConfirm = onConfirm;
  openDialog($('dlgConfirm'));
}

async function runPendingConfirm() {
  const fn = pendingConfirm;
  pendingConfirm = null;
  closeDialog($('dlgConfirm'));
  if (fn) await fn();
}

/* ───────────────────── mutations + refresh ───────────────────── */

let refreshTimer = null;

/**
 * After a mutation: the board page, and the numbers when the throttle allows.
 *
 * This used to be a full `refreshAll` — stats, board, sections, profile and
 * the detail again — after every click: seven requests for one decision, one
 * of them a ~6s whole-corpus read. The row and the rail are patched from the
 * mutation's own response; the board page is reloaded to pick up anything that
 * moved in or out of the current filter.
 */
function scheduleRefresh(delay = 350) {
  scheduleBoardReload(delay);
  loadStats();
  if (state.view === 'today') scheduleTodayReload(delay);
}

/**
 * Everything, e.g. at boot, after a run, or on a long-idle tab.
 * @param {{ force?: boolean }} [options] bypass the stats throttle
 */
async function refreshAll({ force = false } = {}) {
  clearTimeout(refreshTimer);
  await Promise.allSettled([loadStats({ force }), loadBoard(), loadToday()]);
  loadSections();
  // A prepare/re-tailor run replaces the packet and its tailoring audit on
  // disk. Refresh the open detail rail too; otherwise it keeps displaying the
  // packet object fetched before the run and makes regeneration look inert.
  // (Reconciled, not rebuilt — see renderDetail.)
  if (state.selectedId) await selectJob(state.selectedId);
}

/** Update one row's derived fields locally so the UI responds immediately. */
function patchRow(id, patch) {
  const known = state.known.get(id);
  if (known) state.known.set(id, { ...known, ...patch });
  const tr = $('rows').querySelector(`tr.job[data-id="${cssEscape(id)}"]`);
  if (tr && known) {
    const focus = captureRowFocus();
    tr.replaceWith(rowFor({ ...known, ...patch }));
    restoreRowFocus(focus);
  }
}

/** The status a decision will produce, for the optimistic row update. */
const DECISION_STATUS = { shortlisted: 'shortlisted', rejected: 'rejected', archived: 'archived' };

/** Apply a decision's result to the row and the open rail without a refetch. */
function applyDecisionLocally(id, patch) {
  // A closed job's old blocker is no longer "what to do next" — clearing
  // attention stops a rejected row still reading "Retry needed".
  const full = { attention: null, ...patch };
  patchRow(id, full);
  if (state.detailJob?.id === id) {
    state.detailJob = { ...state.detailJob, ...full };
    renderDetail(state.detailJob);
  }
}

async function decide(id, decision) {
  const known = state.known.get(id);
  const before = { appStatus: known?.appStatus, userDecision: known?.userDecision ?? null, attention: known?.attention ?? null };
  // Optimistic: the click shows its result at once, and is rolled back if
  // the server refuses it.
  if (DECISION_STATUS[decision]) applyDecisionLocally(id, { appStatus: DECISION_STATUS[decision], userDecision: decision });
  try {
    const result = await postJson(`/api/jobs/${encodeURIComponent(id)}/decision`, { decision });
    if (decision === 'clear') {
      // Clearing returns a job to whatever it was before — only the server
      // knows that, so this one case re-reads the job.
      patchRow(id, { appStatus: result.appStatus, userDecision: result.userDecision });
      if (state.selectedId === id) loadDetail(id);
    } else {
      applyDecisionLocally(id, { appStatus: result.appStatus ?? DECISION_STATUS[decision], userDecision: result.userDecision ?? decision });
    }
    announceDecision(id, decision, before.userDecision ?? 'clear');
    scheduleRefresh();
  } catch (err) {
    if (DECISION_STATUS[decision] && before.appStatus) applyDecisionLocally(id, before);
    toast(err.message, 'bad');
  }
}

async function simpleAction(id, action, okMessage) {
  try {
    await postJson(`/api/jobs/${encodeURIComponent(id)}/${action}`);
    toast(okMessage, 'good');
    // Approve / reject-packet change the packet, which only the detail
    // payload carries — one job re-read, reconciled into the rail.
    if (state.selectedId === id) loadDetail(id);
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
  if (autofillBlockedReason()) { toast(autofillBlockedReason(), 'bad'); return; }
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
    state.linkHealth.set(id, { tone, text });
    if (box) { box.className = `linkhealth ${tone}`.trim(); box.textContent = text; }
    // Always surface it as a toast too: the inline slot only exists while the
    // detail rail is open, and the old build silently dropped the result.
    toast(text, tone);
  } catch (err) {
    state.linkHealth.set(id, { tone: 'bad', text: err.message });
    if (box) { box.className = 'linkhealth bad'; box.textContent = err.message; }
    toast(err.message, 'bad');
  }
}

/** Confirm a single decision (replaced by the undo toast in the Today work). */
function announceDecision(_id, decision) {
  toast(decision === 'clear' ? 'Decision cleared' : `Marked ${decision}`, 'good');
}

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

const VIEWS = ['today', 'board'];

function setView(view, { save = true } = {}) {
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

let todayInFlight = null;
let todayTimer = null;

function scheduleTodayReload(delay = 350) {
  clearTimeout(todayTimer);
  todayTimer = setTimeout(loadToday, delay);
}

function loadToday() {
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
function derivedNextAction(row) {
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

function derivedReason(row) {
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

const BROWSER_NOTICE = {
  code: 'browser_unavailable',
  severity: 'error',
  message: 'Auto-fill can’t start: the Playwright browser isn’t installed.',
  fix: 'Run `npx playwright install chromium` in the JobAgent folder, then retry.',
};
const BROWSER_MISSING = /Executable doesn't exist|playwright install/i;

async function deriveToday() {
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

function setSystemNotices(list) {
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
  if (changed) {
    // Every Auto-fill control reads this flag; redraw the ones on screen.
    syncSelectionBar();
    if (state.detailJob) renderDetail(state.detailJob);
    renderToday();
  }
}

/** Render a `fix` string, setting `code` spans as code with a Copy button. */
function fixLine(fix) {
  const line = el('div', { class: 'notice-fix' });
  const parts = String(fix ?? '').split(/`([^`]+)`/);
  parts.forEach((part, i) => { if (part) line.append(i % 2 ? el('code', { text: part }) : part); });
  const command = parts[1];
  if (command) {
    line.append(' ', el('button', {
      type: 'button', class: 'small ghost', 'data-action': 'copy-text', 'data-text': command,
      'aria-label': `Copy the command ${command}`, text: 'Copy',
    }));
  }
  return line;
}

function renderNotices() {
  const host = $('systemNotices');
  host.textContent = '';
  for (const notice of state.systemNotices ?? []) {
    host.append(el('div', { class: `notice ${notice.severity === 'error' ? 'is-error' : 'is-warn'}`, role: 'status' },
      el('span', { class: 'notice-mark', 'aria-hidden': 'true', text: '!' }),
      el('div', { class: 'notice-body' },
        el('b', { text: notice.message }),
        notice.fix ? fixLine(notice.fix) : null)));
  }
}

/** Why an Auto-fill control is unavailable, or null when it can be used. */
function autofillBlockedReason() {
  return state.browserUnavailable
    ? 'Auto-fill can’t start until the Playwright browser is installed — see the notice at the top of the page.'
    : null;
}

/* ── cards ── */

function renderToday() {
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

function todayCard(item) {
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
async function todayAct(target) {
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

/** Check id -> the control that fixes it. */
const SETUP_FIX = {
  browser: { kind: 'copy' },
  profile: { action: 'open-profile', label: 'Open application profile' },
  'profile-placeholders': { action: 'open-profile', label: 'Open application profile' },
  'profile-active': { action: 'open-master', label: 'Open master resume' },
  resume: { action: 'open-master', label: 'Open master resume' },
};

async function loadHealthChecks() {
  try { state.health = await api('/api/health'); } catch { return; }
  setSystemNotices(state.today?.systemNotices ?? []);
  renderSetupChecklist();
}

function renderSetupChecklist() {
  const host = $('setupChecklist');
  if (!host) return;
  host.textContent = '';
  const failing = (state.health?.checks ?? []).filter((c) => c.status === 'fail');
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
  const blocked = autofillBlockedReason();
  autofill.disabled = n === 0 || state.running || Boolean(blocked);
  autofill.title = blocked ?? (state.running
    ? 'A run is in progress — wait for it to finish'
    : 'Prepare if needed, approve, open each posting, and fill it — always stopping before Submit.');
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
  if (autofillBlockedReason()) { toast(autofillBlockedReason(), 'bad'); return; }
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

/**
 * Bulk shortlist / reject / archive, with a way back.
 *
 * Rejecting forty jobs is one click and, until now, had no recovery path at
 * all: the previous decision was overwritten and the selection was cleared in
 * the same breath, so a mis-click cost a manual pass through forty rows. Each
 * job's OWN prior decision is captured first — a single "clear" would not undo
 * this, because the selection routinely mixes already-shortlisted rows with
 * untouched ones, and clearing would silently discard the shortlist too.
 */
async function batchDecide(decision) {
  const ids = [...state.selected];
  if (!ids.length) return;
  // Read the prior state BEFORE the write, from the rows already in memory.
  const before = new Map(ids.map((id) => [id, state.known.get(id)?.userDecision ?? 'clear']));
  try {
    const result = await postJson('/api/decide-batch', { jobIds: ids, decision });
    clearSelection();
    scheduleRefresh(0);
    const done = new Set(result.updated);
    offerUndo(`Marked ${result.updated.length} as ${decision}`,
      new Map([...before].filter(([id]) => done.has(id))));
  } catch (err) { toast(err.message, 'bad'); }
}

/**
 * A toast that carries an Undo button for `wasDecision` (job id -> prior value).
 *
 * Restoring is grouped by prior value so N jobs cost one request per DISTINCT
 * previous decision — typically one or two — rather than one per job.
 */
function offerUndo(message, wasDecision) {
  if (!wasDecision.size) { toast(message, 'good'); return; }
  const groups = new Map();
  for (const [id, was] of wasDecision) {
    if (!groups.has(was)) groups.set(was, []);
    groups.get(was).push(id);
  }
  const node = el('div', { class: 'toast good undo-toast' }, el('span', { text: message }));
  const button = el('button', { class: 'small', type: 'button', text: '↩ Undo' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      for (const [was, list] of groups) {
        await postJson('/api/decide-batch', { jobIds: list, decision: was });
      }
      node.remove();
      toast(`Restored ${wasDecision.size} job(s)`, 'good');
      scheduleRefresh(0);
    } catch (err) {
      button.disabled = false;
      toast(`Could not undo: ${err.message}`, 'bad');
    }
  });
  node.append(button);
  $('toasts').append(node);
  // Longer than an ordinary toast: an undo you cannot reach is not an undo.
  setTimeout(() => node.remove(), 12000);
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
async function renderResumeSuggestions(body) {
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
function selectedAdoptTitles() {
  return [...document.querySelectorAll('[data-adopt-title]')]
    .filter((i) => i.checked)
    .map((i) => i.dataset.adoptTitle);
}

async function adoptResumeSelection({ titles = [], skills = [] } = {}) {
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
async function renderSearchProfiles(body) {
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
async function openMergePicker() {
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
async function submitMergeSelection() {
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
async function reconsiderResumeChoice() {
  try {
    await postJson('/api/search-profiles/acknowledge-resume', { clear: true });
    await renderMasterResume();
  } catch (err) { toast(err.message, 'bad'); }
}

/** POST one of the three resume choices, then re-render the drawer. */
async function chooseResumeProfile(choice, extra = {}) {
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

/* ─────────────────── application profile + question queue ─────────────────── */

/**
 * The profile page has three commitments, so it has three save buttons: the
 * details form, one queued question at a time, and the saved-answer list. A
 * single "Save" spanning all three would leave it unclear what a click writes.
 */
async function openProfile() {
  const body = $('profileBody');
  body.textContent = '';
  body.append(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  profileMessage('');
  openDialog($('dlgProfile'));
  await renderProfile();
}

function profileMessage(text, tone = 'muted') {
  const node = $('profileMsg');
  node.className = `grow-1 ${tone}`;
  node.textContent = text;
}

async function renderProfile() {
  const body = $('profileBody');
  let data;
  try { data = await api('/api/profile'); }
  catch (err) {
    body.textContent = '';
    body.append(el('div', { class: 'st-blocked', text: err.message }));
    return;
  }
  state.profile = data;
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
  renderHealthProfileFlag();
}

/** The work: questions a real form asked that the filler could not answer. */
function renderQuestionQueue(queue) {
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
function renderProfileFields(profile) {
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
    cell.append(el('input', {
      type: field.type === 'url' ? 'url' : 'text',
      id: `pf-${field.field}`, 'data-path': field.path, value: field.value ?? '',
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
  section.append(form);
  return section;
}

/** The answers already in config, editable and deletable. */
function renderSavedAnswers(screening) {
  const section = el('section', { class: 'pf-section', id: 'pfAnswers' });
  const wrap = el('details', { class: 'pf-saved' });
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
    row.append(el('textarea', { rows: '2', id: answerId, 'data-a-answer': entry.id }, entry.answer ?? ''));
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
const splitPatterns = (value) => String(value ?? '').split('|').map((p) => p.trim()).filter(Boolean);

async function saveProfileDetails() {
  const values = {};
  for (const input of $('profileBody').querySelectorAll('[data-path]')) {
    values[input.dataset.path] = input.value;
  }
  profileMessage('Saving…');
  try {
    const result = await postJson('/api/profile', { values });
    profileMessage(result.warning ?? '', result.warning ? 'st-blocked' : 'muted');
    toast(result.changed.length
      ? `Saved — ${result.changed.length} field(s) changed. New applications use these values.`
      : 'No changes to save.', 'good');
    await renderProfile();
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

async function saveQuestionAnswer(key) {
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
    await renderProfile();
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

async function setQuestionStatus(key, status) {
  try {
    await postJson('/api/profile/questions/status', { key, status });
    await renderProfile();
  } catch (err) { profileMessage(err.message, 'st-blocked'); }
}

async function saveAllAnswers({ removeId = null } = {}) {
  const body = $('profileBody');
  const answers = [];
  for (const row of body.querySelectorAll('[data-answer-id]')) {
    const id = row.dataset.answerId;
    if (id === removeId) continue;
    const existing = (state.profile?.screening?.answers ?? []).find((a) => a.id === id) ?? {};
    answers.push({
      id,
      patterns: splitPatterns(row.querySelector('[data-a-patterns]')?.value),
      answer: row.querySelector('[data-a-answer]')?.value ?? '',
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
    await renderProfile();
  } catch (err) {
    profileMessage(err.message, 'st-blocked');
  }
}

/**
 * A pill in the health strip when the profile cannot fill a form completely.
 * The number it shows is the number of rows the dialog opens on — never a
 * separate tally that could drift from it.
 */
function renderHealthProfileFlag() {
  const host = $('health');
  host.querySelector('.stat.pf-flag')?.remove();
  const data = state.profile;
  if (!data?.available) return;
  const open = data.questions?.openCount ?? 0;
  const missing = data.profile?.missing?.length ?? 0;
  if (!open && !missing) return;
  const parts = [];
  if (open) parts.push(`${open} question${open === 1 ? '' : 's'}`);
  if (missing) parts.push(`${missing} empty field${missing === 1 ? '' : 's'}`);
  host.append(el('button', {
    type: 'button', class: 'stat clickable attn pf-flag', 'data-action': 'open-profile',
    title: 'Open the application profile to resolve these.',
  }, el('b', { text: String(open + missing) }), el('span', { class: 'l', text: parts.join(' · ') })));
}

async function loadProfileFlag() {
  try {
    state.profile = await api('/api/profile');
    renderHealthProfileFlag();
  } catch { /* the flag is an extra; never break the board over it */ }
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
      lastFullRefreshAt = Date.now();
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
  // NEW leads, because it is the only figure that answers "did this run find
  // me anything?". `jobs_found` is every posting every source returned — on a
  // mature corpus ~76,000, overwhelmingly already known — so leading with it
  // made a run that discovered 2,800 genuinely new roles read identically to
  // one that discovered none, which is exactly why discovery was reported as
  // "not finding new jobs" while it was in fact working.
  if (result.phase === 'discover') {
    const isNew = Number(counters.jobs_new ?? 0);
    return `${fmt(isNew)} new · ${fmt(counters.jobs_found)} seen · scored ${fmt(counters.jobs_scored)}`;
  }
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
      // Label by what actually happened to the results, not by the mere
      // presence of an error. A source that returned 38,830 jobs and lost one
      // page is "partial"; only a source that delivered nothing is "failed".
      // Calling both "failed" was the single most misleading thing this panel
      // said, because it sat directly above the (equally wrong) claim that the
      // source's results were missing from the run.
      const outcome = entry.outcome
        ?? (entry.degraded ? 'degraded' : (Number(entry.kept) > 0 ? 'partial' : 'failed'));
      // Reuse the run-row state palette: `partial`/`skipped` are amber,
      // `failed` is red. Inventing a `warn` class here would have rendered
      // unstyled, which is how a "partial" badge ends up looking like plain text.
      const OUTCOME_CLASS = {
        degraded: 'partial', partial: 'partial', failed: 'failed', unknown: 'failed',
      };
      head.append(el('span', {
        class: `state ${OUTCOME_CLASS[outcome] ?? 'failed'}`,
        text: outcome === 'partial' && Number(entry.kept) > 0
          ? `partial · ${fmt(entry.kept)} kept`
          : outcome,
      }));
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
      // `--progress` drives a composited scaleX; see `.runline i` in app.css.
      $('runlineFill').style.setProperty('--progress', String(Math.min(1, done / total)));
    } else {
      line.classList.add('indeterminate');
      $('runlineFill').style.removeProperty('--progress');
    }
  } else if (status?.lastError && !dismissed) {
    box.dataset.state = 'error';
    $('runStatus').textContent = 'Run failed';
    $('runMeta').textContent = status.lastError;
    line.hidden = true;
  } else if (status?.lastResult && !dismissed) {
    box.dataset.state = status.partial || (status.rca ?? []).length ? 'warn' : 'ok';
    $('runStatus').textContent = prettyResult(status.lastResult);
    // "failed" overstates it: a source that hit one bad page still delivered
    // the rest, and this line sits right above the per-source breakdown that
    // now says so. Naming the count of affected sources is the useful part.
    $('runMeta').textContent = status.partial
      ? `${(status.rca ?? []).length || 'some'} source(s) had problems — results from healthy sources were kept`
      : '';
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

/*
 * One poll chain, ever. runPhase / autofill / cancel each call pollRun() to
 * poll NOW, and every call used to start another self-rescheduling chain — so
 * after a few actions the page polled several times a second. A generation
 * token makes any older chain stop at its next await.
 *
 * A hidden tab polls every 30s instead of every 1.5-5s, and a tab coming back
 * into view polls at once rather than waiting out that interval.
 */
let pollGen = 0;
const HIDDEN_POLL_MS = 30_000;

async function pollRun() {
  const gen = ++pollGen;
  clearTimeout(pollTimer);
  const wasDown = state.serverUp === false;
  let status;
  try {
    status = await api('/api/run/status');
  } catch {
    if (gen === pollGen) pollTimer = setTimeout(pollRun, document.hidden ? HIDDEN_POLL_MS : 2000);
    return;
  }
  if (gen !== pollGen) return;
  applyRunGate(status);
  const finished = !status.running && wasRunning;
  if (wasDown || finished) refreshAll({ force: true });
  // An auto-fill run is what adds questions to the profile's queue.
  if (finished && /assist/.test(String(status.lastResult?.phase ?? status.phase ?? ''))) loadProfileFlag();
  wasRunning = status.running;
  const delay = document.hidden ? HIDDEN_POLL_MS : status.running ? 1500 : 5000;
  pollTimer = setTimeout(pollRun, delay);
}

let lastFullRefreshAt = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  pollRun();
  if (Date.now() - lastFullRefreshAt > BACKGROUND_REFRESH_MS) {
    lastFullRefreshAt = Date.now();
    refreshAll();
  }
});

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
  'toggle-menu': () => toggleMenu($('mainMenu')),
  'toggle-theme': () => {
    // The attribute is ABSENT until a theme is chosen, so it cannot be read as
    // "the current theme" — doing so made the first click compute
    // `undefined === 'light' ? … : 'light'` and set light on an already-light
    // page, i.e. the toggle did nothing the first time you pressed it. Ask the
    // stylesheet's own source of truth instead.
    const explicit = document.documentElement.dataset.theme;
    const current = explicit
      || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    savePreference('theme', next);
  },
  'open-keys': () => openDialog($('dlgKeys')),
  'toggle-analytics': (target) => {
    const open = $('analytics').hidden;
    $('analytics').hidden = !open;
    target.setAttribute('aria-expanded', String(open));
    target.querySelector('.caret').textContent = open ? '▾' : '▸';
    savePreference('analyticsOpen', open ? '1' : '0');
    if (open) loadSections();
  },
  'toggle-breakdown': (target) => {
    // Reveals the tail that `fillBreakdown` built and hid. The rows already
    // exist, so this costs no request and cannot disagree with the summary.
    const body = target.closest('tbody');
    const open = target.getAttribute('aria-expanded') !== 'true';
    body.classList.toggle('show-tail', open);
    target.setAttribute('aria-expanded', String(open));
    target.textContent = open
      ? 'Show fewer ▴'
      : `Show all ${fmt(body.querySelectorAll('tr').length - 1)} ▾`;
  },
  'toggle-view-menu': () => toggleMenu($('viewMenu')),
  'set-density': (target) => applyViewPrefs({ density: target.dataset.density }),
  'toggle-column': (target) => {
    const set = hiddenColumns();
    const key = target.dataset.column;
    if (set.has(key)) set.delete(key); else set.add(key);
    applyViewPrefs({ hidden: set });
  },
  'open-learn': () => window.open('/learn/', '_blank', 'noopener'),
  'open-reports': openReports,
  'open-documents': openDocuments,
  'open-master': (target) => {
    // Never stack modals: opening this from the Resume library replaces it.
    // The job-detail sheet is the exception — it is context, not a modal task.
    closeDialog(target?.closest?.('dialog:not(#dlgDetail)'));
    openMasterResume();
  },
  'migrate-search-profile': async () => {
    try {
      const r = await postJson('/api/search-profiles/migrate', {});
      toast(r.migrated ? `Imported as profile "${r.id}".` : `Nothing to import — ${r.reason}.`, r.migrated ? 'ok' : '');
      await renderMasterResume();
    } catch (err) { toast(err.message, 'bad'); }
  },
  'activate-search-profile': async (target) => {
    const id = target?.dataset?.profileId;
    if (!id) return;
    try {
      const r = await postJson('/api/search-profiles/activate', { id });
      toast(`Now searching as "${r.label}" — asks for ${r.searchPhrases.map((q) => `"${q}"`).join(', ')}.`, 'ok');
      await renderMasterResume();
    } catch (err) { toast(err.message, 'bad'); }
  },
  // Creating and activating in one step is deliberate here: the user has just
  // been shown exactly what this profile will search for and pressed the button
  // that says so. The API keeps them separable for every other caller.
  'profile-from-resume-create': () => chooseResumeProfile('create', { activate: true }),
  'profile-from-resume-keep': () => chooseResumeProfile('keep'),
  // Merge opens the PICKER rather than submitting everything the resume
  // proposed. The button's own copy offers a choice of what to bring across,
  // and sending the full list was not that choice — it was the "create"
  // outcome with the current profile's roles left on the end.
  'profile-from-resume-merge': () => openMergePicker(),
  'confirm-merge-selection': () => submitMergeSelection(),
  'cancel-merge-selection': () => renderMasterResume(),
  'profile-from-resume-reconsider': () => reconsiderResumeChoice(),
  'adopt-resume-titles': () => adoptResumeSelection({ titles: selectedAdoptTitles() }),
  'adopt-resume-skills': async () => {
    const data = await api('/api/master-resume/suggestions').catch(() => null);
    if (data?.available) await adoptResumeSelection({ skills: data.diff.newSkills });
  },
  'preview-resume-title': () => {
    const [first] = selectedAdoptTitles();
    if (!first) { toast('Tick a title to preview.', ''); return; }
    $('jobSearchMsg').textContent = '';
    $('jobSearchInput').value = first;
    openDialog($('dlgJobSearch'));
  },
  // Carries whatever is in the board filter. The old handler blanked the
  // dialog's input every time, so the phrase you had just typed — the reason
  // you were reaching for this at all — had to be typed a second time.
  'open-job-search': (target) => openBoardSearch(target?.dataset?.query ?? $('q').value),
  'submit-job-search': () => runJobSearch(),
  'exit-role-search': () => exitRoleSearch(),
  'clear-role-search': () => clearRoleSearch(),
  'pick-master-file': () => {
    // Reset first so re-picking the SAME file still fires 'change'.
    $('masterFile').value = '';
    $('masterFile').click();
  },
  'restore-master': (target) => restoreMasterVersion(target.dataset.name),
  'open-profile': (target) => {
    closeDialog(target?.closest?.('dialog:not(#dlgDetail)'));
    openProfile();
  },
  'save-profile': saveProfileDetails,
  'save-question-answer': (target) => saveQuestionAnswer(target.dataset.key),
  'dismiss-question': (target) => setQuestionStatus(target.dataset.key, 'dismissed'),
  'use-question-choice': (target) => {
    const box = $('profileBody').querySelector(`[data-q-answer="${cssEscape(target.dataset.key)}"]`);
    if (!box) return;
    box.value = target.dataset.value;
    box.focus();
  },
  'pf-jump': (target) => {
    const section = $(target.dataset.target);
    section?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // A <details> the user jumped to should not still be shut when they arrive.
    section?.querySelector('details')?.setAttribute('open', '');
  },
  'save-answers': () => saveAllAnswers(),
  'delete-answer': (target) => saveAllAnswers({ removeId: target.dataset.id }),
  'open-health': openHealth,
  'export-jobs': () => download('/api/export/jobs.csv', 'jobagent_jobs.csv'),
  'export-tracker': () => download('/api/export/tracker.csv', 'job_tracker.csv'),

  'set-tab': (target) => {
    // Filters SURVIVE a tab change. They used to be wiped here for the same
    // reason a filter used to wipe the tab — to keep each badge equal to what
    // clicking it opens. The badges are now counted under the active filters,
    // so the two can coexist and "strong fits, across each stage" is one click
    // per stage instead of rebuilding the filter every time.
    state.activeTab = target.dataset.tab;
    state.page = 1;
    renderTabs();
    // A tab is a board query. The stats behind its badge did not change
    // because a different tab was clicked.
    loadBoard();
  },
  'toggle-filter-sheet': () => setFilterSheet($('filterbar').dataset.collapsed === 'true'),
  'clear-tab': () => {
    state.activeTab = 'all';
    state.page = 1;
    renderTabs();
    loadBoard();
  },
  'metric-filter': (target) => {
    try { applyFilterObject(JSON.parse(target.dataset.filter)); }
    catch { /* malformed filter payload */ }
  },
  'clear-filter': (target) => {
    const id = target.dataset.filter;
    clearFilter(id);
    state.page = 1;
    loadBoard();
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

  select: (target) => selectJob(target.dataset.id, { user: true }),
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
  'copy-id': (target) => copyText(target.dataset.id, 'Job id copied'),
  'save-note': () => saveNote(),

  'open-add-url': () => {
    $('addUrlInput').value = '';
    $('addUrlMsg').textContent = '';
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
  'open-submit-dialog': (target) => openSubmitDialog(target.dataset.id),
  'set-view': (target) => setView(target.dataset.view),
  'today-review': (target) => selectJob(target.dataset.id, { user: true }),
  'today-act': (target) => todayAct(target),
  'copy-text': (target) => copyText(target.dataset.text, 'Copied'),
  'confirm-submitted': confirmSubmitted,
  'confirm-go': runPendingConfirm,
  'close-dialog': (target) => closeDialog(target.closest('dialog')),
};

/**
 * Actions that write something or start work. The dispatcher runs these
 * through `withBusy`, so each shows it is working and ignores a second press
 * until the first has settled — one list instead of a guard per handler.
 */
const BUSY_ACTIONS = new Set([
  'cancel-run', 'run', 'migrate-search-profile', 'activate-search-profile',
  'profile-from-resume-create', 'profile-from-resume-keep', 'confirm-merge-selection',
  'profile-from-resume-reconsider', 'adopt-resume-titles', 'adopt-resume-skills',
  'restore-master', 'save-profile', 'save-question-answer', 'dismiss-question',
  'save-answers', 'delete-answer', 'export-jobs', 'export-tracker', 'clear-role-search',
  'batch-autofill', 'batch-prepare', 'batch-approve', 'batch-decide', 'compare',
  'decide', 'approve', 'reject-packet', 'assist', 'autofill-one', 'prepare-one',
  'check-link', 'save-note', 'today-act', 'decision-reason',
  'submit-add-url', 'submit-job-search', 'submit-link', 'confirm-submitted', 'confirm-go',
]);

/** Run one ACTIONS entry, busy-guarded when it mutates. */
function dispatchAction(name, target, event) {
  const action = ACTIONS[name];
  if (!action) return undefined;
  if (target.getAttribute?.('aria-busy') === 'true') return undefined;
  return BUSY_ACTIONS.has(name)
    ? withBusy(target, () => action(target, event))
    : action(target, event);
}

function openSubmitDialog(id) {
  const dialog = $('dlgSubmit');
  dialog.dataset.jobId = id;
  const job = state.known.get(id);
  $('dlgSubmitJob').textContent = job ? `${job.company} — ${job.title}` : id;
  $('submitConf').value = '';
  $('submitNote').value = '';
  openDialog(dialog);
}

/** Clipboard, with the execCommand fallback for a non-secure context. */
async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = el('textarea', {});
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(message);
}

async function submitAddUrl() {
  const url = $('addUrlInput').value.trim();
  const msg = $('addUrlMsg');
  if (!url) { msg.className = 'st-blocked'; msg.textContent = 'Paste a job URL first.'; return; }
  msg.className = 'muted';
  msg.textContent = 'Reading and scoring the posting…';
  try {
    const result = await postJson('/api/add-url', { url });
    closeDialog($('dlgAddUrl'));
    toast(`Added ${result.company || 'job'} — scored ${result.score ?? '—'} (${result.tier})`, 'good');
    scheduleRefresh(0);
    if (result.id) selectJob(result.id, { user: true });
  } catch (err) {
    msg.className = 'st-blocked';
    msg.textContent = err.message;
  }
}

/**
 * Ad-hoc search of the job boards for a role the profile does not target.
 *
 * Synchronous on purpose: only the query-first sources run (Workable, Adzuna),
 * which answer in seconds. A full discovery pass spans 226 Workday tenants for
 * ~14 minutes and is driven from the Run controls instead.
 */
/**
 * Open the job-board search, seeded with the text the user already typed.
 *
 * Pre-selecting the seeded text matters: it is a starting point, not a
 * commitment. "Engineer" typed to filter the board is often too broad to send
 * to a job board, and selected text is edited by typing rather than by
 * clearing first.
 *
 * @param {string} [seed] query to prefill
 */
function openBoardSearch(seed = '') {
  const input = $('jobSearchInput');
  $('jobSearchMsg').textContent = '';
  $('jobSearchMsg').className = 'muted';
  input.value = String(seed ?? '').trim();
  openDialog($('dlgJobSearch'));
  // After the dialog paints, or focus lands on the dialog itself.
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

/**
 * Show the escalating action only when there is something to escalate.
 *
 * An always-present button could be clicked into an empty modal, which is what
 * it used to do. Tying its existence to the query means the control appears
 * exactly when it becomes useful and cannot be pressed when it is not.
 */
function syncBoardSearchAction() {
  const query = $('q').value.trim();
  const button = $('btnFindJobs');
  if (!button) return;
  button.hidden = query.length === 0;
  button.dataset.query = query;
  button.title = query
    ? `Ask the job boards for "${query}" — it does not have to be in your profile`
    : 'Ask the job boards for a role that is not in your profile yet';
}

async function runJobSearch() {
  const query = $('jobSearchInput').value.trim();
  const msg = $('jobSearchMsg');
  if (!query) {
    msg.className = 'st-blocked';
    msg.textContent = 'Type a role or phrase to search for.';
    return;
  }
  msg.className = 'muted';
  msg.textContent = `Searching the job boards for "${query}"…`;
  try {
    const result = await postJson('/api/search', { query });
    const found = result.counters?.jobs_found ?? 0;
    const scored = result.counters?.jobs_scored ?? 0;
    closeDialog($('dlgJobSearch'));
    toast(
      found
        ? `Found ${fmt(found)} for "${result.query}" — ${fmt(scored)} scored, in their own list`
        : `No results for "${result.query}" from ${result.sources.join(', ')}`,
      found ? 'good' : '',
    );
    // Open the role search's OWN list. Deliberately not `$('q').value = query`:
    // that filtered the personalized board by a string, which is exactly the
    // conflation these two modes exist to prevent.
    if (found) await enterRoleSearch(result.query);
  } catch (err) {
    msg.className = 'st-blocked';
    msg.textContent = err.message;
  }
}

/**
 * Show the results of ONE role search, in place of the personalized board.
 *
 * Filters are reset because they belong to the list being left: a `fit` or
 * `sponsorship` narrowing chosen for personalized results would silently hide
 * most of a role search and make it look like it found nothing.
 *
 * @param {string} query the role that was searched for
 */
async function enterRoleSearch(query) {
  state.discoveryMode = 'role_search';
  state.roleQuery = query;
  state.page = 1;
  state.activeTab = 'all';
  state.selected.clear();
  resetFilters({ silent: true });
  renderModeBanner();
  setView('board');
  await loadBoard();
}

/** Return to the personalized board. The role search's rows are left on disk. */
async function exitRoleSearch() {
  state.discoveryMode = 'profile';
  state.roleQuery = null;
  state.page = 1;
  state.selected.clear();
  renderModeBanner();
  await loadBoard();
}

/** Discard one role search's rows, then go back to the personalized board. */
async function clearRoleSearch() {
  const query = state.roleQuery;
  if (!query) return exitRoleSearch();
  try {
    const r = await api(`/api/search?query=${encodeURIComponent(query)}`, { method: 'DELETE' });
    toast(`Cleared ${fmt(r.removed ?? 0)} result${r.removed === 1 ? '' : 's'} for "${query}"`, 'good');
  } catch (err) {
    toast(err.message, 'bad');
  }
  return exitRoleSearch();
}

/** Keep the banner in step with the mode. Hidden entirely on the profile board. */
function renderModeBanner() {
  const banner = $('modeBanner');
  if (!banner) return;
  const roleMode = state.discoveryMode === 'role_search';
  banner.hidden = !roleMode;
  document.body.dataset.discoveryMode = state.discoveryMode;
  if (roleMode) {
    $('modeBannerText').textContent = `Showing job-board results for “${state.roleQuery}”. `
      + 'These are kept separate from your personalized jobs and were not scored against your profile.';
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
    if (state.detailJob?.id === id) {
      state.detailJob = { ...state.detailJob, url };
      renderDetail(state.detailJob);
    }
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
    if (state.selectedId === id) loadDetail(id);
    scheduleRefresh(0);
  } catch (err) { toast(err.message, 'bad'); }
}

/* ─────────────────────── menus ───────────────────────
 * More ▾ and ⚙ View implement the WAI-ARIA menu-button pattern.
 *
 * They declared role="menu" and nothing behind it: opening one left focus on
 * the trigger, the arrow keys did nothing, Escape closed it without returning
 * focus, and tabbing out left it open over the page. The pattern (rather than
 * converting to a disclosure of plain buttons) is kept because the View menu's
 * items ARE radio and checkbox menu items — a disclosure would have to re-say
 * "checked" with aria-pressed on every item and lose the grouping for free.
 *
 * Open: focus moves to the first item (ArrowUp on the trigger: the last).
 * ArrowUp/ArrowDown wrap, Home/End jump, Escape closes and returns focus to
 * the trigger, Tab closes and lets focus move on, and focus leaving the menu
 * by any other route closes it.
 */
const MENU_TRIGGERS = { mainMenu: 'toggle-menu', viewMenu: 'toggle-view-menu' };

const menuTrigger = (pop) => document.querySelector(`[data-action="${MENU_TRIGGERS[pop.id]}"]`);

function menuItems(pop) {
  return [...pop.querySelectorAll('[role^="menuitem"]')]
    .filter((item) => !item.hidden && !item.disabled && item.offsetParent !== null);
}

function openMenu(pop, { focus = 'first' } = {}) {
  closeMainMenu({ except: pop });
  pop.dataset.open = 'true';
  menuTrigger(pop)?.setAttribute('aria-expanded', 'true');
  const items = menuItems(pop);
  // Items are reached with the arrow keys, so none is a Tab stop of its own.
  for (const item of items) item.tabIndex = -1;
  (focus === 'last' ? items.at(-1) : items[0])?.focus();
}

function closeMenu(pop, { returnFocus = false } = {}) {
  if (!pop || pop.dataset.open !== 'true') return;
  pop.dataset.open = 'false';
  const trigger = menuTrigger(pop);
  trigger?.setAttribute('aria-expanded', 'false');
  if (returnFocus) trigger?.focus();
}

function toggleMenu(pop) {
  if (pop.dataset.open === 'true') closeMenu(pop, { returnFocus: true });
  else openMenu(pop);
}

/**
 * Close any open popup menu.
 *
 * Both popups close together on an outside click. The View menu is the
 * exception the caller makes: its own items (density, column ticks) must NOT
 * dismiss it, because changing two columns should not cost two trips back to
 * the button.
 *
 * @param {{ except?: HTMLElement, returnFocus?: boolean }} [options]
 *   returnFocus sends focus back to the trigger of a menu that held it — so
 *   choosing an item never leaves focus inside a menu that just vanished.
 */
function closeMainMenu({ except = null, returnFocus = false } = {}) {
  for (const popId of Object.keys(MENU_TRIGGERS)) {
    const pop = $(popId);
    if (!pop || pop === except) continue;
    closeMenu(pop, { returnFocus: returnFocus && pop.contains(document.activeElement) });
  }
}

for (const popId of Object.keys(MENU_TRIGGERS)) {
  const pop = $(popId);
  pop.addEventListener('keydown', (event) => {
    const items = menuItems(pop);
    const at = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = items[(at + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(pop, { returnFocus: true });
      return;
    } else if (event.key === 'Tab') {
      closeMenu(pop);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
  const wrap = pop.closest('.menu');
  wrap.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !wrap.contains(event.relatedTarget)) closeMenu(pop);
  });
  menuTrigger(pop).addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openMenu(pop, { focus: event.key === 'ArrowUp' ? 'last' : 'first' });
  });
}

document.addEventListener('click', (event) => {
  // A real link always just navigates. Rows are themselves clickable
  // (`data-action="select"`), so without this a link inside one would ALSO
  // select the row — and any future link that forgets its own `data-action`
  // would be swallowed by the row entirely. Guarding on the element clicked
  // fixes the whole class, not one instance of it.
  if (event.target.closest?.('a[href]')) return;
  const target = event.target.closest('[data-action]');
  // Any click closes an open menu except on its own trigger (which toggles) or
  // on a View-menu item — ticking two columns should not cost two round trips
  // back to the button. Choosing a header-menu item used to LEAVE it open,
  // hanging over the page behind it.
  const KEEP_MENU_OPEN = ['toggle-menu', 'toggle-view-menu', 'set-density', 'toggle-column'];
  if (!KEEP_MENU_OPEN.includes(target?.dataset.action)) closeMainMenu({ returnFocus: true });
  if (!$('runDetails').hidden && !$('runbox').contains(event.target)) setRunDetails(false);
  if (!target) return;
  if (!ACTIONS[target.dataset.action]) return;
  // A checkbox inside a clickable row must not also trigger row selection.
  if (target.dataset.action !== 'select') event.stopPropagation();
  if (target.tagName === 'A') return; // let real links navigate
  dispatchAction(target.dataset.action, target, event);
});

// Dialog forms: Enter in any field, or the submit button, lands here once.
// `preventDefault` keeps method="dialog" from closing the dialog before the
// request has succeeded — a failed save must leave the user's input on screen.
document.addEventListener('submit', (event) => {
  const form = event.target.closest?.('form[data-submit]');
  if (!form) return;
  event.preventDefault();
  const button = event.submitter ?? form.querySelector('[type="submit"]') ?? form;
  dispatchAction(form.dataset.submit, button, event);
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
    selectJob(row.dataset.id, { user: true });
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
    // Wide: the rail follows focus, debounced so holding ↓ costs one request.
    // Narrow: the detail is a modal sheet, and opening one per keypress would
    // trap the user — arrows move, Enter opens.
    if (!isSheetLayout()) selectJob(next, { defer: 120 });
  }
});

/**
 * Arrow-key movement inside the tablist, as the tab pattern requires.
 *
 * With a roving tabindex the arrow keys are the ONLY way to reach the other
 * tabs from the keyboard, so this is not a nicety — without it seven of the
 * eight tabs become unreachable. Left/Right wrap; Home/End jump to the ends.
 */
$('tabs').addEventListener('keydown', (event) => {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const tabs = [...$('tabs').querySelectorAll('[role="tab"]')];
  const from = tabs.indexOf(event.target.closest('[role="tab"]'));
  if (from === -1) return;
  event.preventDefault();
  const to = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (from + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  // Focus moves first so the tab that is about to be re-rendered is not the one
  // we are trying to land on; activation follows, as this tablist is
  // selection-follows-focus (each tab is a cheap board query).
  tabs[to].focus();
  tabs[to].click();
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
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  // "/" focuses search, as in most triage tools.
  if (event.key === '/' && !typing) {
    event.preventDefault();
    $('q').focus();
  }
  // "?" opens the shortcut sheet — the conventional key, so the feature does
  // not itself need discovering.
  if (event.key === '?' && !typing) {
    event.preventDefault();
    openDialog($('dlgKeys'));
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
    // The escalating action tracks the query on every keystroke, NOT on the
    // debounce — it is a property of what is typed, not of what the board has
    // finished loading, and a quarter-second of lag on a control appearing
    // reads as the field being unresponsive.
    if (id === 'q') syncBoardSearchAction();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.page = 1; onFilterChange(); }, 250);
  });
}
// Also after any programmatic write: Reset, a restored URL/preference, or a
// filter chip being dismissed all change the query without an `input` event.
syncBoardSearchAction();
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

/**
 * A filter now narrows WITHIN the current tab instead of leaving it.
 *
 * Touching any filter used to force the tab back to "All jobs". That was done
 * to keep each badge equal to what clicking it opens — but it also meant the
 * most natural move on this board ("of the 179 needing review, which are strong
 * fits?") silently threw you into all 19,212 rows. The server always supported
 * the combination; only the UI refused it.
 *
 * The badge promise is kept instead of dodged: when a filter is active the
 * board request also returns per-tab counts computed against that same filter,
 * so every badge still says exactly how many rows clicking it would show.
 */
function onFilterChange() {
  loadBoard();
}

/* ─────────────────── view preferences: density + columns ───────────────────
 * Both are VIEW settings, so they persist like sort and page size and never
 * like a filter: coming back to a board that is silently narrowed is
 * disorienting, coming back to the shape you chose is the tool remembering you.
 */

/**
 * Columns the reader may hide. Grade, company/role and status are not offered:
 * a board with no fit, no role and no state is not a denser board, it is an
 * empty one. `nth` is the 1-based column position the CSS rules key on.
 */
const OPTIONAL_COLUMNS = [
  { key: 'sponsor', nth: 4, label: 'Sponsor' },
  { key: 'posted', nth: 5, label: 'Posted' },
  { key: 'found', nth: 6, label: 'Found' },
  { key: 'resume', nth: 7, label: 'Resume' },
];

function hiddenColumns() {
  try { return new Set(JSON.parse(readPreference('hiddenColumns') ?? '[]')); }
  catch { return new Set(); }
}

/** Reflect density + hidden columns onto the board, and remember both. */
function applyViewPrefs({ density, hidden } = {}) {
  const d = density ?? readPreference('density') ?? 'comfortable';
  document.documentElement.dataset.density = d;
  savePreference('density', d);
  for (const button of document.querySelectorAll('[data-action="set-density"]')) {
    button.setAttribute('aria-checked', String(button.dataset.density === d));
  }

  const set = hidden ?? hiddenColumns();
  savePreference('hiddenColumns', JSON.stringify([...set]));
  // One attribute on the table drives every rule; the alternative — toggling a
  // class on ~800 cells after each render — is both slower and easy to miss on
  // a re-render.
  $('board').dataset.hide = [...set].join(' ');

  const host = $('columnToggles');
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.column : null;
  host.textContent = '';
  for (const column of OPTIONAL_COLUMNS) {
    const on = !set.has(column.key);
    host.append(el('button', {
      type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(on), tabindex: '-1',
      'data-action': 'toggle-column', 'data-column': column.key,
    }, el('span', { class: 'tick', 'aria-hidden': 'true', text: on ? '✓' : '' }), column.label));
  }
  // Rebuilt on every toggle; without this, ticking a column dropped focus out
  // of the open menu.
  if (focused) host.querySelector(`[data-column="${cssEscape(focused)}"]`)?.focus();
}

/** True when any filter is set, i.e. the tab alone no longer describes the board. */
function hasActiveFilters() {
  return [...FILTER_IDS, ...TOGGLE_IDS].some((id) => filterValue(id));
}

/**
 * Phone-only: fold every control except search behind one button.
 *
 * The CSS does the hiding (`.filterbar[data-collapsed]`), so this only tracks
 * the flag and keeps the button honest about how many filters are set — a
 * collapsed bar with three active filters must say three, or it is the same
 * hidden-state problem the old popover had.
 */
function setFilterSheet(open) {
  $('filterbar').dataset.collapsed = String(!open);
  $('btnFilterSheet').setAttribute('aria-expanded', String(open));
}

/** Keep the phone toggle's count in step with what is actually filtering. */
function syncFilterSheetCount() {
  const n = [...FILTER_IDS, ...TOGGLE_IDS].filter((id) => filterValue(id)).length;
  const button = $('btnFilterSheet');
  button.textContent = '';
  button.append('Filters');
  if (n) button.append(el('span', { class: 'n', text: String(n) }));
}

/* Dialog submit-on-Enter is the <form> itself now — see the submit listener. */

/* Master resume upload — the hidden picker is opened by the visible button. */
$('masterFile').addEventListener('change', (event) => {
  uploadMasterResume(event.target.files?.[0]);
});

/* ───────────────────────────── boot ───────────────────────────── */

/**
 * Publish the topbar's live height so sticky things can sit below it.
 *
 * The topbar is sticky and opaque, and it wraps to two rows around 1280px and
 * three on a phone. Anything else that sticks has to know how tall it currently
 * is — a constant is wrong at two of those three widths, which is how the
 * column headers ended up parked underneath it.
 */
const topbarEl = document.querySelector('.topbar');
function syncTopbarHeight() {
  const h = Math.round(topbarEl.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}
new ResizeObserver(syncTopbarHeight).observe(topbarEl);
syncTopbarHeight();

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
  if (id && id !== state.selectedId) selectJob(id, { user: true });
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
} else if (window.innerWidth <= 860) {
  // First run on a narrow screen. A row is a table row on a desktop and a
  // ~137px card on a phone, so the same 100 rows are ~7,000px there and
  // ~15,000px here — eighteen screens of scrolling to reach the end of one
  // page. This only sets the STARTING point when nothing has been chosen; a
  // saved preference always wins.
  $('pageSize').value = '50';
}
state.pageSize = Number($('pageSize').value) || 100;
if (readPreference('analyticsOpen') === '1') {
  $('analytics').hidden = false;
  $('btnAnalytics').setAttribute('aria-expanded', 'true');
  $('btnAnalytics').querySelector('.caret').textContent = '▾';
}
SHEET_QUERY.addEventListener('change', placeDetail);
placeDetail();
// Today is the landing view unless the user last chose the board.
setView(readPreference('view') === 'board' ? 'board' : 'today', { save: false });
applyViewPrefs();
renderTabs();
syncSortIndicator();
refreshAll({ force: true }).then(() => {
  const initial = jobIdFromHash();
  if (initial) selectJob(initial);
});
// The profile pill is an extra: fetched once the page is idle, not on the
// critical path, and again only when a dialog or an auto-fill run changes it.
(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))(() => {
  loadProfileFlag();
  // The doctor spawns Python and probes the browser, so it waits for idle too.
  loadHealthChecks();
});
pollRun();
scheduleBackgroundRefresh();
syncSelectionBar();
