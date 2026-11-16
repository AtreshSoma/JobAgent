/**
 * Explore JobAgent: choreography.
 *
 * scenes.js builds every picture in its finished state. This file plays each
 * one from its "before" to that state, so motion only ever shows what changed:
 * postings merge, a score adds up, bullets change order, a form fills and
 * stops, an application moves a stage.
 *
 * Three modes, chosen by the window and the reader's motion setting:
 *
 *   pinned  a wide, tall window. The chapters are a stack of sheets. Each
 *           sheet holds (CSS sticky, see scenes.css) while the scroll position
 *           scrubs its picture, then the next sheet rises over it, tilted a
 *           little, and settles flat while the held one sinks into shade.
 *           A sheet is never emptied before it is covered, so there is always
 *           something on screen and the colour changes at a physical edge.
 *   flow    a phone or a short window. Nothing holds; the same timeline plays
 *           once when its picture is scrolled to.
 *   none    reduced motion, or the library did not load. Nothing here runs
 *           and the page is simply the finished pictures.
 *
 * Scrolling itself is never taken over: the page scrolls natively, so the
 * keyboard, find-in-page and links to a section behave as they always do. The
 * scrubbed timelines trail the scrollbar by a fraction of a second, which is
 * what makes them glide on a stepped mouse wheel.
 *
 * GSAP and ScrollTrigger are vendored (assets/vendor/gsap) and loaded by
 * index.html before this module: the page's Content Security Policy allows
 * no script from another origin.
 */
const html = document.documentElement;
const gsap = globalThis.gsap;
const ScrollTrigger = globalThis.ScrollTrigger;

/** Below this the pictures would have to shrink past easy reading, so the chapters flow instead. */
const WIDE = '(min-width: 1180px) and (min-height: 700px)';
const MOVING = '(prefers-reduced-motion: no-preference)';
/** How far behind the scrollbar a scrubbed picture follows, in seconds. */
const TRAIL = 0.8;

/** Flow-mode pictures that have already played; they are not replayed on a return visit. */
const played = new Set();
let media = null;
let introPlayed = false;

const topH = () => parseFloat(getComputedStyle(html).getPropertyValue('--top-h')) || 60;
const all = (root, selector) => [...root.querySelectorAll(selector)];

/* ───────────────────────── the five pictures ───────────────────────── */

/*
 * Each builder adds its moves to `tl` and returns the time each beat starts,
 * in the order of the stage's `beats` (content-overview.js). `k` scales
 * distances: 1 on a pinned stage, smaller where the picture is narrow.
 *
 * Two rules hold for every picture. A move shows something the product does:
 * arrive, merge, step back, add up, reorder, fill, stop, advance. And wherever
 * the reader stops scrolling, the frame can be read: nothing rests half-lit,
 * stacked on something else, or showing a number that disagrees with itself.
 */

/** Discover: postings arrive in depth, copies merge, mismatches step back, the small print lifts out, the rest line up. */
function discover(section, tl, k) {
  const plane = section.querySelector('.ex-plane');
  const rows = all(section, '.ex-board-row');
  const copies = all(section, '.ex-board-copy');
  const out = (row) => row.querySelector(':scope > .ex-board-out');
  const by = (...outcomes) => rows.filter((row) => outcomes.includes(row.dataset.outcome));
  const [kept] = by('kept');
  const [merged] = by('merged');
  const aside = by('other', 'dropped', 'excluded');
  const held = by('held');
  const cond = section.querySelector('.ex-board-cond');
  // Shallow enough that every card stays readable while it stands in depth.
  const scatter = [
    { x: -44, y: -26, z: -70, r: -3 }, { x: 56, y: -6, z: 50, r: 2.5 }, { x: -70, y: 8, z: -150, r: 4 },
    { x: 36, y: 26, z: -30, r: -3.5 }, { x: -16, y: 40, z: 70, r: 2 },
  ];
  const at = (i) => scatter[i % scatter.length];

  gsap.set(plane, { rotationX: 10 * k, rotationY: -9 * k });
  gsap.set(rows.map(out), { autoAlpha: 0 });
  tl.from(all(section, '.ex-feeder'), { autoAlpha: 0, y: -12, duration: 0.5, stagger: 0.07 }, 0)
    .fromTo(rows,
      { x: (i) => at(i).x * k, y: (i) => at(i).y * k, z: (i) => at(i).z * k - 520, rotation: (i) => at(i).r, scale: 0.94, opacity: 0.2 },
      { z: (i) => at(i).z * k, opacity: 1, duration: 1.5, stagger: 0.16, ease: 'power3.out' }, 0.1)
    // Merge: the two extra copies of one job slide onto it and are gone.
    .fromTo(copies,
      { x: (i) => [130, -110][i] * k, y: (i) => [-52, 46][i] * k, rotation: (i) => [4, -5][i], autoAlpha: 1 },
      { x: 0, y: 0, rotation: 0, duration: 1.1, stagger: 0.12, ease: 'power3.inOut' }, 2.6)
    .to(copies, { autoAlpha: 0, duration: 0.3 }, 3.85)
    .to(out(merged), { autoAlpha: 1, duration: 0.4 }, 3.85);
  // Set aside: each mismatch is labelled with its reason and steps back.
  aside.forEach((row, i) => {
    tl.to(out(row), { autoAlpha: 1, duration: 0.4 }, 4.8 + i * 0.5)
      .to(row, { z: `-=${150 * k}`, opacity: 0.6, duration: 0.8 }, 4.8 + i * 0.5);
  });
  tl.to(held.map(out), { autoAlpha: 1, duration: 0.4 }, 5.9)
    .to(out(kept), { autoAlpha: 1, duration: 0.4 }, 6.3)
    .to(kept, { z: `+=${60 * k}`, duration: 0.7 }, 6.3)
    // Small print: the condition lifts out of the posting that was kept, and opens.
    .fromTo(cond.querySelector('.ex-cond-tag'), { autoAlpha: 0, scale: 0.6, y: 10 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 6.9)
    .fromTo(cond.querySelector('.ex-cond-quote'), { autoAlpha: 0, clipPath: 'inset(0 100% 0 0)' }, { autoAlpha: 1, clipPath: 'inset(0 0% 0 0)', duration: 0.8, ease: 'power2.out' }, 7.25)
    // One list: the field flattens.
    .to(plane, { rotationX: 0, rotationY: 0, duration: 1.6, ease: 'power2.inOut' }, 8.2)
    .to(rows, { x: 0, y: 0, z: 0, rotation: 0, scale: 1, opacity: 1, duration: 1.4, stagger: 0.07, ease: 'power3.inOut' }, 8.2)
    .to({}, { duration: 1.3 });
  return [0, 2.6, 4.8, 6.8, 8.1];
}

/**
 * Score: skills light in the posting, each reason is counted in, and the
 * number is their sum at every instant (scenes.js draws it, through exPaint).
 * The verdict is given only once every point is in. Then the evidence, and
 * what the posting asked for beyond the profile.
 */
function score(section, tl) {
  const card = section.querySelector('.ex-scorecard');
  const hits = all(card, '.ex-hit');
  const s = { l0: 0, l1: 0, l2: 0, l3: 0, l4: 0, rest: 0, penalty: 0 };
  const paint = () => card.exPaint({ lead: [s.l0, s.l1, s.l2, s.l3, s.l4], rest: s.rest, penalty: s.penalty });
  const count = (key, time, duration) => tl.to(s, { [key]: 1, duration, ease: 'none', onUpdate: paint }, time);
  const span = Math.max(1.2, hits.length * 0.42);

  paint();
  count('l0', 0.2, 0.6);
  tl.fromTo(hits, { '--hit': 0 }, { '--hit': 1, duration: 0.4, stagger: 0.42, ease: 'none' }, 0.9);
  // The skills row fills as the skills are found.
  count('l1', 0.9, span);
  const then = 0.9 + span + 0.15;
  count('l2', then, 0.45);
  count('l3', then + 0.5, 0.45);
  count('l4', then + 1, 0.45);
  count('rest', then + 1.5, 0.6);
  count('penalty', then + 2.15, 0.35);
  const done = then + 2.6;
  tl.fromTo(all(card, '.ex-ev li'), { autoAlpha: 0, x: 18 }, { autoAlpha: 1, x: 0, duration: 0.5, stagger: 0.32, ease: 'power3.out' }, done + 0.5)
    .fromTo(card.querySelector('.ex-score-asked'), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.6 }, done + 2.1)
    .fromTo(card.querySelector('.ex-score-presets'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, done + 2.9)
    .to({}, { duration: 1.4 });
  return [0, then - 0.1, done - 0.05, done + 0.4, done + 2];
}

/**
 * Tailor: the posting's terms, the tailored copy rising beside the master,
 * the one line that moves lifted over the rest, emphasis, the line left out
 * to fit, and the ledger of every move. A line in transit is lifted off the
 * sheet and set to one side, so it reads as a card being moved, never as two
 * sentences printed on top of each other.
 */
function tailor(section, tl, k) {
  const master = section.querySelector('.ex-sheet-master');
  const copy = section.querySelector('.ex-sheet-tailored');
  const rows = all(copy, '.ex-sheet-bullet');
  const movers = rows.filter((row) => row.querySelector('.ex-sheet-moved'));
  const stayers = rows.filter((row) => !movers.includes(row));
  const wants = all(section, '.ex-want');
  const found = wants.filter((el) => !el.classList.contains('is-gap'));
  const gapChip = wants.filter((el) => el.classList.contains('is-gap'));
  const compare = section.querySelector('.ex-compare');
  // Where a bullet sat in the master's order, as a distance from where it sits now.
  const fromMaster = (row) => rows[Number(row.dataset.was)].offsetTop - row.offsetTop;

  gsap.set(found, { '--found': 0 });
  gsap.set(gapChip, { '--gap': 0 });
  gsap.set(movers, { zIndex: 3 });
  tl.from(wants, { autoAlpha: 0, y: -14, duration: 0.45, stagger: 0.12 }, 0.1)
    .from(master, { autoAlpha: 0, y: 40 * k, duration: 1.2, ease: 'power3.out' }, 0)
    .fromTo(copy, { autoAlpha: 0, y: 90 * k }, { autoAlpha: 1, y: 0, duration: 1.5, ease: 'power3.out' }, 0.7)
    // Reorder: the line that moves is lifted clear, the others close up, and it lands.
    .fromTo(movers, { y: (i, row) => fromMaster(row), x: 0, '--lift': 0 }, { x: 22 * k, '--lift': 1, duration: 0.5, ease: 'power2.out' }, 2.6)
    .fromTo(stayers, { y: (i, row) => fromMaster(row) }, { y: 0, duration: 1.1, stagger: 0.06, ease: 'power3.inOut' }, 3)
    .to(movers, { y: 0, duration: 1.5, ease: 'power3.inOut' }, 3.1)
    .to(movers, { x: 0, '--lift': 0, duration: 0.5, ease: 'power2.inOut' }, 4.55)
    .fromTo(all(copy, '.ex-sheet-moved'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4 }, 5)
    .fromTo(copy.querySelector('.ex-sheet-skills'), { opacity: 0.25 }, { opacity: 1, duration: 0.6 }, 5)
    // Emphasize: the posting's terms turn bold where they already were.
    .fromTo(all(copy, '.ex-kw'), { '--kw': 0 }, { '--kw': 1, duration: 0.35, stagger: 0.11, ease: 'none' }, 5.6)
    .to(found, { '--found': 1, duration: 0.4, stagger: 0.2, ease: 'none' }, 5.6)
    // Fit: the line that would not fit is struck on the master, and the page count is given.
    .fromTo(all(master, '.will-go'), { '--strike': 0 }, { '--strike': 1, duration: 0.7, ease: 'none' }, 7)
    .fromTo(copy.querySelector('.ex-sheet-fit'), { autoAlpha: 0, scale: 0.7 }, { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'power3.out' }, 7.4)
    .to(gapChip, { '--gap': 1, duration: 0.4, ease: 'none' }, 7.4)
    // Account: the ledger of every move. Added stays at nothing.
    .fromTo(compare, { autoAlpha: 0, y: 22 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 8)
    .fromTo(all(compare, '.ex-compare-cells > div'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.13 }, 8.25)
    .fromTo(compare.querySelector('.is-proof'), { '--proof': 0 }, { '--proof': 1, duration: 0.5, ease: 'power2.out' }, 9.1)
    .fromTo(all(compare, '.ex-compare-notes li'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, stagger: 0.15 }, 9.2)
    .to({}, { duration: 1.4 });
  return [0, 2.5, 5.5, 6.9, 7.9];
}

/** Fill: what is needed first, a scan that names each field, answers typed and checked, one left for you, then it stops. */
function fill(section, tl, k) {
  const win = section.querySelector('.ex-window');
  const form = section.querySelector('.ex-form');
  const fields = all(form, '.ex-field');
  const kinds = fields.map((f) => f.querySelector('.ex-field-kind'));
  const froms = fields.map((f) => f.querySelector('.ex-field-from'));
  const halt = form.querySelector('.ex-halt');

  gsap.set(froms, { autoAlpha: 0 });
  gsap.set(fields, { '--lit': 0 });
  tl.from(all(section, '.ex-ready li'), { autoAlpha: 0, y: 12, duration: 0.5, stagger: 0.3, ease: 'power3.out' }, 0.1)
    .fromTo(win, { y: 50 * k, rotationX: 8 * k }, { y: 0, rotationX: 0, duration: 1.8, ease: 'power3.out' }, 0.2)
    .fromTo(form.querySelector('.ex-scanline'), { y: 0, autoAlpha: 1 }, { y: () => form.offsetHeight, duration: 2.1, ease: 'none' }, 1.2)
    .to(form.querySelector('.ex-scanline'), { autoAlpha: 0, duration: 0.2 }, 3.2)
    .fromTo(kinds, { autoAlpha: 0, x: 10 }, { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.36 }, 1.4)
    .to(fields, { '--lit': 1, duration: 0.3, stagger: 0.36, ease: 'none' }, 1.4)
    // What the field is gives way to where its answer comes from.
    .to(kinds, { autoAlpha: 0, y: -8, duration: 0.25, stagger: 0.28 }, 3.6)
    .to(froms, { autoAlpha: 1, duration: 0.3, stagger: 0.28 }, 3.75)
    .to({}, { duration: 0.1 });
  // Fill and check: one field after another, each read back once typed. The last is left for you.
  fields.forEach((field, i) => {
    const value = field.querySelector('.ex-field-value');
    if (value) {
      const t = 5.2 + i * 0.48;
      tl.fromTo(value, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.4, ease: 'none' }, t)
        .fromTo(field.querySelector('.ex-field-ok'), { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.22 }, t + 0.4);
    } else {
      tl.fromTo(field.querySelector('.ex-field-ask'), { autoAlpha: 0, x: -10 }, { autoAlpha: 1, x: 0, duration: 0.45 }, 7.4);
    }
  });
  tl.fromTo(halt, { autoAlpha: 0, y: 34 }, { autoAlpha: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 8.2)
    .fromTo(halt.querySelector('.ex-band-lamp'), { scale: 0 }, { scale: 1, duration: 0.5, ease: 'power3.out' }, 8.5)
    .to({}, { duration: 1.4 });
  return [0, 1.1, 3.5, 7.3, 8.1];
}

/** Track: steps are recorded, a follow-up comes due, a reply arrives as a suggestion, and the application moves when you confirm. */
function track(section, tl) {
  const events = all(section, '.ex-event');
  const app = section.querySelector('.ex-app');
  const stages = all(section, '.ex-stage');
  const now = stages.findIndex((st) => st.classList.contains('is-current'));
  const of = (beat) => events.filter((e) => e.dataset.beat === String(beat));
  // The application starts one stage back from where the finished picture has
  // it: beside it on a wide board, above it where the stages stand in a column.
  // Measured on screen, where the picture may be scaled to fit, and moved in its own unscaled space.
  const box = (i) => stages[i].getBoundingClientRect();
  const fit = () => Number(section.querySelector('.ex-demo').style.getPropertyValue('--fit')) || 1;
  const back = { x: () => (box(now - 1).left - box(now).left) / fit(), y: () => (box(now - 1).top - box(now).top) / fit() };

  gsap.set(stages[now], { '--on': 0 });
  tl.fromTo(of(0), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.6 }, 0.3)
    .fromTo(section.querySelector('.ex-today'), { autoAlpha: 0, x: -30 }, { autoAlpha: 1, x: 0, duration: 0.7, ease: 'power3.out' }, 2)
    .fromTo(of(1), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 2.4)
    .fromTo(of(2), { autoAlpha: 0, x: 90 }, { autoAlpha: 1, x: 0, duration: 0.9, ease: 'power3.out' }, 3.5)
    .fromTo(app, back, { x: 0, y: 0, duration: 1.7, ease: 'power3.inOut' }, 5.7)
    .to(app, { scale: 1.06, duration: 0.85, ease: 'power2.out' }, 5.7)
    .to(app, { scale: 1, duration: 0.85, ease: 'power2.in' }, 6.55)
    .to(stages[now], { '--on': 1, duration: 1, ease: 'none' }, 6.3)
    .fromTo(of(3), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 7.4)
    .to({}, { duration: 1.6 });
  return [0, 1.9, 3.4, 5.6];
}

const SCENES = { discover, score, tailor, fill, track };

/**
 * A signal, played across the whole time its red sheet is held:
 *
 *   the words and the sentence under them arrive as the sheet lands; the line
 *   draws up to the stop and the posting runs along it and waits, with the
 *   lamp at danger; what the person is shown is ticked off, one line at a
 *   time; their own pointer comes to the one control that is theirs and
 *   presses it; the lamp changes to clear, the line ahead turns solid, and the
 *   posting goes on through.
 *
 * Nothing passes the signal before the press, at any point of the scroll.
 */
function signal(section, tl) {
  const plate = section.querySelector('.ex-plate');
  const line = section.querySelector('.ex-gate-track');
  const token = line.querySelector('.ex-gate-token');
  const card = section.querySelector('.ex-gate-card');
  const action = card.querySelector('.ex-gate-action');
  const cursor = card.querySelector('.ex-gate-cursor');
  const toAction = () => {
    const a = action.getBoundingClientRect();
    const c = cursor.getBoundingClientRect();
    return { x: a.left + a.width * 0.62 - c.left, y: a.top + a.height * 0.55 - c.top };
  };
  const rem = () => parseFloat(getComputedStyle(html).fontSize);
  tl.from(all(section, '.ex-gate-title .ex-w'), { yPercent: 50, autoAlpha: 0, duration: 0.7, stagger: 0.14, ease: 'power3.out' }, 0)
    .from(section.querySelector('.ex-gate-head'), { autoAlpha: 0, y: 40, duration: 0.8, ease: 'power3.out' }, 0.15)
    .from(section.querySelector('.ex-gate-text'), { autoAlpha: 0, y: 18, duration: 0.6 }, 0.35)
    // The posting runs up to the stop and waits. The lamp is at danger.
    .from(line.querySelector('.ex-gate-rail'), { scaleX: 0, duration: 1.3, ease: 'power2.inOut' }, 0.6)
    .fromTo(token, { x: () => -token.offsetLeft }, { x: () => -9 * rem(), duration: 1.3, ease: 'power2.inOut' }, 0.6)
    .from(section.querySelector('.ex-gate-lamp.is-stop'), { scale: 0.2, duration: 0.5, ease: 'back.out(2)' }, 1.75)
    .from(line.querySelector('.ex-gate-ahead'), { autoAlpha: 0, duration: 0.4 }, 1.9)
    // What the person is shown, ticked off one line at a time.
    .from(card, { autoAlpha: 0, y: 46, rotation: -1.5, duration: 0.8, ease: 'power3.out' }, 2.1)
    .from(all(card, '.ex-gate-check'), { autoAlpha: 0, x: -18, duration: 0.45, stagger: 0.32, ease: 'power3.out' }, 2.6)
    .from(all(card, '.ex-gate-check .ex-ic'), { scale: 0, duration: 0.3, stagger: 0.32, ease: 'back.out(3)' }, 2.85)
    .fromTo(action, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 3.6)
    // Their pointer comes to the control, and presses it.
    .fromTo(cursor, { autoAlpha: 0, x: () => toAction().x + 150, y: () => toAction().y + 90 }, { autoAlpha: 1, x: () => toAction().x + 40, y: () => toAction().y + 30, duration: 0.4, ease: 'power2.out' }, 4.1)
    .to(cursor, { x: () => toAction().x, y: () => toAction().y, duration: 0.7, ease: 'power3.inOut' }, 4.5)
    .to(cursor, { scale: 0.82, duration: 0.12, ease: 'power2.in' }, 5.2)
    .to(action, { scale: 0.94, duration: 0.12, ease: 'power2.in' }, 5.2)
    .to(cursor, { scale: 1, duration: 0.2 }, 5.32)
    .to(action, { scale: 1, autoAlpha: 0, duration: 0.3 }, 5.32)
    .fromTo(card.querySelector('.ex-gate-done'), { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(2)' }, 5.45)
    // The lamp changes to clear, the line ahead turns solid, and the posting goes through.
    // Stated at both ends inside the timeline: the sheet's own tilt and shade are tweened too, and a
    // refresh of those must not lose the lamp's starting state.
    .fromTo(plate, { '--clear': 0 }, { '--clear': 1, duration: 0.6, ease: 'power2.out', immediateRender: true }, 5.45)
    .to(token, { x: 0, duration: 1.3, ease: 'power2.inOut' }, 5.9)
    .to(cursor, { autoAlpha: 0, duration: 0.5 }, 6.2)
    .to({}, { duration: 1.6 });
}

/**
 * Open the beat whose moment is playing; the others fold to their names
 * (scenes.css). Returns the function that brings the list up to date.
 */
function followBeats(tl, beats, marks) {
  return () => {
    const now = tl.time();
    const on = marks.reduce((found, mark, i) => (now >= mark - 0.05 ? i : found), 0);
    beats.forEach((beat, i) => beat.classList.toggle('is-on', i === on));
  };
}

/**
 * Scale each picture to the room its held sheet has, so a short window shows
 * the whole of it. Measured before ScrollTrigger measures anything else.
 */
function fitPictures(root) {
  for (const pic of all(root, '.ex-scene-pic')) {
    const demo = pic.querySelector('.ex-demo');
    demo.style.setProperty('--fit', '1');
    demo.style.removeProperty('margin-bottom');
    // Smaller to fit a short window; a little larger to fill a tall one, never past 1.2.
    const fit = Math.min(1.2, pic.clientHeight / demo.offsetHeight, pic.clientWidth / demo.offsetWidth);
    demo.style.setProperty('--fit', fit.toFixed(3));
    // It is scaled from its top edge; giving back (or taking) the height the scale changes keeps it centred.
    if (fit !== 1) demo.style.marginBottom = `${(-(1 - fit) * demo.offsetHeight).toFixed(1)}px`;
  }
}

/* ───────────────────────── the sheets ───────────────────────── */

/**
 * The stack. Each sheet's picture is scrubbed from the moment it is half way
 * up the window until the next sheet starts to rise over it; then the next one
 * peels in, tilted at its leading corner, and the held sheet sinks back into
 * shade beneath it.
 */
function sheets(root, pinned) {
  const chapters = all(root, '.ex-sheet-chapter');
  chapters.forEach((section, index) => {
    const stage = section.querySelector('.ex-plate');
    const isScene = section.classList.contains('ex-scene');
    const id = section.dataset.scene;
    if (!pinned) {
      const key = id ?? section.id;
      if (played.has(key)) return;
      const tl = gsap.timeline({ paused: true, defaults: { ease: 'power2.out' }, onComplete: () => played.add(key) });
      if (isScene) SCENES[id](section, tl, 0.4);
      else signal(section, tl);
      tl.timeScale(2.2);
      ScrollTrigger.create({ trigger: isScene ? section.querySelector('.ex-scene-pic') : stage, start: 'top 74%', once: true, onEnter: () => tl.play() });
      return;
    }

    // The next sheet starts to rise when this section's bottom is one stage
    // below the window's foot (the next section overlaps it by one stage).
    const playEnd = () => `bottom ${innerHeight + stage.offsetHeight}px`;
    let follow = null;
    const tl = gsap.timeline({
      defaults: { ease: 'power2.out' },
      onUpdate: () => follow?.(),
      // A picture starts as its sheet comes to rest, so its moves are watched on a still sheet; a
      // signal's few words start as it rises, so the red sheet is never bare.
      scrollTrigger: { trigger: section, start: () => `top ${Math.round(innerHeight * (isScene ? 0.36 : 0.9))}px`, end: playEnd, scrub: TRAIL, invalidateOnRefresh: true },
    });
    if (isScene) {
      follow = followBeats(tl, all(section, '.ex-beat'), SCENES[id](section, tl, 1));
      follow();
      tl.fromTo(section.querySelector('.ex-scene-rail'), { scaleX: 0 }, { scaleX: 1, duration: tl.duration(), ease: 'none' }, 0);
    } else {
      signal(section, tl);
    }

    // Peeling in: the sheet arrives tilted at its leading corner and lands flat.
    gsap.fromTo(stage, { rotation: index ? 2.2 : 1.4, yPercent: 0 }, {
      rotation: 0, ease: 'none',
      scrollTrigger: { trigger: section, start: 'top bottom', end: () => `top ${topH()}px`, scrub: 0.4, invalidateOnRefresh: true },
    });
    // Covered: the held sheet sinks back and darkens as the next one lands on it.
    const next = chapters[index + 1] ?? root.querySelector('.ex-never');
    if (next) {
      gsap.timeline({ scrollTrigger: { trigger: next, start: 'top bottom', end: () => `top ${topH()}px`, scrub: 0.4, invalidateOnRefresh: true } })
        .fromTo(stage, { scale: 1 }, { scale: 0.92, ease: 'none' }, 0)
        .fromTo(stage.querySelector('.ex-shade'), { opacity: 0 }, { opacity: 0.62, ease: 'none' }, 0);
    }
  });

  // The last cover: Never rises over the held Track sheet the same way.
  const last = root.querySelector('.ex-never');
  if (pinned && last) {
    gsap.fromTo(last, { rotation: 2.2 }, { rotation: 0, ease: 'none', scrollTrigger: { trigger: last, start: 'top bottom', end: () => `top ${topH()}px`, scrub: 0.4, invalidateOnRefresh: true } });
  }
}

/**
 * The chapter rail: shown while the sheets play, filled as far as the reader
 * has come, with the chapter in front named beside it.
 */
function rail(root) {
  const nav = root.querySelector('.ex-rail');
  const chapters = all(root, '.ex-sheet-chapter');
  if (!nav || !chapters.length) return () => {};
  const stops = all(nav, '.ex-rail-stop, .ex-rail-signal');
  const fill = nav.querySelector('.ex-rail-fill');
  const label = nav.querySelector('.ex-rail-now');
  const nameOf = (el) => (el.classList.contains('ex-gate') ? el.querySelector('.ex-gate-title').textContent : el.querySelector('.ex-scene-name').textContent);
  let front = -1;
  const update = () => {
    const line = topH() + 2;
    let i = 0;
    chapters.forEach((el, k) => { if (el.getBoundingClientRect().top <= line + innerHeight * 0.35) i = k; });
    if (i === front) return;
    front = i;
    stops.forEach((el, k) => {
      el.classList.toggle('is-here', k === i);
      el.classList.toggle('is-past', k < i);
    });
    nav.dataset.line = chapters[i].dataset.line ?? '';
    nav.dataset.signal = chapters[i].classList.contains('ex-gate') ? 'true' : 'false';
    label.textContent = nameOf(chapters[i]);
  };
  const shown = ScrollTrigger.create({
    trigger: chapters[0], start: 'top 40%',
    endTrigger: root.querySelector('.ex-never') ?? chapters[chapters.length - 1], end: 'top 60%',
    onToggle: (self) => nav.classList.toggle('is-on', self.isActive),
    onUpdate: (self) => { fill.style.transform = `scaleX(${self.progress.toFixed(4)})`; update(); },
    onRefresh: update,
  });
  update();
  return () => { shown.kill(); nav.classList.remove('is-on'); fill.style.removeProperty('transform'); };
}

/* ───────────────────────── the other chapters ───────────────────────── */

/**
 * The hero's field of postings arrives from depth, turns with the pointer, and
 * flies past as the page moves on, leaving the example posting in front.
 */
function hero(root, pinned) {
  const section = root.querySelector('.ex-hero');
  const space = section.querySelector('.ex-crowd-space');
  const cards = all(space, '.ex-fcard');
  const ours = space.querySelector('.is-ours');
  const tilt = { x: 6, y: -14 };
  gsap.set(space, { rotationX: tilt.x, rotationY: tilt.y });
  // Hand each card's resting place (set in CSS from its custom properties) to GSAP in its own terms.
  for (const card of cards) gsap.set(card, { z: Number(card.dataset.depth), rotationY: parseFloat(card.style.getPropertyValue('--r')) || 0 });
  if (!introPlayed) {
    introPlayed = true;
    gsap.from(cards.filter((card) => card !== ours), { autoAlpha: 0, z: '-=600', duration: 1.6, stagger: { each: 0.06, from: 'random' }, ease: 'power3.out', delay: 0.35 });
    gsap.from(ours, { autoAlpha: 0, y: 40, z: '-=300', duration: 1.4, ease: 'power3.out', delay: 0.9 });
    // Your posting is scored as it comes forward: the number adds up, then the verdict is given.
    const num = ours.querySelector('.ex-fcard-num');
    const total = Number(num.textContent);
    const count = { n: 0 };
    gsap.to(count, { n: total, duration: 1.3, delay: 1.25, ease: 'power2.out', onUpdate: () => { num.textContent = String(Math.round(count.n)); }, onComplete: () => { num.textContent = String(total); } });
    gsap.from(ours.querySelector('.ex-fcard-verdict'), { autoAlpha: 0, x: 14, duration: 0.6, delay: 2.4, ease: 'power3.out' });
  }
  if (!pinned) return null;
  // Scrolled away from, the morning flies past the reader and your posting comes forward. Every
  // value is stated at both ends, so this never inherits a half-played entrance, and it does not
  // draw until the page is scrolled, so the entrance plays undisturbed.
  const scroll = () => ({ trigger: section, start: 'top top', end: 'bottom top', scrub: TRAIL });
  for (const card of cards) {
    if (card === ours) continue;
    const z = Number(card.dataset.depth);
    const depth = Math.abs(z) / 800;
    gsap.fromTo(card, { z, yPercent: 0, opacity: 1 }, { z: z + 380 + 220 * depth, yPercent: -40 - 90 * depth, opacity: 0.3, ease: 'none', immediateRender: false, scrollTrigger: scroll() });
  }
  gsap.fromTo(ours, { z: 110, yPercent: 0, scale: 1 }, { z: 250, yPercent: -18, scale: 1.04, ease: 'none', immediateRender: false, scrollTrigger: scroll() });
  gsap.fromTo(section.querySelector('.ex-hero-title'), { yPercent: 0 }, { yPercent: -14, ease: 'none', immediateRender: false, scrollTrigger: scroll() });
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return null;
  const rx = gsap.quickTo(space, 'rotationX', { duration: 0.9, ease: 'power3.out' });
  const ry = gsap.quickTo(space, 'rotationY', { duration: 0.9, ease: 'power3.out' });
  const move = (event) => {
    const box = section.getBoundingClientRect();
    ry(tilt.y + ((event.clientX - box.left) / box.width - 0.5) * 14);
    rx(tilt.x - ((event.clientY - box.top) / box.height - 0.5) * 10);
  };
  const rest = () => { rx(tilt.x); ry(tilt.y); };
  section.addEventListener('pointermove', move);
  section.addEventListener('pointerleave', rest);
  return () => { section.removeEventListener('pointermove', move); section.removeEventListener('pointerleave', rest); };
}

/**
 * The problem, read at the reader's pace in a wide window and played once on a
 * phone: the statement, then each frustration is crossed off by what JobAgent
 * does about it, then the three ways to look for work side by side, and the turn.
 */
function problem(root, pinned) {
  const section = root.querySelector('.ex-problem');
  const pains = all(section, '.ex-pain');
  const tl = gsap.timeline({
    defaults: { ease: 'power3.out' },
    scrollTrigger: pinned
      ? { trigger: section, start: 'top 72%', end: 'bottom 75%', scrub: TRAIL }
      : { trigger: section, start: 'top 70%', once: true },
  });
  tl.from(all(section, '#whyTitle .ex-w'), { yPercent: 70, autoAlpha: 0, duration: 0.8, stagger: 0.07 }, 0)
    .from(pains, { autoAlpha: 0, x: -24, duration: 0.6, stagger: 0.14 }, 0.25);
  pains.forEach((pain, i) => {
    const t = 1.1 + i * 0.55;
    tl.fromTo(pain, { '--strike': 0 }, { '--strike': 1, duration: 0.45, ease: 'none' }, t)
      .from(pain.querySelector('.ex-pain-fix'), { autoAlpha: 0, x: 16, scale: 0.9, duration: 0.4 }, t + 0.3);
  });
  const cards = all(section, '.ex-contrast li');
  tl.from(cards, { autoAlpha: 0, y: 60, rotation: (i) => [-2, 1.5, -1][i] ?? 0, duration: 0.9, stagger: 0.18 }, 3.5)
    .from(section.querySelector('.ex-contrast .is-ours'), { scale: 0.94, duration: 0.8 }, 3.9)
    .from(all(section, '.ex-say-turn .ex-w'), { yPercent: 70, autoAlpha: 0, duration: 0.7, stagger: 0.05 }, 4.6);
  if (!pinned) tl.timeScale(1.6);
}

/** Parts that simply arrive, once, as they are scrolled to. */
function rise(items) {
  if (!items.length) return;
  gsap.set(items, { autoAlpha: 0, y: 30 });
  ScrollTrigger.batch(items, {
    start: 'top 90%', once: true,
    onEnter: (batch) => gsap.to(batch, { autoAlpha: 1, y: 0, duration: 1, stagger: 0.1, ease: 'power3.out', overwrite: true }),
  });
}

/** Under the hood: the network draws west to east and its stations arrive in the same order. */
function hood(root, pinned) {
  const map = root.querySelector('.ex-hoodmap');
  const x = (el) => Number(el.style.getPropertyValue('--x'));
  const nodes = all(map, '.ex-hood-node').sort((a, b) => x(a) - x(b));
  const tl = gsap.timeline({
    scrollTrigger: pinned ? { trigger: map, start: 'top 84%', end: 'center 50%', scrub: TRAIL } : { trigger: map, start: 'top 76%', once: true },
  });
  tl.fromTo(map.querySelector('.ex-net-svg'), { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 2, ease: 'none' })
    .from(nodes, { autoAlpha: 0, duration: 0.25, stagger: 0.075 }, 0.1)
    .from(nodes.map((node) => node.querySelector('.ex-hood-dot')), { scale: 0.3, duration: 0.3, stagger: 0.075, ease: 'power3.out' }, 0.1)
    .from(all(map, '.ex-hood-gate'), { autoAlpha: 0, y: 8, duration: 0.3, stagger: 0.25 }, 1.35);
  rise(all(root, '.ex-src-head > *, .ex-src-col, .ex-hood-head > *, .ex-hood-facts li, .ex-run-head > *'));
}

/* ───────────────────────── lifecycle ───────────────────────── */

/**
 * Start the Overview's choreography. Call when the Overview is on screen:
 * every distance is measured from the laid-out page.
 */
export function startMotion(root) {
  if (media || !gsap || !ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.config({ ignoreMobileResize: true });
  media = gsap.matchMedia();
  media.add({ pinned: `${WIDE} and ${MOVING}`, still: '(prefers-reduced-motion: reduce)', any: 'all' }, (context) => {
    const { pinned, still } = context.conditions;
    const mode = still ? 'none' : pinned ? 'pinned' : 'flow';
    // The layout follows the mode (scenes.css), so it is set before anything is measured.
    html.dataset.motion = mode;
    if (mode === 'none') return undefined;
    const undo = hero(root, pinned);
    const fit = () => fitPictures(root);
    if (pinned) {
      fit();
      ScrollTrigger.addEventListener('refreshInit', fit);
    }
    problem(root, pinned);
    sheets(root, pinned);
    const unrail = pinned ? rail(root) : () => {};
    rise(all(root, '.ex-never-list li, .ex-does-list li'));
    hood(root, pinned);
    return () => {
      undo?.();
      unrail();
      ScrollTrigger.removeEventListener('refreshInit', fit);
      for (const demo of all(root, '.ex-scene-pic > .ex-demo')) { demo.style.removeProperty('--fit'); demo.style.removeProperty('margin-bottom'); }
      for (const beat of all(root, '.ex-beat')) beat.classList.remove('is-on');
      // The score is drawn by its own scene; put it back to every point counted.
      for (const card of all(root, '.ex-scorecard')) card.exPaint?.(null);
      for (const num of all(root, '.ex-fcard-num')) num.textContent = num.dataset.total;
    };
  });
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
}

/** Stop it and put every picture back to its finished state (the Overview is being hidden). */
export function stopMotion() {
  media?.revert();
  media = null;
  delete html.dataset.motion;
}

/**
 * The story has just been rebuilt for another field: the new posting turns to
 * face the reader, and each picture comes back in. Short, and only where
 * motion is on.
 */
export function fieldSwapped(root) {
  if (!gsap || !html.dataset.motion || html.dataset.motion === 'none') return;
  const ours = root.querySelector('.ex-fcard.is-ours');
  if (ours) gsap.from(ours, { rotationY: 58, autoAlpha: 0, duration: 0.7, ease: 'power3.out' });
  gsap.from(all(root, '.ex-scene-pic, .ex-route-track, .ex-gate-tag'), { autoAlpha: 0, duration: 0.45, ease: 'power2.out', clearProps: 'opacity,visibility' });
}

/** Where a link to a chapter should land: with its sheet in place and its first moment under way. */
export function sceneLanding(section) {
  if (html.dataset.motion !== 'pinned' || !section.classList.contains('ex-sheet-chapter')) return null;
  const stage = section.querySelector('.ex-plate');
  return section.getBoundingClientRect().top + window.scrollY - topH() + stage.offsetHeight * 0.12;
}
