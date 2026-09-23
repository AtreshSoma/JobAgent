/** More and View: the WAI-ARIA menu-button pattern. */

import { $ } from './dom.js';

/* ─────────────────────── menus ───────────────────────
 * More ▾ and ⚙ View implement the WAI-ARIA menu-button pattern.
 *
 * They declared role="menu" and nothing behind it: opening one left focus on
 * the trigger, the arrow keys did nothing, Escape closed it without returning
 * focus, and tabbing out left it open over the page. The pattern (rather than
 * converting to a disclosure of plain buttons) is kept because the View menu's
 * items ARE radio and checkbox menu items — a disclosure would have to re-say
 * "checked" with aria-pressed on every item and lose the grouping for free.
 *
 * Open: focus moves to the first item (ArrowUp on the trigger: the last).
 * ArrowUp/ArrowDown wrap, Home/End jump, Escape closes and returns focus to
 * the trigger, Tab closes and lets focus move on, and focus leaving the menu
 * by any other route closes it.
 */
export const MENU_TRIGGERS = { mainMenu: 'toggle-menu', viewMenu: 'toggle-view-menu' };

export const menuTrigger = (pop) => document.querySelector(`[data-action="${MENU_TRIGGERS[pop.id]}"]`);

export function menuItems(pop) {
  return [...pop.querySelectorAll('[role^="menuitem"]')]
    .filter((item) => !item.hidden && !item.disabled && item.offsetParent !== null);
}

export function openMenu(pop, { focus = 'first' } = {}) {
  closeMainMenu({ except: pop });
  pop.dataset.open = 'true';
  menuTrigger(pop)?.setAttribute('aria-expanded', 'true');
  const items = menuItems(pop);
  // Items are reached with the arrow keys, so none is a Tab stop of its own.
  for (const item of items) item.tabIndex = -1;
  (focus === 'last' ? items.at(-1) : items[0])?.focus();
}

export function closeMenu(pop, { returnFocus = false } = {}) {
  if (!pop || pop.dataset.open !== 'true') return;
  pop.dataset.open = 'false';
  const trigger = menuTrigger(pop);
  trigger?.setAttribute('aria-expanded', 'false');
  if (returnFocus) trigger?.focus();
}

export function toggleMenu(pop) {
  if (pop.dataset.open === 'true') closeMenu(pop, { returnFocus: true });
  else openMenu(pop);
}

/**
 * Close any open popup menu.
 *
 * Both popups close together on an outside click. The View menu is the
 * exception the caller makes: its own items (density, column ticks) must NOT
 * dismiss it, because changing two columns should not cost two trips back to
 * the button.
 *
 * @param {{ except?: HTMLElement, returnFocus?: boolean }} [options]
 *   returnFocus sends focus back to the trigger of a menu that held it — so
 *   choosing an item never leaves focus inside a menu that just vanished.
 */
export function closeMainMenu({ except = null, returnFocus = false } = {}) {
  for (const popId of Object.keys(MENU_TRIGGERS)) {
    const pop = $(popId);
    if (!pop || pop === except) continue;
    closeMenu(pop, { returnFocus: returnFocus && pop.contains(document.activeElement) });
  }
}

for (const popId of Object.keys(MENU_TRIGGERS)) {
  const pop = $(popId);
  pop.addEventListener('keydown', (event) => {
    const items = menuItems(pop);
    const at = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = items[(at + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(pop, { returnFocus: true });
      return;
    } else if (event.key === 'Tab') {
      closeMenu(pop);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
  const wrap = pop.closest('.menu');
  wrap.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !wrap.contains(event.relatedTarget)) closeMenu(pop);
  });
  menuTrigger(pop).addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openMenu(pop, { focus: event.key === 'ArrowUp' ? 'last' : 'first' });
  });
}
