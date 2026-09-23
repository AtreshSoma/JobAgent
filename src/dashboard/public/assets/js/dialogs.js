/** Native <dialog> open/close with per-dialog focus return, and the confirm dialog. */

import { $, el } from './dom.js';
import { jobAnchor, sheetReturnId } from './detail.js';
import { menuTrigger } from './menus.js';

/* ─────────────────────────── dialogs ─────────────────────────── */

/**
 * Where focus goes back to when each dialog closes.
 *
 * One shared variable was enough while dialogs never stacked. The detail sheet
 * now opens others on top of itself (Replace URL, I submitted it myself), and
 * the second dialog overwrote the first's return point, so closing the sheet
 * sent focus into a closed dialog. Each dialog now remembers its own.
 */
export const lastFocused = new WeakMap();

export function openDialog(dialog) {
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

export function closeDialog(dialog) {
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
export let pendingConfirm = null;

export function confirmAction(message, onConfirm) {
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

export async function runPendingConfirm() {
  const fn = pendingConfirm;
  pendingConfirm = null;
  closeDialog($('dlgConfirm'));
  if (fn) await fn();
}
