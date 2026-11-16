/**
 * Liquid glass: the lens of a segmented control.
 *
 * The selected option of a switch (Today | Jobs | Applications, the stage
 * tabs, the "Posted" segments) is shown by one glass lens that sits under the
 * option and slides to the next one when the choice changes, stretching a
 * little on the way like a drop of water pulled between two points. The
 * options themselves stay ordinary buttons with their own state attribute, so
 * nothing about how they work, or what assistive technology hears, changes.
 *
 * The lens follows the DOM, not the code that changes it: a MutationObserver
 * watches the selection attribute and the children (the stage tabs are
 * rebuilt from scratch on every count update), and a ResizeObserver keeps it
 * under its option when the layout moves. When the tabs are rebuilt, the new
 * lens starts where the old one was, so a change of tab still slides.
 *
 * Reduced motion: the lens moves at once. Reduced transparency: styled solid
 * (app.css, Liquid glass).
 */

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {HTMLElement|null} host the switch: a row of options
 * @param {string} selected selector, relative to host, of the selected option
 */
export function glassLens(host, selected) {
  if (!host || host.dataset.glass !== undefined) return;
  host.dataset.glass = '';
  /** Where the lens was last put, in the host's own coordinates. */
  let last = null;
  let frame = 0;

  function lensOf() {
    let lens = host.querySelector(':scope > .glass-lens');
    if (lens) return { lens, fresh: false };
    lens = document.createElement('span');
    lens.className = 'glass-lens';
    lens.setAttribute('aria-hidden', 'true');
    host.prepend(lens);
    return { lens, fresh: true };
  }

  function jump(lens, at) {
    lens.style.transition = 'none';
    put(lens, at);
    lens.getBoundingClientRect();
    lens.style.removeProperty('transition');
  }

  function put(lens, at) {
    lens.style.transform = `translate(${at.x}px, ${at.y}px)`;
    lens.style.width = `${at.w}px`;
    lens.style.height = `${at.h}px`;
  }

  function place(animate) {
    const { lens, fresh } = lensOf();
    const target = host.querySelector(selected);
    if (!target || !target.offsetWidth) {
      lens.classList.add('is-off');
      return;
    }
    const at = { x: target.offsetLeft, y: target.offsetTop, w: target.offsetWidth, h: target.offsetHeight };
    // A rebuilt row gets a new lens: it starts where the old one stood.
    if (fresh && last) jump(lens, last);
    const moved = last && (last.x !== at.x || last.w !== at.w);
    if (!animate || still() || !last) jump(lens, at);
    else put(lens, at);
    lens.classList.remove('is-off');
    if (animate && moved && !still()) {
      lens.classList.remove('is-moving');
      void lens.offsetWidth;
      lens.classList.add('is-moving');
    }
    last = at;
  }

  // Batched to one frame: a rebuild is many mutations, and the lens should move once.
  const soon = (animate) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => place(animate));
  };

  new MutationObserver((records) => {
    // The lens's own insertion is a mutation too; it changes nothing to follow.
    const real = records.some((r) => r.type === 'attributes'
      || [...r.addedNodes, ...r.removedNodes].some((n) => !(n instanceof Element && n.classList.contains('glass-lens'))));
    if (real) soon(true);
  }).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected', 'hidden'] });
  new ResizeObserver(() => soon(false)).observe(host);
  document.fonts?.ready.then(() => soon(false));
  place(false);
}
