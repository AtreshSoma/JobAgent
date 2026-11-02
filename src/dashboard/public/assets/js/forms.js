/**
 * Unsaved-edit helpers for dialogs that are rebuilt from the server's copy.
 *
 * WHY THIS EXISTS. The Application profile dialog has three sections that save
 * independently (details, queued questions, saved answers), and every save
 * redrew all three from the server's copy. Anything typed into a section that
 * was NOT the one being saved was silently replaced by the stored value — and
 * the "Saved answers" list snapped shut. From the person's side the dialog
 * simply "reset" while they were answering.
 *
 * The browser already knows what a person has changed: a control's `value`
 * differs from its `defaultValue` (the value it was rendered with). So there is
 * no parallel state to keep in step, only a snapshot before the rebuild and a
 * restore after it. Controls are matched by their data-* key, so they survive
 * being replaced by new elements.
 */

/** Attributes that identify a control across a rebuild, most specific first. */
const KEY_ATTRS = ['data-path', 'data-q-answer', 'data-q-patterns', 'data-q-id', 'data-a-answer', 'data-a-patterns'];

const CONTROLS = 'input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]), textarea, select';

/** Identity of a control across a rebuild, or null when it has none. */
export function controlKey(node) {
  for (const attr of KEY_ATTRS) {
    if (node.hasAttribute(attr)) return `${attr}=${node.getAttribute(attr)}`;
  }
  return node.id ? `#${node.id}` : null;
}

const isCheckable = (node) => node.type === 'checkbox' || node.type === 'radio';

/** Has the person changed this control from what it was rendered with? */
export function isEdited(node) {
  if (isCheckable(node)) return node.checked !== node.defaultChecked;
  if (node.tagName === 'SELECT') return [...node.options].some((o) => o.selected !== o.defaultSelected);
  return node.value !== node.defaultValue;
}

/** Does anything under `root` differ from what it was rendered with? */
export function formIsDirty(root) {
  return [...root.querySelectorAll(CONTROLS)].some(isEdited);
}

/** What would put focus back where it was after a rebuild. */
function focusKey(node) {
  if (!node || node === document.body) return null;
  const key = controlKey(node);
  if (key) return key;
  // Buttons have no data key; their words are what a person recognizes.
  return node.tagName === 'BUTTON' ? `button:${node.textContent.trim()}` : null;
}

/**
 * Snapshot what a rebuild would lose.
 *
 * @param {Element} root the container about to be rebuilt
 * @param {{ skip?: string|null }} [options] `skip`: a selector for controls whose edits were
 *   just COMMITTED by the save that caused the rebuild. Those are now the stored value,
 *   so the rebuilt copy is the right one and restoring the typed text would be wrong.
 */
export function snapshotForm(root, { skip = null } = {}) {
  const edits = new Map();
  for (const node of root.querySelectorAll(CONTROLS)) {
    if (skip && node.matches(skip)) continue;
    const key = controlKey(node);
    if (!key || !isEdited(node)) continue;
    edits.set(key, isCheckable(node) ? { checked: node.checked } : { value: node.value });
  }
  const open = new Set([...root.querySelectorAll('details[data-keep]')].filter((d) => d.open).map((d) => d.dataset.keep));
  const active = root.contains(document.activeElement) ? document.activeElement : null;
  const focus = active ? {
    key: focusKey(active),
    start: active.selectionStart ?? null,
    end: active.selectionEnd ?? null,
  } : null;
  return { edits, open, focus };
}

/** Put a snapshot back onto the rebuilt `root`. Controls that no longer exist are skipped. */
export function restoreForm(root, snap) {
  if (!snap) return;
  const controls = [...root.querySelectorAll(CONTROLS)];
  for (const [key, edit] of snap.edits) {
    const node = controls.find((n) => controlKey(n) === key);
    if (!node) continue;
    if ('checked' in edit) node.checked = edit.checked;
    else node.value = edit.value;
  }
  for (const details of root.querySelectorAll('details[data-keep]')) {
    if (snap.open.has(details.dataset.keep)) details.open = true;
  }
  if (snap.focus?.key) {
    const target = [...root.querySelectorAll(`${CONTROLS}, button`)].find((n) => focusKey(n) === snap.focus.key);
    target?.focus({ preventScroll: true });
    if (target && snap.focus.start !== null && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(snap.focus.start, snap.focus.end); } catch { /* not a text control */ }
    }
  }
}
