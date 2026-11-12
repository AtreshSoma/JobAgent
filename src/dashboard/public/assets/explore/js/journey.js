/**
 * The Line: one example posting followed along the route, and the five
 * stations it calls at.
 *
 * `buildRoute` is the diagram under the headline. A token (the posting) runs
 * the line by itself and is held at each of the two signals until the reader
 * clears it, which is the product's rule made physical: automation up to a
 * human gate, and no further.
 *
 * `buildStations` returns the page sections for the five stages, with a signal
 * band after Tailor and after Fill. Each section has its own composition; the
 * pictures are built from the illustrative data in content-overview.js, and
 * every score on the page comes from the model the Score Lab uses.
 */
import { countTo, h, icon, marked, prefersReducedMotion } from './dom.js';
import { topicLink } from './ui.js';
import {
  JOURNEY, GATES, EXAMPLE_JOB, DISCOVER_DEMO, TAILOR_DEMO, FILL_DEMO, TRACK_DEMO,
  SOURCE_GROUPS, SOURCES, SOURCE_MODES,
} from './content-overview.js';
import { DEFAULT_INPUTS, PRESETS, SCORE_MODEL, scoreInputs } from './score-model.js';

/** Which line each stage runs on. Find is blue, Apply is green, Track is magenta. */
export const LINE_OF = Object.freeze({ discover: 'find', score: 'find', tailor: 'apply', fill: 'apply', track: 'track' });

/** How long the token rests at a station before moving on, in milliseconds. */
const DWELL_MS = 1250;

const example = scoreInputs();
const slug = (text) => String(text).toLowerCase().replace(/\s+/g, '-');
const points = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/* ───────────────────────── the route ───────────────────────── */

/** The stops of the route in order: five stations with a signal after Tailor and after Fill. */
function routeStops() {
  const stops = [];
  for (const stage of JOURNEY) {
    stops.push({ kind: 'station', id: stage.id, name: stage.name, fact: stage.fact, line: LINE_OF[stage.id] });
    const gate = GATES.find((g) => g.after === stage.id);
    if (gate) stops.push({ kind: 'signal', id: gate.after, name: gate.label, fact: gate.fact, detail: gate.detail, line: LINE_OF[stage.id] });
  }
  return stops;
}

const STATION_STATUS = Object.freeze({
  discover: `Found on ${EXAMPLE_JOB.source}, ${EXAMPLE_JOB.posted}.`,
  score: `Scored ${example.total}. Tier: ${example.tier}.`,
  tailor: 'Resume tailored. Packet ready for review.',
  fill: 'Form filled in your own browser.',
  track: 'Submitted by you. Now tracking replies.',
});

const SIGNAL_COPY = Object.freeze({
  tailor: { waiting: 'Held at the signal. Nothing is filled until you approve.', action: 'Approve' },
  fill: { waiting: 'Held at the signal. The final click is always yours.', action: 'Submit' },
});

/**
 * @returns {{ root: HTMLElement, start: () => void, reset: () => void }}
 */
export function buildRoute() {
  const stops = routeStops();
  let at = 0;
  let timer = null;
  let started = false;

  const state = h('span', { class: 'ex-route-state' });
  const again = h('button', { type: 'button', class: 'ex-route-again', hidden: true, onClick: () => reset() }, 'Run it again');
  // The token is the posting itself, carrying its title along the line.
  // Decorative: the status line below says the same thing in words.
  const token = h('span', { class: 'ex-route-token', 'aria-hidden': 'true' }, h('span', { class: 'ex-route-tag', text: EXAMPLE_JOB.title }));

  const items = stops.map((stop, index) => {
    const next = stops[index + 1];
    const base = { class: `ex-stop ex-stop-${stop.kind}`, dataset: { line: stop.line, next: next ? next.line : '' }, style: `--n:${index}` };
    if (stop.kind === 'station') {
      return h('li', base, h('a', { class: 'ex-stop-link', href: `#/overview/${stop.id}` },
        h('span', { class: 'ex-stop-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'ex-stop-name', text: stop.name })),
      h('span', { class: 'ex-stop-fact', text: stop.fact }));
    }
    const copy = SIGNAL_COPY[stop.id];
    // The signal is a real button named for what pressing it does. It is
    // disabled until the token is standing at it.
    const button = h('button', {
      type: 'button', class: 'ex-signal-btn', disabled: true, title: stop.detail,
      onClick: () => clear(index),
    }, h('span', { class: 'ex-signal-lamp', 'aria-hidden': 'true' }), h('span', { class: 'ex-signal-action', text: copy.action }));
    stop.button = button;
    return h('li', base, button, h('span', { class: 'ex-signal-name', text: stop.name }), h('span', { class: 'ex-stop-fact', text: stop.fact }));
  });

  const root = h('div', { class: 'ex-route', dataset: { state: 'idle' }, style: `--stops:${stops.length}` },
    // The token sits beside the list, not in it: a list may only hold items.
    h('div', { class: 'ex-route-track' }, h('ol', { class: 'ex-route-line' }, items), token),
    h('p', { class: 'ex-route-status' },
      h('span', { class: 'ex-route-job' }, h('b', { text: EXAMPLE_JOB.title }), ` ${EXAMPLE_JOB.company}`),
      h('span', { class: 'ex-route-live', role: 'status' }, state),
      again),
    h('p', { class: 'ex-route-note', text: 'An example posting. Clear each signal to let it through.' }));

  function paint() {
    const stop = stops[at];
    const waiting = stop.kind === 'signal' && !stop.cleared;
    // Held at a signal, the token stands just short of it.
    root.style.setProperty('--at', String(waiting ? at - 0.4 : at));
    root.dataset.line = stop.line;
    items.forEach((item, index) => {
      item.classList.toggle('is-passed', index < at);
      item.classList.toggle('is-here', index === at);
    });
    root.dataset.state = waiting ? 'held' : at === stops.length - 1 ? 'done' : 'running';
    state.textContent = stop.kind === 'signal' ? SIGNAL_COPY[stop.id].waiting : STATION_STATUS[stop.id];
    for (const s of stops) {
      if (s.kind !== 'signal') continue;
      s.button.disabled = !(s === stop && waiting);
      s.button.classList.toggle('is-clear', Boolean(s.cleared));
    }
    again.hidden = at !== stops.length - 1;
  }

  function advance() {
    clearTimeout(timer);
    const stop = stops[at];
    // A signal that has not been cleared holds the token. Nothing here times out.
    if (at >= stops.length - 1 || (stop.kind === 'signal' && !stop.cleared)) return;
    timer = setTimeout(() => {
      at += 1;
      paint();
      advance();
    }, prefersReducedMotion() ? 700 : DWELL_MS);
  }

  function clear(index) {
    const stop = stops[index];
    if (index !== at || stop.cleared) return;
    stop.cleared = true;
    paint();
    advance();
    // Clearing a signal disables its button, which would drop keyboard focus
    // on the page body; hand it to the next thing the reader can act on.
    queueMicrotask(() => {
      const next = stops.slice(index + 1).find((s) => s.kind === 'signal');
      if (document.activeElement === document.body) (next?.button.disabled === false ? next.button : again.hidden ? root.querySelector('.ex-stop-link') : again).focus();
    });
  }

  function reset() {
    clearTimeout(timer);
    for (const s of stops) s.cleared = false;
    at = 0;
    paint();
    advance();
  }

  function start() {
    if (started) return;
    started = true;
    advance();
  }

  // A tab left in the background should not run the line unseen.
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (started) advance(); });

  paint();
  return { root, start, reset };
}

/* ───────────────────────── shared pieces ───────────────────────── */

/**
 * Move an existing ruler to a new score: the marker slides, the current tier's
 * name changes. The Overview's presets use this; the Score Lab rebuilds its
 * ruler on every input because it is a tool, and a tool should not make you wait.
 */
export function setRuler(ruler, total) {
  const t = SCORE_MODEL.tiers;
  ruler.querySelector('.ex-ruler-mark').style.setProperty('--at', String(total));
  const bands = [0, t.nearMiss, t.queue, t.apply, t.priority, 100];
  ruler.querySelectorAll('.ex-ruler-names span').forEach((span, i) => {
    span.classList.toggle('is-current', total >= bands[i] && (total < bands[i + 1] || bands[i + 1] === 100));
  });
  ruler.setAttribute('aria-label', ruler.getAttribute('aria-label').replace(/^Score \d+/, `Score ${total}`));
}

/** The five tiers on one line, with a marker at the score. Shared with the Score Lab. */
export function tierRuler(total) {
  const t = SCORE_MODEL.tiers;
  const bands = [
    ['Discard', 0, t.nearMiss], ['Near miss', t.nearMiss, t.queue], ['Queue', t.queue, t.apply],
    ['Apply', t.apply, t.priority], ['Priority', t.priority, 100],
  ];
  return h('div', { class: 'ex-ruler', role: 'img', 'aria-label': `Score ${total} on the tier scale: Near miss from ${t.nearMiss}, Queue from ${t.queue}, Apply from ${t.apply}, Priority from ${t.priority}.` },
    h('div', { class: 'ex-ruler-track' },
      bands.map(([name, from, to]) => h('span', { class: `ex-ruler-band ex-band-${slug(name)}`, style: `flex-grow:${to - from}` })),
      h('span', { class: 'ex-ruler-mark', style: `--at:${total}` })),
    // The thresholds, then each tier named under the middle of its band. Near
    // miss and Apply are only ten points wide, so they sit a row lower.
    h('div', { class: 'ex-ruler-nums', 'aria-hidden': 'true' }, bands.slice(1).map(([, from]) => h('span', { style: `--at:${from}`, text: String(from) }))),
    h('div', { class: 'ex-ruler-names', 'aria-hidden': 'true' }, bands.map(([name, from, to], index) => h('span', {
      class: `${index % 2 ? 'is-low' : ''}${total >= from && (total < to || to === 100) ? ' is-current' : ''}`,
      style: `--at:${(from + to) / 2}`, text: name,
    }))));
}

/**
 * An illustrative picture. It slides in from the side it sits on when it is
 * first scrolled to (`from`: right, left or up), see watchReveals in main.js.
 */
function figure(className, children, { caption = 'Illustrative example', from = 'right' } = {}) {
  return h('figure', { class: `ex-demo ${className}`, dataset: { reveal: '', from } },
    children, h('figcaption', { class: 'ex-demo-cap', text: caption }));
}

/** The words every station shares: what it is, who does what, and where to read more. */
function copyBlock(stage) {
  return h('div', { class: 'ex-station-copy', dataset: { reveal: '', from: 'up' } },
    h('p', { class: 'ex-station-claim', text: stage.title }),
    h('p', { class: 'ex-station-body', text: stage.body }),
    h('dl', { class: 'ex-roles' },
      h('div', {}, h('dt', { text: 'You' }), h('dd', { text: stage.you })),
      h('div', {}, h('dt', { text: 'JobAgent' }), h('dd', { text: stage.agent })),
      h('div', {}, h('dt', { text: 'Stays yours' }), h('dd', { text: stage.yours }))),
    topicLink(stage.topic));
}

/** One station section: the name set as a sign, a marker on the page's line, then its own layout. */
function station(stage, ...children) {
  return h('section', {
    class: `ex-station ex-station-${stage.id}`, id: `station-${stage.id}`, 'aria-labelledby': `station-${stage.id}-name`,
    dataset: { line: LINE_OF[stage.id], reveal: '' },
  },
  // The line down the left edge fills as you read: the filled part ends at
  // the middle of the window, like the "you are here" of a route map. It is
  // position, not animation: a sticky element inside a rail that clips it.
  h('span', { class: 'ex-station-rail', 'aria-hidden': 'true' }, h('span', { class: 'ex-station-progress' })),
  h('span', { class: 'ex-station-mark', 'aria-hidden': 'true' }),
  h('h2', { class: 'ex-station-name', id: `station-${stage.id}-name`, tabindex: '-1', text: stage.name }),
  children);
}

/** The band between two stations where the line is held for a person. */
function signalBand(gate) {
  const after = JOURNEY.find((s) => s.id === gate.after);
  return h('section', { class: 'ex-band-signal', 'aria-label': gate.label, dataset: { line: LINE_OF[after.id], reveal: '' } },
    h('span', { class: 'ex-band-lamp', 'aria-hidden': 'true' }),
    h('h2', { class: 'ex-band-title', text: `${gate.label}.` }),
    h('p', { class: 'ex-band-text', text: gate.detail }));
}

/* ───────────────────────── 1. Discover ───────────────────────── */

function discoverStation(stage) {
  const board = figure('ex-board', h('ul', { class: 'ex-board-rows' }, DISCOVER_DEMO.map((row, index) => {
    const [source, ...rest] = row.meta.split(', ');
    return h('li', { class: `ex-board-row ex-board-${row.outcome}`, style: `--i:${index}` },
      h('span', { class: 'ex-board-src', text: source }),
      h('span', { class: 'ex-board-main' },
        h('span', { class: 'ex-board-title', text: row.title }),
        h('span', { class: 'ex-board-meta', text: `${row.company} · ${rest.join(', ')}` })),
      h('span', { class: 'ex-board-out', text: row.label }));
  })));

  // Where the postings come from: the feeder lines into this station.
  let mode = 'all';
  const chips = [];
  const count = h('p', { class: 'ex-feed-count', role: 'status' });
  const filters = [['all', 'All sources'], ...Object.entries(SOURCE_MODES)].map(([id, text]) => h('button', {
    type: 'button', class: 'ex-chip', 'aria-pressed': String(id === 'all'), dataset: { mode: id },
    onClick: () => { mode = id; paint(); },
  }, id === 'all' ? null : h('span', { class: `ex-mode ex-mode-${id}`, 'aria-hidden': 'true' }), text));
  function paint() {
    for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    for (const { el, source } of chips) el.classList.toggle('is-muted', mode !== 'all' && source.mode !== mode);
    const shown = mode === 'all' ? SOURCES.length : SOURCES.filter((s) => s.mode === mode).length;
    count.textContent = `${shown} of ${SOURCES.length} source adapters`;
  }
  const feeds = h('div', { class: 'ex-feeds', id: 'sources', dataset: { reveal: '', from: 'up' } },
    h('div', { class: 'ex-feeds-head' },
      h('h3', { class: 'ex-h3', text: 'Where the postings come from' }),
      h('p', { class: 'ex-feeds-lede', text: 'Public endpoints only. JobAgent never logs in to a job board, and sources that need an account stay off until you add your own key.' }),
      h('div', { class: 'ex-chips', role: 'group', 'aria-label': 'Filter sources' }, filters),
      count),
    h('div', { class: 'ex-feed-groups' }, SOURCE_GROUPS.map((group) => h('div', { class: 'ex-feed' },
      h('h4', { class: 'ex-feed-name', text: group.name }),
      h('ul', { class: 'ex-feed-list' }, SOURCES.filter((s) => s.group === group.id).map((source) => {
        const el = h('li', { class: 'ex-source' },
          h('span', { class: `ex-mode ex-mode-${source.mode}`, 'aria-hidden': 'true' }),
          h('span', { class: 'ex-source-name', text: source.name }),
          h('span', { class: 'sr-only', text: `, ${SOURCE_MODES[source.mode]}` }));
        chips.push({ el, source });
        return el;
      }))))));
  paint();

  return station(stage, h('div', { class: 'ex-split' }, copyBlock(stage), board), feeds);
}

/* ───────────────────────── 2. Score ───────────────────────── */

function scoreStation(stage) {
  const number = h('span', { class: 'ex-score-num' });
  const tier = h('span', { class: 'ex-tier' });
  const note = h('p', { class: 'ex-score-note', role: 'status' });
  const rulerSlot = h('div', { class: 'ex-score-ruler' });
  let ruler = null;
  let shown = 0;
  const base = scoreInputs(DEFAULT_INPUTS);
  const rows = base.rows.map((row) => {
    const fill = h('span', { class: 'ex-bar-fill' });
    const num = h('span', { class: 'ex-bar-num' });
    return { id: row.id, fill, num, el: h('li', { class: 'ex-bar' },
      h('span', { class: 'ex-bar-label', text: row.label }),
      h('span', { class: 'ex-bar-track', 'aria-hidden': 'true' }, fill), num) };
  });
  const buttons = PRESETS.map((preset) => h('button', {
    type: 'button', class: 'ex-chip', 'aria-pressed': 'false', dataset: { preset: preset.id },
    onClick: () => show(preset),
  }, preset.name));

  function show(preset, { initial = false } = {}) {
    const result = scoreInputs({ ...DEFAULT_INPUTS, ...preset.inputs });
    // The number counts to its new value; the first one counts up when the card is first seen.
    if (initial) number.textContent = String(result.total);
    else countTo(number, result.total, { from: shown, duration: 520 });
    shown = result.total;
    tier.textContent = result.tier;
    tier.className = `ex-tier ex-tier-${slug(result.tier)}`;
    note.textContent = result.held
      ? `Scored as ${result.rawTier}, held in Queue. ${result.heldReason}`
      : 'Every point below has a reason you can read on the job.';
    note.classList.toggle('is-held', Boolean(result.held));
    if (ruler) setRuler(ruler, result.total);
    else rulerSlot.replaceChildren(ruler = tierRuler(result.total));
    for (const row of rows) {
      const r = result.rows.find((x) => x.id === row.id);
      row.fill.style.setProperty('--v', (r.points / r.weight).toFixed(3));
      row.num.textContent = `${points(r.points)} / ${r.weight}`;
    }
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.preset === preset.id));
  }
  show(PRESETS[0], { initial: true });

  const verdict = figure('ex-scorecard', [
    h('div', { class: 'ex-score-top' },
      h('div', { class: 'ex-score-figure' }, number, h('span', { class: 'ex-score-of', text: 'out of 100' }), tier),
      h('div', { class: 'ex-score-side' },
        h('div', { class: 'ex-chips', role: 'group', 'aria-label': 'Try a different posting' }, buttons),
        note)),
    rulerSlot,
    h('ul', { class: 'ex-bars' }, rows.map((r) => r.el)),
  ], { caption: 'Illustrative example, computed by the same arithmetic as the real scorer.', from: 'up' });
  verdict.addEventListener('ex:reveal', () => countTo(number, shown, { from: 0, duration: 1100 }), { once: true });

  return station(stage, h('div', { class: 'ex-stack' }, verdict, copyBlock(stage)));
}

/* ───────────────────────── 3. Tailor ───────────────────────── */

function tailorStation(stage) {
  const ordinal = ['1st', '2nd', '3rd', '4th'];
  const master = TAILOR_DEMO.bullets;
  const tailored = [...master].sort((a, b) => a.rank - b.rank);
  const sheet = (title, list, { strong }) => h('div', { class: `ex-sheet${strong ? ' ex-sheet-tailored' : ''}` },
    h('p', { class: 'ex-sheet-tab', text: title }),
    h('p', { class: 'ex-sheet-role', text: 'Data Engineer, Contoso Health' }),
    h('ul', { class: 'ex-sheet-bullets' }, list.map((b) => {
      const was = master.indexOf(b);
      const now = list.indexOf(b);
      return h('li', { class: 'ex-sheet-bullet', dataset: { bullet: b.id } },
        h('span', { class: 'ex-sheet-text' }, marked(b.text, { strong })),
        strong && was !== now ? h('span', { class: 'ex-sheet-moved', text: `was ${ordinal[was]}` }) : null);
    })),
    h('p', { class: 'ex-sheet-skills' }, h('span', { class: 'ex-sheet-label', text: 'Skills' }),
      (strong ? TAILOR_DEMO.skills.tailored : TAILOR_DEMO.skills.master).join(', ')));

  const spread = figure('ex-spread', [
    h('div', { class: 'ex-sheets' },
      sheet('Master resume', master, { strong: false }),
      h('span', { class: 'ex-sheets-arrow', 'aria-hidden': 'true' }, icon('arrow', { size: 22 })),
      sheet('Tailored for this job', tailored, { strong: true })),
    h('p', { class: 'ex-gap' }, icon('note', { size: 16 }),
      h('span', {}, h('strong', { text: TAILOR_DEMO.gap }), ' is in the posting and not in this resume. It is reported as a gap and never added.')),
  ], { caption: 'Illustrative example. The same four bullets on both sheets, in a different order.', from: 'up' });

  // The one move this station is about: the tailored sheet first shows the
  // master's order, then each bullet slides to its new place, and only then
  // are the posting's terms emphasized. Pure FLIP: the DOM order never changes.
  const tailoredSheet = spread.querySelector('.ex-sheet-tailored');
  if (!prefersReducedMotion() && typeof IntersectionObserver === 'function') tailoredSheet.dataset.flip = 'pending';
  spread.addEventListener('ex:reveal', () => {
    if (tailoredSheet.dataset.flip !== 'pending') return;
    const rows = [...tailoredSheet.querySelectorAll('.ex-sheet-bullet')];
    const tops = rows.map((row) => row.offsetTop);
    const ids = master.map((b) => b.id);
    const motions = rows.map((row, now) => {
      const dy = tops[ids.indexOf(row.dataset.bullet)] - tops[now];
      return dy ? row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        { duration: 950, delay: 650 + now * 60, easing: 'cubic-bezier(.77, 0, .175, 1)', fill: 'backwards' }).finished : null;
    }).filter(Boolean);
    Promise.allSettled(motions).then(() => { tailoredSheet.dataset.flip = 'done'; });
  }, { once: true });

  // Pointing at a bullet shows where the same sentence sits on the other sheet.
  spread.addEventListener('pointerover', (event) => {
    const id = event.target.closest?.('[data-bullet]')?.dataset.bullet;
    for (const el of spread.querySelectorAll('[data-bullet]')) el.classList.toggle('is-linked', Boolean(id) && el.dataset.bullet === id);
  });
  spread.addEventListener('pointerleave', () => { for (const el of spread.querySelectorAll('.is-linked')) el.classList.remove('is-linked'); });

  return station(stage, h('div', { class: 'ex-lead' }, copyBlock(stage)), spread);
}

/* ───────────────────────── 4. Fill ───────────────────────── */

function fillStation(stage) {
  const form = figure('ex-formfig', [
    h('div', { class: 'ex-form' },
      FILL_DEMO.map((field, index) => h('div', { class: `ex-field ex-field-${field.state}`, style: `--i:${index}` },
        h('span', { class: 'ex-field-label', text: field.label }),
        h('span', { class: 'ex-field-from', text: field.from }),
        h('span', { class: 'ex-field-box' }, field.state === 'ask'
          ? h('span', { class: 'ex-field-ask', text: 'Left for you' })
          : h('span', { class: 'ex-field-value', text: field.value })))),
      h('div', { class: 'ex-halt', style: `--i:${FILL_DEMO.length}` },
        h('span', { class: 'ex-halt-text' }, h('span', { class: 'ex-band-lamp', 'aria-hidden': 'true' }), 'JobAgent stops here'),
        h('span', { class: 'ex-halt-button', text: 'Submit application' }),
        h('span', { class: 'ex-halt-yours', text: 'Your click' }))),
  ], { from: 'left' });
  const guards = h('div', { class: 'ex-guards', dataset: { reveal: '', from: 'up' } },
    h('h3', { class: 'ex-h3', text: 'It also stops at once for' }),
    h('ul', { class: 'ex-guard-list' }, ['a CAPTCHA', 'a login wall', 'a verification code', 'a bot check'].map((text) => h('li', {}, h('span', { class: 'ex-band-lamp', 'aria-hidden': 'true' }), text))),
    h('p', { class: 'ex-guards-note', text: 'Nothing tries to get past any of them. The window stays open and the page is yours.' }));
  return station(stage, h('div', { class: 'ex-split ex-split-flip' }, form, h('div', {}, copyBlock(stage), guards)));
}

/* ───────────────────────── 5. Track ───────────────────────── */

function trackStation(stage) {
  const outcomes = ['Awaiting response', 'Interviewing', 'Offer', 'Hired'];
  const line = h('ol', { class: 'ex-outline', 'aria-label': 'Outcome' }, outcomes.map((text, index) => h('li', {
    class: `ex-outstop${index === 1 ? ' is-current' : index < 1 ? ' is-past' : ''}`, 'aria-current': index === 1 ? 'step' : null,
  }, h('span', { class: 'ex-outstop-dot', 'aria-hidden': 'true' }), h('span', { class: 'ex-outstop-name', text }))));
  const history = figure('ex-historyfig', [
    line,
    h('ol', { class: 'ex-history' }, TRACK_DEMO.map((event, index) => h('li', { class: 'ex-event', style: `--i:${index}` },
      h('span', { class: 'ex-event-when', text: event.when }),
      h('span', { class: 'ex-event-what', text: event.what }),
      h('span', { class: `ex-event-who${event.who === 'You' ? ' is-you' : ''}`, text: event.who })))),
  ]);
  return station(stage, h('div', { class: 'ex-split ex-split-wide' }, copyBlock(stage), history));
}

const BUILDERS = { discover: discoverStation, score: scoreStation, tailor: tailorStation, fill: fillStation, track: trackStation };

/** The five station sections, with a signal band after Tailor and after Fill. */
export function buildStations() {
  const sections = [];
  for (const stage of JOURNEY) {
    sections.push(BUILDERS[stage.id](stage));
    const gate = GATES.find((g) => g.after === stage.id);
    if (gate) sections.push(signalBand(gate));
  }
  return sections;
}
