/**
 * The Product Overview, told in the order a first-time reader needs it:
 *
 *   1. the claim, in plain words, over a morning of postings from many kinds
 *      of work, with the reader's own kind brought to the front
 *   2. the problem, and the one difference that matters
 *   3. the whole route in one look, run by the reader's own hand
 *   4. five chapter sheets the posting passes through, with the two signals
 *      only a person can clear between them
 *   5. what JobAgent never does
 *   6. where its jobs come from, and the turn-off to how it is built
 *   7. what is built and what is not, the questions a newcomer asks, and the
 *      next three steps
 *
 * The whole story is told for one field (field.js); choosing another rebuilds
 * it with that field's posting, score, resume and form. A chapter rail (pinned
 * layout only) shows where the reader is on the line.
 */
import { glide, h, icon, prefersReducedMotion } from './dom.js';
import { buildRoute, LINE_OF } from './journey.js';
import { buildScenes, heroField, hood, never, problem } from './scenes.js';
import { register } from './register.js';
import { setField } from './field.js';
import { CLOSE, FAQ, FIELDS, GATES, HERO, JOURNEY, RUN } from './content-overview.js';

/** "See it for your field": six choices, one pressed. Arrow keys move between them. */
function fieldPicker(field) {
  const options = FIELDS.map((f) => h('button', {
    type: 'button', role: 'radio', class: 'ex-pick', 'aria-checked': String(f.id === field.id), tabindex: f.id === field.id ? '0' : '-1',
    dataset: { field: f.id, pick: `hero-${f.id}` },
    onClick: (event) => setField(f.id, { from: event.currentTarget }),
    onKeydown: (event) => {
      const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = options[(FIELDS.indexOf(f) + step + FIELDS.length) % FIELDS.length];
      next.focus();
      setField(next.dataset.field, { from: next });
    },
  }, h('span', { class: 'ex-pick-full', text: f.label }), h('span', { class: 'ex-pick-short', 'aria-hidden': 'true', text: f.short })));
  return h('div', { class: 'ex-fieldpick' },
    h('p', { class: 'ex-fieldpick-label', id: 'pickLabel' }, h('strong', { text: HERO.pick.label }), h('span', { text: HERO.pick.note })),
    h('div', { class: 'ex-picks', role: 'radiogroup', 'aria-labelledby': 'pickLabel' }, options));
}

function hero(field) {
  return h('section', { class: 'ex-chapter ex-hero', 'aria-labelledby': 'heroTitle' },
    h('h1', { id: 'heroTitle', class: 'ex-hero-title' },
      // Each line rises out of its own mask on load; the outer span is the mask.
      h('span', { class: 'ex-line' }, h('span', { text: 'All the work.' })), ' ',
      // The full stop is drawn as the line's signal lamp: the call is the
      // moment the line is held for you. The real "." stays for assistive tech.
      h('span', { class: 'ex-line ex-hero-call' }, h('span', {}, 'Your call',
        h('span', { class: 'sr-only', text: '.' }), h('span', { class: 'ex-lamp', 'aria-hidden': 'true' })))),
    heroField(field),
    h('div', { class: 'ex-hero-foot' },
      h('p', { class: 'ex-lede', text: HERO.lede }),
      h('div', { class: 'ex-actions' },
        // A link inside the page, not a route: bring the next chapter into view and move focus to it.
        h('a', {
          class: 'ex-btn ex-btn-solid', href: '#why',
          onClick: (event) => {
            event.preventDefault();
            const target = document.getElementById('why');
            target?.scrollIntoView({ block: 'start', behavior: glide() });
            target?.querySelector('h2')?.focus({ preventScroll: true });
          },
        }, HERO.primary, icon('arrow', { size: 16 })),
        h('a', { class: 'ex-btn', href: '/' }, HERO.secondary))),
    h('ul', { class: 'ex-trust' }, HERO.trust.map((t) => h('li', { dataset: { line: t.line } }, h('strong', { text: t.name }), h('span', { text: t.text })))),
    fieldPicker(field));
}

/**
 * The chapter rail: the line itself, as a small pill at the foot of the
 * window while the chapters play. Each station is a link to its chapter; the
 * two signals sit between them. motion.js moves the fill and marks the
 * chapter in view.
 */
function rail() {
  const items = [];
  for (const stage of JOURNEY) {
    items.push(h('li', { class: 'ex-rail-stop', dataset: { stop: stage.id, line: LINE_OF[stage.id] } },
      h('a', { href: `#/overview/${stage.id}`, 'aria-label': stage.name }, h('span', { class: 'ex-rail-dot', 'aria-hidden': 'true' }))));
    if (GATES.some((g) => g.after === stage.id)) items.push(h('li', { class: 'ex-rail-signal', 'aria-hidden': 'true' }));
  }
  return h('nav', { class: 'ex-rail', 'aria-label': 'Chapters', dataset: { ground: 'ink' } },
    h('span', { class: 'ex-rail-now', 'aria-hidden': 'true' }),
    h('div', { class: 'ex-rail-line' }, h('span', { class: 'ex-rail-fill', 'aria-hidden': 'true' }), h('ol', {}, items)));
}

/** The whole route in one look: the posting waits at each signal for the reader's click. */
function runIt(route) {
  const section = h('section', { class: 'ex-chapter ex-run', id: 'run', 'aria-labelledby': 'runTitle' },
    h('div', { class: 'ex-run-head' },
      h('h2', { id: 'runTitle', class: 'ex-big', tabindex: '-1', text: RUN.title }),
      h('p', { class: 'ex-lede', text: RUN.lede })),
    h('div', { class: 'ex-platform' }, route.root));
  // It sets off when it is first seen, not while the reader is still at the top.
  if (typeof IntersectionObserver === 'function') {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      setTimeout(() => route.start(), prefersReducedMotion() ? 0 : 450);
    }, { rootMargin: '0px 0px -25% 0px' });
    seen.observe(route.root);
  } else {
    route.start();
  }
  return section;
}

/** What a newcomer asks before trusting a tool with their job search. */
function faq() {
  return h('section', { class: 'ex-chapter ex-faq', id: 'faq', 'aria-labelledby': 'faqTitle', dataset: { reveal: '' } },
    h('h2', { id: 'faqTitle', class: 'ex-big', tabindex: '-1', text: 'Questions people ask first' }),
    h('div', { class: 'ex-faq-list' }, FAQ.map((item, i) => h('details', { class: 'ex-faq-item', open: i === 0 },
      h('summary', {}, h('span', { class: 'ex-faq-q', text: item.q }), h('span', { class: 'ex-faq-mark', 'aria-hidden': 'true' })),
      h('p', { class: 'ex-faq-a', text: item.a })))));
}

function closing() {
  return h('section', { class: 'ex-chapter ex-close', 'aria-labelledby': 'closeTitle', dataset: { reveal: '' } },
    h('h2', { id: 'closeTitle', class: 'ex-close-title', text: CLOSE.title }),
    h('div', { class: 'ex-close-side' },
      h('p', { class: 'ex-lede', text: CLOSE.lede }),
      h('ol', { class: 'ex-next' }, CLOSE.steps.map((step) => h('li', {}, h('span', { class: 'ex-next-name', text: step.name }), h('span', { class: 'ex-next-text', text: step.text })))),
      h('p', { class: 'ex-close-after', text: CLOSE.after }),
      h('div', { class: 'ex-actions' },
        h('a', { class: 'ex-btn ex-btn-solid', href: '/' }, CLOSE.cta, icon('arrow', { size: 16 })))));
}

/** Build the whole Overview into `root` for one field. Returns the route so the caller can retire it. */
export function renderOverview(root, field) {
  const route = buildRoute(field);
  root.dataset.field = field.id;
  root.replaceChildren(
    hero(field),
    problem(),
    runIt(route),
    ...buildScenes(field),
    never(),
    hood(),
    register(),
    faq(),
    closing(),
    rail());
  return route;
}
