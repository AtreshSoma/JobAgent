/**
 * The chapters of the Product Overview that are pictures: the morning of
 * postings behind the headline, the problem, the five chapter sheets the
 * reader's posting passes through, the two signals only a person can clear,
 * what JobAgent never does, and where its jobs come from.
 *
 * Everything here builds the FINISHED picture: the list already sorted, the
 * score already added up, the form already filled. That is what a reader with
 * reduced motion, a phone, or no script animation sees. The choreography that
 * plays each picture from its "before" to this state lives in motion.js and
 * only ever animates toward what is built here.
 *
 * Every picture is built for one field (content-overview.js, FIELDS), and every
 * score on the page comes from the model the Score Lab uses.
 */
import { glide, h, icon, marked } from './dom.js';
import { statusBadge, topicLink } from './ui.js';
import { LINE_OF, setRuler, tierRuler } from './journey.js';
import { NET, NET_SIGNALS, NET_SIZE, netDrawing } from './deep.js';
import { setField } from './field.js';
import {
  JOURNEY, GATES, PROBLEM, HOOD, HERO_EXTRAS, BOUNDARIES, FIELDS, SCORE_WHATIFS, SCORE_LEAD_ROWS, TIER_GLOSS,
  TRACK_DEMO, TRACK_STAGES, SOURCES, SOURCE_MODES, SOURCE_NOTES, marks, plain, tailorLedger,
} from './content-overview.js';
import { scoreInputs } from './score-model.js';

/** The ground each chapter sheet is played on (tokens.css, Grounds). */
export const GROUND_OF = Object.freeze({ discover: 'night', score: 'ivory', tailor: 'forest', fill: 'mist', track: 'plum' });

const slug = (text) => String(text).toLowerCase().replace(/\s+/g, '-');
const points = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const two = (n) => String(n).padStart(2, '0');
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th'];

/** Each word in its own span, so a statement can arrive word by word. Spaces stay real text. */
function words(text) {
  return String(text).split(' ').flatMap((word, index) => [index ? ' ' : null, h('span', { class: 'ex-w', text: word })]);
}

/** An illustrative picture with its caption. */
function figure(className, children, caption = 'Illustrative example') {
  return h('figure', { class: `ex-demo ${className}` }, children, h('figcaption', { class: 'ex-demo-cap', text: caption }));
}

/** A condition lifted out of a posting: a tag, and the sentence it came from. */
function condition(cond, { pressable = false, id = '' } = {}) {
  const quote = h('span', { class: 'ex-cond-quote', id: id || null, text: `“${cond.sentence}”` });
  if (!pressable) return h('span', { class: 'ex-cond' }, h('span', { class: 'ex-cond-tag' }, icon('note', { size: 13 }), cond.tag), quote);
  // In Discover the tag is a real control: press it to fold the sentence away or bring it back.
  const tag = h('button', {
    type: 'button', class: 'ex-cond-tag', 'aria-expanded': 'true', 'aria-controls': id,
    onClick: () => {
      const open = tag.getAttribute('aria-expanded') !== 'true';
      tag.setAttribute('aria-expanded', String(open));
      quote.hidden = !open;
    },
  }, icon('note', { size: 13 }), cond.tag);
  return h('span', { class: 'ex-cond' }, tag, quote);
}

/* ───────────────────────── hero: a morning of postings ───────────────────────── */

/**
 * Where each card stands: left and top as a share of the field, depth in
 * pixels, and a turn. Placed by hand in a ring, so every kind of work can be
 * read around the posting in front.
 */
const FIELD_AT = Object.freeze([
  { x: 2, y: -6, z: -260, r: -8 }, { x: 37, y: -13, z: -180, r: 5 }, { x: 69, y: -5, z: -360, r: 9 },
  { x: 77, y: 24, z: -150, r: 11 }, { x: -9, y: 27, z: -330, r: -12 }, { x: 75, y: 55, z: -240, r: 8 },
  { x: 3, y: 100, z: -220, r: -6 }, { x: 37, y: 108, z: -380, r: 4 }, { x: 68, y: 96, z: -280, r: 9 },
  { x: -10, y: 66, z: -440, r: -10 }, { x: 80, y: 82, z: -470, r: 6 },
]);

/**
 * The field: one morning of postings in depth, from many kinds of work, with
 * the reader's posting at the front, scored. One picture to assistive technology.
 */
export function heroField(field) {
  const result = scoreInputs(field.inputs);
  const card = (posting, at) => h('div', {
    class: 'ex-fcard',
    // Further away is softer, the way a lens focused on the front card sees the rest.
    style: `--x:${at.x}%;--y:${at.y}%;--z:${at.z}px;--r:${at.r}deg;--blur:${Math.max(0, (-at.z - 240) / 260).toFixed(1)}px`,
    dataset: { depth: String(at.z) },
  },
  h('span', { class: 'ex-fcard-src', text: posting.kind }),
  h('span', { class: 'ex-fcard-title', text: posting.title }),
  h('span', { class: 'ex-fcard-co', text: posting.company }),
  h('span', { class: 'ex-fcard-bars', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')));
  // The other five fields, then other kinds of work: the range is seen before anything is pressed.
  const others = FIELDS.filter((f) => f.id !== field.id).map((f) => ({ kind: f.kind, title: f.job.title, company: f.job.company }));
  const mixed = HERO_EXTRAS.flatMap((extra, i) => [others[i], extra]).filter(Boolean);
  const cards = mixed.slice(0, FIELD_AT.length).map((posting, i) => card(posting, FIELD_AT[i]));
  const ours = h('div', { class: 'ex-fcard is-ours', dataset: { depth: '110' }, style: '--r:-4deg' },
    h('span', { class: 'ex-fcard-src', text: field.kind }),
    h('span', { class: 'ex-fcard-title', text: field.job.title.replace(/-/g, '‑') }),
    h('span', { class: 'ex-fcard-co', text: `${field.job.company}, ${field.job.location}` }),
    h('span', { class: 'ex-fcard-score' },
      h('span', { class: 'ex-fcard-num', text: String(result.total), dataset: { total: String(result.total) } }),
      h('span', { class: 'ex-fcard-verdict' },
        h('span', { class: `ex-tier ex-tier-${slug(result.tier)}`, text: result.tier }),
        h('span', { class: 'ex-fcard-gloss', text: TIER_GLOSS[result.tier] }))));
  return h('div', {
    class: 'ex-crowd', role: 'img',
    'aria-label': `A morning of job postings from many kinds of work. One, ${field.job.title} at ${field.job.company}, comes to the front with a score of ${result.total} out of 100: ${result.tier}. ${TIER_GLOSS[result.tier]}`,
  }, h('div', { class: 'ex-crowd-space' }, cards, ours));
}

/* ───────────────────────── the problem ───────────────────────── */

export function problem() {
  return h('section', { class: 'ex-chapter ex-problem', id: 'why', 'aria-labelledby': 'whyTitle' },
    h('div', { class: 'ex-problem-head' },
      h('h2', { class: 'ex-say', id: 'whyTitle', tabindex: '-1' }, words(PROBLEM.title)),
      h('ul', { class: 'ex-pains' }, PROBLEM.lines.map((line) => h('li', { class: 'ex-pain' },
        h('span', { class: 'ex-pain-text', text: line.pain }),
        h('span', { class: 'ex-pain-fix' }, icon('check', { size: 14 }), line.fix))))),
    h('ol', { class: 'ex-contrast', 'aria-label': 'Three ways to look for work' }, PROBLEM.contrast.map((row) => h('li', { class: row.ours ? 'is-ours' : null },
      h('span', { class: 'ex-contrast-who', text: row.who }),
      h('span', { class: 'ex-contrast-what', text: row.what }),
      h('span', { class: 'ex-contrast-then', text: row.then })))),
    h('p', { class: 'ex-say ex-say-turn' }, words(PROBLEM.turn)));
}

/* ───────────────────────── the chapter sheet ───────────────────────── */

/** The field this sheet's example is for, as a control in the sheet's corner. */
function fieldPick(field, at) {
  const id = `pick-${at}`;
  const select = h('select', { class: 'ex-chrome-pick', id, dataset: { pick: at } },
    FIELDS.map((f) => h('option', { value: f.id, selected: f.id === field.id, text: f.label })));
  select.addEventListener('change', () => setField(select.value, { from: select }));
  return h('span', { class: 'ex-chrome-field' }, h('label', { for: id, text: 'Example' }), select);
}

/**
 * One chapter: a sheet that holds while its picture plays, then is covered by
 * the next. The stage carries the ground; the section is only its runway.
 * `layout` names the composition: split has the words on the left, split-flip
 * on the right.
 */
function scene(stage, index, layout, picture, field) {
  const beats = h('ol', { class: 'ex-beats', style: `--beats:${stage.beats.length}` }, stage.beats.map((beat, i) => h('li', { class: 'ex-beat', dataset: { beat: String(i) } },
    h('span', { class: 'ex-beat-name' }, h('span', { class: 'ex-beat-n', 'aria-hidden': 'true', text: two(i + 1) }), beat.name, beat.status ? [' ', statusBadge(beat.status)] : null),
    h('span', { class: 'ex-beat-text', text: beat.text }))));
  return h('section', {
    class: `ex-chapter ex-scene ex-sheet-chapter ex-scene-${stage.id}`, id: `station-${stage.id}`, 'aria-labelledby': `station-${stage.id}-name`,
    dataset: { line: LINE_OF[stage.id], layout, scene: stage.id },
  }, h('div', { class: 'ex-scene-stage ex-plate', dataset: { ground: GROUND_OF[stage.id] } },
    // The sheet's corner: the chapter's name, where it falls, whose example this is, and the one fact it proves.
    h('div', { class: 'ex-chrome' },
      h('h2', { class: 'ex-scene-name', id: `station-${stage.id}-name`, tabindex: '-1' }, h('span', { class: 'ex-scene-dot', 'aria-hidden': 'true' }), stage.name),
      h('span', { class: 'ex-chrome-at' }, h('span', { class: 'ex-chrome-n', text: two(index + 1) }), h('span', { class: 'ex-chrome-of', text: ` of ${two(JOURNEY.length)}` })),
      fieldPick(field, `station-${stage.id}`),
      h('span', { class: 'ex-chrome-fact', text: stage.fact })),
    h('div', { class: 'ex-scene-inner' },
      h('header', { class: 'ex-scene-head' },
        h('p', { class: 'ex-scene-claim', text: stage.title }),
        h('p', { class: 'ex-scene-body', text: stage.body })),
      h('div', { class: 'ex-scene-notes' },
        beats,
        h('p', { class: 'ex-yours' }, h('span', { class: 'ex-yours-label', text: 'Stays yours' }), stage.yours),
        topicLink(stage.topic, stage.more)),
      h('div', { class: 'ex-scene-pic' }, picture)),
    // How far this chapter has played, drawn as the line it runs on.
    h('span', { class: 'ex-scene-rail', 'aria-hidden': 'true' }),
    // The shade that falls on a sheet as the next one covers it.
    h('span', { class: 'ex-shade', 'aria-hidden': 'true' })));
}

/**
 * A gate between two chapters: a red sheet with a black signal head, set at
 * danger. The posting runs up the line and waits short of it. Nothing on the
 * line moves past this point until a person lets it.
 */
function gate(g, index, field) {
  const after = JOURNEY.find((st) => st.id === g.after);
  const id = `signal-${g.after}`;
  // What is in front of the person at this signal, and the one press that is theirs.
  const card = h('div', { class: 'ex-gate-card' },
    h('p', { class: 'ex-gate-card-job' }, h('strong', { text: field.job.title }), ` ${field.job.company}`),
    h('ul', { class: 'ex-gate-checks' }, g.checks.map((text) => h('li', { class: 'ex-gate-check' }, icon('check', { size: 15 }), h('span', { text })))),
    h('div', { class: 'ex-gate-act' },
      h('span', { class: 'ex-gate-action', 'aria-hidden': 'true', text: g.action }),
      h('span', { class: 'ex-gate-done' }, h('span', { class: 'ex-gate-done-lamp', 'aria-hidden': 'true' }), g.done),
      // The person's own pointer: the press is theirs. Part of the picture only.
      h('span', { class: 'ex-gate-cursor', 'aria-hidden': 'true' }, cursorIcon())));
  return h('section', {
    class: 'ex-chapter ex-gate ex-sheet-chapter', id, 'aria-labelledby': `${id}-title`,
    dataset: { line: LINE_OF[after.id], gate: g.after },
  }, h('div', { class: 'ex-gate-stage ex-plate', dataset: { ground: 'signal' } },
    h('div', { class: 'ex-chrome' },
      h('span', { class: 'ex-chrome-at' }, h('span', { class: 'ex-chrome-n', text: `Signal ${index + 1}` }), h('span', { class: 'ex-chrome-of', text: ` of ${GATES.length}` })),
      h('span', { class: 'ex-chrome-fact', text: g.fact })),
    h('div', { class: 'ex-gate-inner' },
      h('h2', { class: 'ex-gate-title', id: `${id}-title` }, words(`${g.label}.`)),
      h('div', { class: 'ex-gate-head', 'aria-hidden': 'true' },
        h('span', { class: 'ex-gate-lamp is-stop' }), h('span', { class: 'ex-gate-lamp is-clear' })),
      h('div', { class: 'ex-gate-track', 'aria-hidden': 'true' },
        h('span', { class: 'ex-gate-rail' }),
        h('span', { class: 'ex-gate-ahead' }),
        h('span', { class: 'ex-gate-onward' }),
        h('span', { class: 'ex-gate-stopline' }),
        h('span', { class: 'ex-gate-token' }, h('span', { class: 'ex-gate-tag', text: field.job.title }))),
      card,
      h('p', { class: 'ex-gate-text', text: g.detail })),
    h('span', { class: 'ex-shade', 'aria-hidden': 'true' })));
}

/** A pointer, drawn: the person's hand on the one control that is theirs. */
function cursorIcon() {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', '30');
  el.setAttribute('height', '30');
  el.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 3.5l13.5 7.2-6 1.6 3.6 6.6-2.4 1.3-3.6-6.6-4.4 4.3z');
  el.append(path);
  return el;
}

/* ───────────────────────── 1. Discover ───────────────────────── */

function discoverScene(stage, index, field) {
  const face = (row) => [
    h('span', { class: 'ex-board-src', text: row.kind }),
    h('span', { class: 'ex-board-main' },
      h('span', { class: 'ex-board-title', text: row.title }),
      h('span', { class: 'ex-board-meta', text: `${row.company}. ${row.meta}` })),
  ];
  const rows = field.discover.map((row) => h('li', { class: `ex-board-row ex-board-${row.outcome}`, dataset: { outcome: row.outcome } },
    // The merged job first arrives as three separate postings. The two extra
    // copies are part of the animation only: the finished list has one row.
    row.outcome === 'merged' ? [1, 2].map(() => h('span', { class: 'ex-board-copy', 'aria-hidden': 'true' }, face(row))) : null,
    face(row),
    h('span', { class: 'ex-board-out', text: row.label }),
    // The small print of the posting that was kept, lifted out where it can be read.
    row.outcome === 'kept' ? h('span', { class: 'ex-board-cond' }, condition(field.posting.condition, { pressable: true, id: 'discoverCond' })) : null));
  const asked = SOURCES.filter((s) => s.mode === 'on' && s.group === 'ats').slice(0, 5);
  const board = figure('ex-board', [
    h('p', { class: 'ex-feeders' }, h('span', { class: 'ex-feeders-label', text: 'Asked in one search' }),
      asked.map((s) => h('span', { class: 'ex-feeder', text: s.name })),
      h('a', { class: 'ex-feeder ex-feeder-more', href: '#sources', text: `and ${SOURCES.length - asked.length} more` })),
    h('div', { class: 'ex-plane-wrap' }, h('ul', { class: 'ex-board-rows ex-plane' }, rows)),
  ], 'Illustrative example. An employer’s listing carries every kind of job; JobAgent keeps yours.');
  // A link inside the page, not a route: bring the list into view and move focus to it.
  board.querySelector('.ex-feeder-more').addEventListener('click', (event) => {
    event.preventDefault();
    const target = document.getElementById('sources');
    target?.scrollIntoView({ block: 'start', behavior: glide() });
    target?.querySelector('h2')?.focus({ preventScroll: true });
  });
  return scene(stage, index, 'split', board, field);
}

/* ───────────────────────── 2. Score ───────────────────────── */

/** Posting text where {braces} mark a skill of yours found in it and [brackets] a stated requirement. */
function postingText(text) {
  return String(text).split(/(\{[^}]+\}|\[[^\]]+\])/g).filter(Boolean).map((part) => {
    if (part.startsWith('{')) return h('strong', { class: 'ex-hit', text: part.slice(1, -1) });
    if (part.startsWith('[')) return h('mark', { class: 'ex-floor', text: part.slice(1, -1) });
    return part;
  });
}

function scoreScene(stage, index, field) {
  const number = h('span', { class: 'ex-score-num' });
  const tier = h('span', { class: 'ex-tier' });
  const gloss = h('p', { class: 'ex-score-gloss' });
  const note = h('p', { class: 'ex-score-note', role: 'status' });
  const rulerSlot = h('div', { class: 'ex-score-ruler' });
  let ruler = null;

  const bar = (cls, name) => {
    const fill = h('span', { class: 'ex-bar-fill' });
    const num = h('span', { class: 'ex-bar-num' });
    const label = h('span', { class: 'ex-bar-label', text: name });
    return { fill, num, label, el: h('li', { class: `ex-bar ${cls}` }, label, h('span', { class: 'ex-bar-track', 'aria-hidden': 'true' }, fill), num) };
  };
  const lead = SCORE_LEAD_ROWS.map((row) => ({ id: row.id, ...bar('', row.name) }));
  const rest = bar('is-rest', '');
  const penalty = { label: h('span', { class: 'ex-bar-label' }), num: h('span', { class: 'ex-bar-num' }) };
  penalty.el = h('li', { class: 'ex-bar is-penalty' }, penalty.label, penalty.num);

  const buttons = SCORE_WHATIFS.map((w) => h('button', {
    type: 'button', class: 'ex-chip', 'aria-pressed': 'false', dataset: { whatif: w.id },
    onClick: () => show(w),
  }, w.name));

  const lineOf = (id) => plain(field.resume.bullets.find((b) => b.id === id).text);
  const card = figure('ex-scorecard', [
    h('div', { class: 'ex-score-top' },
      h('div', { class: 'ex-score-main' },
        h('p', { class: 'ex-score-figure' }, number, h('span', { class: 'ex-score-side' }, h('span', { class: 'ex-score-of', text: 'out of 100' }), tier)),
        gloss,
        rulerSlot,
        note),
      h('div', { class: 'ex-posting' },
        h('p', { class: 'ex-posting-title', text: field.job.title }),
        h('p', { class: 'ex-posting-co', text: `${field.job.company}, ${field.job.location}` }),
        h('p', { class: 'ex-posting-text' }, h('span', { class: 'ex-posting-label', text: 'Requirements' }), postingText(field.posting.requires)),
        h('p', { class: 'ex-posting-text' }, h('span', { class: 'ex-posting-label', text: 'Nice to have' }), postingText(field.posting.prefers)))),
    h('div', { class: 'ex-score-why' },
      h('section', { class: 'ex-score-col ex-score-points' },
        h('h3', { text: 'Where the points come from' }),
        h('ul', { class: 'ex-bars' }, lead.map((r) => r.el), rest.el, penalty.el)),
      h('section', { class: 'ex-score-col ex-score-evidence' },
        h('h3', { text: 'Shown by your resume' }),
        h('ul', { class: 'ex-ev' },
          field.evidence.map((e) => h('li', {}, h('span', { class: 'ex-ev-skill', text: e.skill }), h('span', { class: 'ex-ev-line', text: lineOf(e.bullet) }))),
          h('li', { class: 'is-gap' }, h('span', { class: 'ex-ev-skill', text: field.gap }), h('span', { class: 'ex-ev-line', text: 'Asked for. Not on your resume, so it is listed as a gap and never added.' })))),
      h('section', { class: 'ex-score-col ex-score-asked' },
        h('h3', {}, 'Also asked for', h('span', { text: 'Word for word from the posting, and outside what JobAgent looks for.' })),
        h('ul', { class: 'ex-ask' }, field.alsoAsked.map((phrase) => h('li', {},
          h('q', { text: phrase }), h('span', { class: 'ex-ask-add' }, icon('plus', { size: 13 }), 'Look for this skill')))))),
    h('div', { class: 'ex-score-presets' },
      h('span', { class: 'ex-score-presets-label', id: 'scoreWhatif', text: 'What if' }),
      h('div', { class: 'ex-chips', role: 'group', 'aria-labelledby': 'scoreWhatif' }, buttons)),
  ], 'Illustrative example. The number is computed by the same arithmetic as the real scorer.');

  /** The verdict in front, and what each part of it is worth. motion.js reads it through `exPaint`. */
  let model = null;

  /**
   * Draw the score as far as it has been added up. `shown` is how much of each
   * reason has been counted (0 to 1); the number is always the sum of what is
   * shown, so wherever the reader stops, the picture agrees with itself.
   */
  function paint(shown = null) {
    const full = !shown;
    const at = (key, i) => (full ? 1 : Math.max(0, Math.min(1, i === undefined ? shown[key] ?? 1 : shown[key]?.[i] ?? 1)));
    let sum = 0;
    lead.forEach((row, i) => {
      row.fill.style.setProperty('--reveal', String(at('lead', i)));
      sum += model.lead[i].points * at('lead', i);
    });
    rest.fill.style.setProperty('--reveal', String(at('rest')));
    sum += model.rest.points * at('rest') + model.penalty * at('penalty');
    // Every point is in once each reason that carries points has been counted in full.
    const done = full || (model.lead.every((row, i) => !row.points || at('lead', i) >= 1) && (!model.rest.points || at('rest') >= 1) && (!model.penalty || at('penalty') >= 1));
    const total = done ? model.total : Math.round((Math.max(0, sum) / model.max) * 100);
    number.textContent = String(total);
    if (ruler) setRuler(ruler, total);
    // The verdict is given only once every point is in.
    card.classList.toggle('is-adding', !done);
  }

  function show(whatif) {
    const result = scoreInputs({ ...field.inputs, ...whatif.inputs });
    const byId = (id) => result.rows.find((r) => r.id === id);
    const others = result.rows.filter((r) => !SCORE_LEAD_ROWS.some((l) => l.id === r.id));
    const sumOf = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
    model = {
      total: result.total, max: result.max,
      lead: lead.map((row) => ({ points: byId(row.id).points, weight: byId(row.id).weight })),
      rest: { points: sumOf(others, 'points'), weight: sumOf(others, 'weight') },
      penalty: sumOf(result.penalties, 'points'),
    };
    number.dataset.total = String(result.total);
    card.dataset.whatif = whatif.id;
    tier.textContent = result.tier;
    tier.className = `ex-tier ex-tier-${slug(result.tier)}`;
    gloss.textContent = TIER_GLOSS[result.tier];
    note.textContent = result.held
      ? `Scored as ${result.rawTier}, held in Queue. ${result.heldReason}`
      : whatif.id === 'this' ? (field.posting.floor ?? '') : 'The same posting, with that one fact changed.';
    note.classList.toggle('is-held', Boolean(result.held));
    if (!ruler) rulerSlot.replaceChildren(ruler = tierRuler(result.total));
    lead.forEach((row, i) => {
      row.fill.style.setProperty('--v', (model.lead[i].points / model.lead[i].weight).toFixed(3));
      row.num.textContent = `${points(model.lead[i].points)} / ${model.lead[i].weight}`;
    });
    rest.label.textContent = `${others.length} smaller reasons`;
    rest.fill.style.setProperty('--v', (model.rest.points / model.rest.weight).toFixed(3));
    rest.num.textContent = `${points(Math.round(model.rest.points * 10) / 10)} / ${model.rest.weight}`;
    penalty.el.hidden = result.penalties.length === 0;
    penalty.label.textContent = result.penalties.map((p) => p.reason).join('. ');
    penalty.num.textContent = points(Math.round(model.penalty * 10) / 10).replace('-', '−');
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.whatif === whatif.id));
    // A choice made here is shown at once, whatever the scene was in the middle of.
    paint(card.exShown ?? null);
  }
  card.exPaint = (shown) => { card.exShown = shown; paint(shown); };
  show(SCORE_WHATIFS[0]);

  return scene(stage, index, 'split-flip', card, field);
}

/* ───────────────────────── 3. Tailor ───────────────────────── */

function tailorScene(stage, index, field) {
  const r = field.resume;
  const kept = r.bullets.filter((b) => b.rank > 0).sort((a, b) => a.rank - b.rank);
  const left = r.bullets.filter((b) => b.rank === 0);
  const ledger = tailorLedger(field);
  const wanted = [...new Set([...marks(field.posting.requires), ...marks(field.posting.prefers)])];
  const bullet = (b, strong, moved) => h('li', {
    class: `ex-sheet-bullet${b.rank === 0 ? ' will-go' : ''}`, dataset: { bullet: b.id, was: String(r.bullets.filter((x) => x.rank > 0).indexOf(b)) },
  }, h('span', { class: 'ex-sheet-text' }, marked(b.text, { strong })),
  moved ? h('span', { class: 'ex-sheet-moved', text: `was ${ORDINAL[r.bullets.indexOf(b)]}` }) : null);

  const master = h('div', { class: 'ex-sheet ex-sheet-master' },
    h('p', { class: 'ex-sheet-tab' }, 'Master resume', h('span', { class: 'ex-sheet-lock' }, icon('lock', { size: 13 }), 'Read-only')),
    h('p', { class: 'ex-sheet-role', text: r.role }),
    h('p', { class: 'ex-sheet-sum' }, marked(r.summary, { strong: false })),
    h('ul', { class: 'ex-sheet-bullets' }, r.bullets.map((b) => bullet(b, false, false))),
    h('p', { class: 'ex-sheet-skills' }, h('span', { class: 'ex-sheet-label', text: 'Skills' }), r.skills.master.join(', ')));
  const skills = r.skills.tailored.flatMap((s, i) => [i ? ', ' : null, wanted.includes(s) ? h('strong', { class: 'ex-kw', text: s }) : s]);
  const tailored = h('div', { class: 'ex-sheet ex-sheet-tailored' },
    h('p', { class: 'ex-sheet-tab' }, 'Tailored for this job', h('span', { class: 'ex-sheet-fit' }, icon('check', { size: 13 }), '2 pages, measured')),
    h('p', { class: 'ex-sheet-role', text: r.role }),
    h('p', { class: 'ex-sheet-sum' }, marked(r.summary, { strong: true })),
    h('ul', { class: 'ex-sheet-bullets' }, kept.map((b) => bullet(b, true, ledger.movedLines.includes(plain(b.text))))),
    h('p', { class: 'ex-sheet-skills' }, h('span', { class: 'ex-sheet-label', text: 'Skills' }), skills));

  const cells = [['Unchanged', ledger.same], ['Moved', ledger.moved], ['Reordered', ledger.reordered], ['Reworded', ledger.reworded], ['Left out', ledger.omitted], ['Added', ledger.added]];
  const spread = figure('ex-spread', [
    h('p', { class: 'ex-wanted' }, h('span', { class: 'ex-wanted-label', text: 'The posting asks for' }),
      wanted.map((term) => h('span', { class: 'ex-want', text: term })), h('span', { class: 'ex-want is-gap', text: field.gap })),
    h('div', { class: 'ex-sheets' }, master, tailored),
    h('div', { class: 'ex-compare' },
      // On a held sheet the caption rides here, where there is room for it (scenes.css).
      h('p', { class: 'ex-compare-title' }, 'Compare with master', h('span', { class: 'ex-compare-cap', 'aria-hidden': 'true', text: 'Illustrative example. Every line on the right is a line from the left.' })),
      h('dl', { class: 'ex-compare-cells' }, cells.map(([name, n]) => h('div', { class: name === 'Added' ? 'is-proof' : null },
        h('dt', { text: name }), h('dd', { text: String(n), dataset: { n: String(n) } })))),
      h('ul', { class: 'ex-compare-notes' },
        h('li', {}, h('strong', { text: 'Left out to fit 2 pages: ' }), `“${plain(left[0].text)}”`),
        h('li', { class: 'ex-gap' }, h('strong', { text: field.gap }), ': in the posting, not in your resume. Reported as a gap, never added.'))),
  ], 'Illustrative example. Every line on the right is a line from the left.');

  // Pointing at a bullet shows where the same sentence sits on the other sheet.
  spread.addEventListener('pointerover', (event) => {
    const id = event.target.closest?.('[data-bullet]')?.dataset.bullet;
    for (const el of spread.querySelectorAll('[data-bullet]')) el.classList.toggle('is-linked', Boolean(id) && el.dataset.bullet === id);
  });
  spread.addEventListener('pointerleave', () => { for (const el of spread.querySelectorAll('.is-linked')) el.classList.remove('is-linked'); });

  return scene(stage, index, 'split', spread, field);
}

/* ───────────────────────── 4. Fill ───────────────────────── */

function fillScene(stage, index, field) {
  const file = `${field.job.company.replace(/\s+/g, '-')}_${field.job.title.split(',')[0].replace(/\s+/g, '-')}.pdf`;
  const fields = [
    { label: 'First name', kind: 'Text', value: field.person.first, from: 'Your profile' },
    { label: 'Email', kind: 'Email', value: field.person.email, from: 'Your profile' },
    { label: 'Resume', kind: 'File', value: file, from: 'Tailored for this job' },
    field.form.extra,
    { label: `Why do you want to work at ${field.job.company}?`, kind: 'Long answer', value: '', from: 'No saved answer' },
  ];
  const ready = h('ul', { class: 'ex-ready', 'aria-label': 'Before filling starts' },
    h('li', { class: field.form.needsAccount ? 'is-wait' : 'is-ok' }, icon(field.form.needsAccount ? 'note' : 'check', { size: 15 }),
      field.form.needsAccount
        ? `${field.job.company} needs an account. Sign in once in this window, then retry every job there.`
        : `${field.job.company} needs no account. Filling can start at once.`),
    h('li', { class: 'is-wait' }, icon('note', { size: 15 }), '1 question has no saved answer. It will be left for you.'));
  const form = figure('ex-formfig', [ready, h('div', { class: 'ex-window' },
    h('p', { class: 'ex-window-bar' },
      h('span', { class: 'ex-window-url', text: `${field.job.title}, ${field.job.company}` }),
      h('span', { class: 'ex-window-note', text: 'A browser window you can watch' })),
    h('div', { class: 'ex-form' },
      h('span', { class: 'ex-scanline', 'aria-hidden': 'true' }),
      fields.map((f) => h('div', { class: `ex-field ex-field-${f.value ? 'filled' : 'ask'}` },
        h('span', { class: 'ex-field-label', text: f.label }),
        // What the field was recognized as gives way to where its answer comes from.
        h('span', { class: 'ex-field-tag' },
          h('span', { class: 'ex-field-kind', 'aria-hidden': 'true', text: f.kind }),
          h('span', { class: 'ex-field-from', text: f.from })),
        h('span', { class: 'ex-field-box' }, f.value
          ? [h('span', { class: 'ex-field-value', text: f.value }), h('span', { class: 'ex-field-ok' }, icon('check', { size: 15, label: 'Checked after typing' }))]
          : h('span', { class: 'ex-field-ask', text: 'Left for you' })))),
      h('div', { class: 'ex-halt' },
        h('span', { class: 'ex-halt-text' }, h('span', { class: 'ex-band-lamp', 'aria-hidden': 'true' }), 'JobAgent stops here'),
        h('span', { class: 'ex-halt-button', text: 'Submit application' }),
        h('span', { class: 'ex-halt-yours', text: 'Your click' }))))]);
  return scene(stage, index, 'split-flip', form, field);
}

/* ───────────────────────── 5. Track ───────────────────────── */

function trackScene(stage, index, field) {
  const { names, to } = TRACK_STAGES;
  const app = h('div', { class: 'ex-app' },
    h('span', { class: 'ex-app-title', text: field.job.title }),
    h('span', { class: 'ex-app-co', text: field.job.company }));
  const board = h('ol', { class: 'ex-stages', 'aria-label': 'Outcome' }, names.map((text, i) => h('li', {
    class: `ex-stage${i === to ? ' is-current' : i < to ? ' is-past' : ''}`, 'aria-current': i === to ? 'step' : null,
  }, h('span', { class: 'ex-stage-name', text }), h('span', { class: 'ex-stage-slot' }, i === to ? app : null))));
  const today = h('p', { class: 'ex-today' },
    h('span', { class: 'ex-today-name', text: 'Today' }),
    h('span', { class: 'ex-today-item' }, icon('note', { size: 15 }), `Follow up with ${field.job.company}`),
    h('span', { class: 'ex-today-due', text: 'Due now' }));
  const history = h('ol', { class: 'ex-history' }, TRACK_DEMO.map((event) => h('li', { class: 'ex-event', dataset: { beat: String(event.beat) } },
    h('span', { class: 'ex-event-when', text: event.when }),
    h('span', { class: 'ex-event-what' }, event.beat === 2 ? [icon('mail', { size: 15 }), ' '] : null, event.what),
    h('span', { class: `ex-event-who${event.who === 'You' ? ' is-you' : ''}`, text: event.who }))));
  return scene(stage, index, 'split', figure('ex-trackfig', [board, today, history]), field);
}

const BUILDERS = { discover: discoverScene, score: scoreScene, tailor: tailorScene, fill: fillScene, track: trackScene };

/** The five chapters in order, with a signal after Tailor and after Fill. */
export function buildScenes(field) {
  const sections = [];
  JOURNEY.forEach((stage, index) => {
    sections.push(BUILDERS[stage.id](stage, index, field));
    const g = GATES.find((x) => x.after === stage.id);
    if (g) sections.push(gate(g, GATES.indexOf(g), field));
  });
  return sections;
}

/* ───────────────────────── never ───────────────────────── */

/** What JobAgent will not do, set as large as the claims it answers. */
export function never() {
  return h('section', { class: 'ex-chapter ex-never', id: 'boundaries', 'aria-labelledby': 'neverTitle', dataset: { ground: 'ink' } },
    h('div', { class: 'ex-never-inner' },
      h('div', { class: 'ex-never-side' },
        h('h2', { id: 'neverTitle', class: 'ex-never-word', tabindex: '-1', text: 'Never.' }),
        h('p', { class: 'ex-never-lede', text: 'What JobAgent will not do. Each line is a rule in the code with a test behind it, not a setting you could switch off by accident.' }),
        topicLink('security', 'How these are enforced')),
      h('ul', { class: 'ex-never-list' }, BOUNDARIES.never.map((text) => {
        const [first, ...rest] = text.split('. ');
        return h('li', {}, h('span', { class: 'ex-never-rule', text: rest.length ? `${first}.` : first }),
          rest.length ? h('span', { class: 'ex-never-more', text: rest.join('. ') }) : null);
      })),
      h('div', { class: 'ex-does' },
        h('h3', { class: 'ex-h3', text: 'What it does on its own' }),
        h('ul', { class: 'ex-does-list' }, BOUNDARIES.does.map((text) => h('li', {}, icon('check', { size: 16 }), h('span', { text })))))));
}

/* ───────────────────────── where the jobs come from, and the turn-off ───────────────────────── */

/** Every source, in three columns by what the reader has to do to use it. */
function sourcesBlock() {
  return h('div', { class: 'ex-src', id: 'sources', role: 'region', 'aria-labelledby': 'sourcesTitle', dataset: { line: 'find' } },
    h('div', { class: 'ex-src-head' },
      h('h2', { class: 'ex-big', id: 'sourcesTitle', tabindex: '-1', text: SOURCE_NOTES.title }),
      h('p', { class: 'ex-lede', text: SOURCE_NOTES.lede })),
    h('ul', { class: 'ex-src-cols' }, Object.entries(SOURCE_MODES).map(([mode, name]) => {
      const list = SOURCES.filter((s) => s.mode === mode);
      return h('li', { class: 'ex-src-col', dataset: { mode } },
        h('span', { class: 'ex-src-n', text: String(list.length) }),
        h('h3', { class: 'ex-src-name' }, h('span', { class: `ex-mode ex-mode-${mode}`, 'aria-hidden': 'true' }), name),
        h('p', { class: 'ex-src-note', text: SOURCE_NOTES[mode] }),
        h('ul', { class: 'ex-src-list' }, list.map((s) => h('li', { class: 'ex-source' },
          h('span', { class: 'ex-source-name', text: s.name }), s.how ? h('span', { class: 'ex-source-how', text: s.how }) : null))));
    })));
}

/**
 * The system map as a picture: the network drawn under the hood, with the same
 * coordinates, so the teaser cannot show an architecture the real diagram does
 * not. This is where the reader can turn off the main line.
 */
export function hood() {
  const [w, hgt] = NET_SIZE;
  const stations = Object.entries(NET).map(([id, at]) => h('span', {
    class: 'ex-hood-node', dataset: { line: at.line.split(' ')[0], node: id, ...(at.up ? { up: '' } : {}) }, style: `--x:${at.x};--y:${at.y}`,
  }, h('span', { class: 'ex-hood-dot' }), h('span', { class: 'ex-hood-name', text: at.short })));
  const gates = NET_SIGNALS.map((s) => h('span', { class: 'ex-hood-gate', style: `--x:${s.x};--y:${s.y}`, text: s.label }));
  const map = h('div', {
    class: 'ex-hoodmap', role: 'img', style: `--w:${w};--h:${hgt}`,
    'aria-label': 'The system map: postings come in along the Find line to the database, the Apply line runs from the pipeline through tailoring, your two approvals and the browser to the application site, and the Track line carries outcomes. Every way in shares one local server.',
  }, netDrawing(), stations, gates);
  return h('section', { class: 'ex-chapter ex-hood', id: 'hood', 'aria-labelledby': 'sourcesTitle' },
    sourcesBlock(),
    h('div', { class: 'ex-turnoff' },
      h('div', { class: 'ex-hood-head' },
        h('h2', { class: 'ex-big ex-hood-title', id: 'hoodTitle', tabindex: '-1', text: HOOD.title }),
        h('p', { class: 'ex-lede', text: HOOD.body }),
        h('a', { class: 'ex-btn ex-btn-solid', href: '#/how' }, HOOD.cta, icon('arrow', { size: 16 }))),
      map,
      h('ul', { class: 'ex-hood-facts' }, HOOD.facts.map((fact) => h('li', {},
        h('span', { class: 'ex-hood-fact', text: fact.name }), h('span', { class: 'ex-hood-fact-text', text: fact.text }))))));
}
