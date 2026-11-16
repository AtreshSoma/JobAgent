/**
 * Liquid glass: the lens of a segmented control.
 *
 * The selected option of a switch (Today | Jobs | Applications, the stage
 * tabs, the "Posted" segments) is shown by one glass lens that sits under the
 * option and glides to the next one when the choice changes. The options
 * themselves stay ordinary buttons with their own state attribute, so nothing
 * about how they work, or what assistive technology hears, changes.
 *
 * WHY IT IS BUILT THIS WAY (each one a stutter that was measured):
 *
 * - It moves on PRESS, not when the app has finished reacting. Switching a
 *   view lays out a whole new screen in the same task as the click; a lens
 *   that waited for the new state started its glide under that work. Moving on
 *   pointerdown gives it the ~100 ms of a press to get going, and the app's
 *   own state change then confirms the same place (no second move).
 * - It animates `transform` only, with the Web Animations API, so the glide
 *   runs on the compositor and keeps its frame rate while the board renders.
 *   The size is set at once and the old size is played back as a scale (FLIP);
 *   animating `width` ran on the main thread and fell out of step.
 * - It is interruptible: a new choice mid-glide starts from where the lens is
 *   on screen, never from where it was going.
 * - It survives a rebuild of its row: the same element is put back, so a glide
 *   in progress carries on.
 * - Its motion is a critically-damped spring (a `linear()` curve sampled from
 *   the spring), which settles without the wobble an overshooting bezier and a
 *   separate stretch keyframe gave it.
 *
 * Reduced motion: the lens moves at once. Reduced transparency: styled solid
 * (app.css, Liquid glass).
 */

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A spring as a CSS `linear()` easing and the time it takes to settle.
 * `bounce` 0 is critically damped; a little (0.1) keeps it alive without a
 * visible overshoot. `response` is the perceptual duration, as in SwiftUI.
 */
export function springEasing({ bounce = 0.1, response = 0.36, points = 48 } = {}) {
  const omega = (2 * Math.PI) / response;
  const zeta = 1 - bounce;
  const decay = zeta * omega;
  const damped = omega * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
  const at = (t) => 1 - Math.exp(-decay * t) * (Math.cos(damped * t) + (decay / damped) * Math.sin(damped * t));
  // Settled when what is left is under a twentieth of a pixel on a 200 px glide.
  const settle = Math.min(1.2, Math.log(4000) / decay);
  const samples = [];
  for (let i = 0; i <= points; i += 1) samples.push(i === points ? 1 : +at((settle * i) / points).toFixed(4));
  return { easing: `linear(${samples.join(', ')})`, duration: Math.round(settle * 1000) };
}

const SPRING = (() => {
  const supported = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)');
  return supported ? springEasing() : { easing: 'cubic-bezier(.32, .72, 0, 1)', duration: 380 };
})();

/**
 * @param {HTMLElement|null} host the switch: a row of options
 * @param {string} selected selector, relative to host, of the selected option
 */
export function glassLens(host, selected) {
  if (!host || host.dataset.glass !== undefined) return;
  host.dataset.glass = '';
  /** Where the lens is going (or rests), in the host's own coordinates. */
  let dest = null;
  /** The option the lens is under; it shows its selected colour at once. */
  let under = null;
  let frame = 0;
  let glide = null;

  const lens = document.createElement('span');
  lens.className = 'glass-lens is-off';
  lens.setAttribute('aria-hidden', 'true');
  host.prepend(lens);

  /** The option elements: anything in the row that is not the lens. */
  const optionOf = (node) => {
    const option = node instanceof Element ? node.closest('button, [role="tab"]') : null;
    return option && host.contains(option) && option !== host && !option.disabled ? option : null;
  };

  /**
   * A box in the host's own coordinates, to the fraction of a pixel. The
   * offset* properties round to whole pixels, and options are fractional
   * widths, so a lens sized from them could sit a pixel proud of its option.
   */
  function boxOf(node) {
    const r = node.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return { x: r.left - h.left - host.clientLeft + host.scrollLeft, y: r.top - h.top - host.clientTop + host.scrollTop, w: r.width, h: r.height };
  }
  const round = (n) => Math.round(n * 100) / 100;
  const geometry = (option) => {
    const b = boxOf(option);
    return { x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) };
  };

  /** Where the lens is on screen right now, mid-glide included. */
  const shown = () => boxOf(lens);

  function rest(at) {
    lens.style.transform = `translate(${at.x}px, ${at.y}px)`;
    lens.style.width = `${at.w}px`;
    lens.style.height = `${at.h}px`;
  }

  // A resize (window, wrap, a row coming out of hiding, a count that grows in
  // the selected option) lands at once. The selected option is watched too:
  // its width can change while the row as a whole does not.
  // Only a real change counts: a newly watched element reports its size once
  // on its own, and taking that for a resize would snap a press-glide back.
  const sizes = new WeakMap();
  const resized = new ResizeObserver((entries) => {
    let changed = false;
    for (const { target, contentRect } of entries) {
      const size = `${contentRect.width}x${contentRect.height}`;
      if (sizes.has(target) && sizes.get(target) !== size) changed = true;
      sizes.set(target, size);
    }
    if (changed) soon(false);
  });

  function mark(option) {
    if (under === option) return;
    if (under) { under.classList.remove('is-lensed'); resized.unobserve(under); }
    under = option;
    if (under) { under.classList.add('is-lensed'); resized.observe(under); }
  }

  /**
   * Put the lens under `option`.
   * @param {Element} option
   * @param {boolean} animate glide there (false: be there now)
   */
  function moveTo(option, animate) {
    if (!lens.isConnected) host.prepend(lens);
    const at = geometry(option);
    if (!at.w) { lens.classList.add('is-off'); return; }
    mark(option);
    const same = dest && dest.x === at.x && dest.y === at.y && dest.w === at.w && dest.h === at.h;
    if (same && !lens.classList.contains('is-off')) return;
    const wasOff = lens.classList.contains('is-off') || !dest;
    lens.classList.remove('is-off');
    if (!animate || wasOff || still()) {
      glide?.cancel();
      glide = null;
      rest(at);
      dest = at;
      return;
    }
    // FLIP: read where it is now, set where it ends, play the difference back.
    const from = shown();
    glide?.cancel();
    rest(at);
    dest = at;
    const sx = at.w ? from.w / at.w : 1;
    const sy = at.h ? from.h / at.h : 1;
    glide = lens.animate([
      { transform: `translate(${from.x}px, ${from.y}px) scale(${sx}, ${sy})` },
      { transform: `translate(${at.x}px, ${at.y}px)` },
    ], { duration: SPRING.duration, easing: SPRING.easing });
    glide.finished.then(() => { glide = null; }, () => {});
  }

  /** Follow the row's own selection. */
  function place(animate) {
    if (!lens.isConnected) host.prepend(lens);
    const target = host.querySelector(selected);
    if (!target || !target.offsetWidth) {
      lens.classList.add('is-off');
      mark(null);
      return;
    }
    moveTo(target, animate);
  }

  // Batched to one frame: a rebuild is many mutations, and the lens should move once.
  const soon = (animate) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => place(animate));
  };

  // On press, go. The click that follows makes it the app's choice too; a
  // press that ends somewhere else (or is cancelled) goes back to the choice.
  let pressed = null;
  host.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const option = optionOf(event.target);
    if (!option) return;
    pressed = option;
    moveTo(option, true);
  });
  const settleBack = () => {
    if (!pressed) return;
    pressed = null;
    // After the click (if any) has been handled, follow the real selection.
    setTimeout(() => soon(true), 0);
  };
  host.addEventListener('pointercancel', settleBack);
  document.addEventListener('pointerup', settleBack, true);
  // Keyboard activation (Enter, Space) arrives as a click with no press first.
  host.addEventListener('click', (event) => {
    const option = optionOf(event.target);
    if (option && option !== under) moveTo(option, true);
  }, true);

  new MutationObserver((records) => {
    // The lens is part of the row: a rebuild that cleared it gets the SAME
    // element back before the next paint, so a glide in progress carries on.
    if (!lens.isConnected) host.prepend(lens);
    const real = records.some((r) => r.type === 'attributes'
      || [...r.addedNodes, ...r.removedNodes].some((n) => n !== lens));
    if (real) soon(true);
  }).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected', 'hidden'] });
  resized.observe(host);
  document.fonts?.ready.then(() => soon(false));
  place(false);
}
