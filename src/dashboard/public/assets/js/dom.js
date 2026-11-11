/** DOM helpers: element building, safe hrefs, busy buttons, toasts, time labels. */

export const $ = (id) => document.getElementById(id);

/* ─────────────────────────── utilities ─────────────────────────── */

export const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Build an element with attributes + children, avoiding innerHTML for data. */
/** Tags that only exist in the SVG namespace — `createElement` yields an inert
 *  HTMLUnknownElement for these, which renders as nothing at all. */
export const SVG_TAGS = new Set(['svg', 'polyline', 'circle', 'path', 'line', 'g', 'rect', 'text']);

export function plainDashes(value) {
  const s = String(value);
  if (!/[–—]/.test(s)) return s;
  return s.replace(/(\S?)(\s*)[–—](\s*)(\S?)/g, (m, a, sp1, sp2, b) => {
    if (a && b && !sp1 && !sp2) return `${a}-${b}`;
    // A numeric range stays a range even when spaced ("1 – 100" -> "1-100").
    if (/\d/.test(a) && /\d/.test(b)) return `${a}-${b}`;
    if (!a) return `${sp1}-${sp2}${b}`;
    if (!b) return `${a}${sp1}-`;
    return /[.,;:!?]/.test(a) ? `${a} ${b}` : `${a}, ${b}`;
  });
}

/** Attributes a person reads (as opposed to ids, data, and URLs). */
const READ_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt']);

/**
 * One of the stylesheet's drawn icons (`--ic-<name>`), decorative and in the
 * current text colour. Replaced Unicode glyphs (→ ↗ « ‹ › ») whose shape and
 * weight changed with the font.
 */
export function icon(name) {
  return el('span', { class: 'mask-ic', style: `--ic: var(--ic-${name})`, 'aria-hidden': 'true' });
}

export function el(tag, attrs = {}, ...children) {
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
    else if (k === 'text') node.textContent = tag === 'textarea' ? v : plainDashes(v);
    else if (READ_ATTRS.has(k)) node.setAttribute(k, plainDashes(v));
    else if (k.startsWith('data-') || k.startsWith('aria-')) node.setAttribute(k, v);
    else if (k === 'for') node.htmlFor = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(tag === 'textarea' ? String(child) : plainDashes(child)));
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
export function safeHref(url) {
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
export async function withBusy(button, fn, { label } = {}) {
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

export function relTime(iso) {
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

/**
 * A "this is slow, and it is working" line for dialogs whose data takes
 * seconds to build (Reports reads the whole database; System health spawns
 * Python and probes the browser). Skeleton bars alone looked identical to a
 * hang. Returns a stop function; the caller replaces the contents after.
 *
 * @param {HTMLElement} host
 * @param {string} message
 * @returns {() => void}
 */
export function slowProgress(host, message) {
  host.textContent = '';
  const elapsed = el('span', { class: 'faint slow-elapsed' });
  host.append(el('div', { class: 'slow-progress', role: 'status' },
    el('span', { class: 'spin', 'aria-hidden': 'true' }), el('span', { text: message }), elapsed),
  el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  const started = Date.now();
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    if (secs >= 1) elapsed.textContent = `${secs} s`;
  }, 1000);
  return () => clearInterval(timer);
}

export const shortStamp = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ');

export function toast(message, tone = '') {
  const host = $('toasts');
  const node = el('div', { class: `toast ${tone}`.trim(), role: 'status', text: message });
  host.append(node);
  // Each toast owns its own timer, so a later toast can never be cut short by
  // an earlier one's timeout (the old single-element toast did exactly that).
  setTimeout(() => node.remove(), tone === 'bad' ? 6000 : 3600);
}
