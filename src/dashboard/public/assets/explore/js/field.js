/**
 * Explore JobAgent: which field the story is being told for.
 *
 * The Overview follows one application, and "See it for your field" chooses
 * whose. The choice:
 *
 *   - lives in the link, as `?field=<id>` after the route
 *     (`#/overview/score?field=security`), so a link to a chapter carries it;
 *   - is remembered for the visit (sessionStorage), so a link inside the page
 *     that names no field keeps the one in use;
 *   - is announced to screen readers by whoever renders it (overview.js).
 *
 * The default field is never written into the link, so the page's ordinary
 * addresses stay as they were.
 */
import { DEFAULT_FIELD, FIELDS, fieldById } from './content-overview.js';

const KEY = 'jobagent-explore-field';
const listeners = new Set();
let current = DEFAULT_FIELD;

const known = (id) => FIELDS.some((f) => f.id === id);

/** The field named in a hash's query, or null. */
export function fieldFromHash(hash = location.hash) {
  const id = new URLSearchParams(hash.split('?')[1] ?? '').get('field');
  return known(id) ? id : null;
}

/** A hash with the field's query set, or removed for the default field. */
export function hashWithField(hash, id) {
  const route = (hash || '#/overview').split('?')[0];
  return id === DEFAULT_FIELD ? route : `${route}?field=${id}`;
}

function remembered() {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

/** Read the field from the link, then from this visit, then the default. Call once at boot. */
export function initField() {
  const id = fieldFromHash() ?? remembered();
  current = known(id) ? id : DEFAULT_FIELD;
  return current;
}

export function getField() {
  return fieldById(current);
}

/** Keep the link in step with the field in use, without adding a history entry. */
export function syncFieldLink() {
  const want = hashWithField(location.hash, current);
  if (want !== (location.hash || '#/overview') && !(location.hash === '' && current === DEFAULT_FIELD)) {
    history.replaceState(history.state, '', want);
  }
}

/**
 * Choose a field. Listeners are told once, in the order they subscribed.
 * @param {string} id
 * @param {{ from?: Element|null }} [options] the control that made the choice, so focus can return to it
 */
export function setField(id, { from = null } = {}) {
  if (!known(id) || id === current) return;
  current = id;
  try { sessionStorage.setItem(KEY, id); } catch { /* the choice lasts while the page is open */ }
  syncFieldLink();
  for (const listener of listeners) listener(getField(), { from });
}

/** A link followed inside the page may name a field; adopt it, or put the current one back in the link. */
export function adoptFieldFromLink() {
  const id = fieldFromHash();
  if (id && id !== current) setField(id);
  else syncFieldLink();
}

export function onFieldChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
