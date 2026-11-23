/**
 * Keyboard of the drop-down menus that say `role="menu"` (the account menu, the admin row
 * menus), after the WAI-ARIA menu button pattern: opening moves focus to the first item (ArrowUp
 * on the button: the last), the arrow keys and Home / End move between the items, Escape closes
 * the menu and gives focus back to its button, and Tab closes it and moves on from the button.
 */
import type { KeyboardEvent } from 'react';

/** Which item gets focus when a menu opens. */
export type MenuFocus = 'first' | 'last';

/** The enabled items of a menu. */
function menuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(el => !(el as HTMLButtonElement).disabled);
}

/** Focuses the first or last enabled item of a menu. */
export function focusMenuItem(menu: HTMLElement | null, which: MenuFocus): void {
  if (!menu) return;
  const items = menuItems(menu);
  (which === 'first' ? items[0] : items[items.length - 1])?.focus();
}

/** `onKeyDown` of a menu button: ArrowDown / ArrowUp open the menu at its first / last item. */
export function menuButtonKeyDown(e: KeyboardEvent<HTMLElement>, open: (focus: MenuFocus) => void): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  open(e.key === 'ArrowDown' ? 'first' : 'last');
}

/**
 * `onKeyDown` of an open menu (the element with `role="menu"`). `close` closes it and returns
 * focus to its button; Escape is handled the same way.
 */
export function menuKeyDown(e: KeyboardEvent<HTMLElement>, close: () => void): void {
  if (e.key === 'Escape' || e.key === 'Tab') {
    // Tab is not prevented: once focus is back on the button, the browser moves on from there.
    if (e.key === 'Escape') e.preventDefault();
    close();
    return;
  }
  const items = menuItems(e.currentTarget);
  const n = items.length;
  if (n === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % n;
  else if (e.key === 'ArrowUp') next = at < 0 ? n - 1 : (at - 1 + n) % n;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = n - 1;
  else return;
  e.preventDefault();
  items[next]!.focus();
}
