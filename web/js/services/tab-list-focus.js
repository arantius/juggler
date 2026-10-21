//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tab-list focus — whether the keyboard is in the conversation bar's tab list,
 * where ↑/↓ switch tabs rather than walk a conversation's items.
 *
 * The conversation bar owns the mode and says when it enters and leaves it.
 * Everything else that must stand down while it holds — a conversation's own
 * arrow-key navigation, a tab's activation focus, a composer taking an
 * unclaimed keyboard — asks here rather than looking for the bar in the
 * document.
 * @module services/tab-list-focus
 */

/** @type {Element|null} The element holding tab-list focus, if any. */
let holder = null;

/**
 * Enter or leave tab-list focus on behalf of `owner`. Leaving is a no-op unless
 * `owner` is the element that entered, so one bar cannot clear another's mode.
 * @param {Element} owner - The element entering or leaving the mode.
 * @param {boolean} focused - Whether it now holds tab-list focus.
 */
export function setTabListFocus(owner, focused) {
  if (focused) holder = owner;
  else if (holder === owner) holder = null;
}

/**
 * Whether the keyboard is in the tab list. An owner that has left the document
 * holds nothing, however it left.
 * @returns {boolean} True while a connected owner holds tab-list focus.
 */
export function isTabListFocused() {
  return holder !== null && holder.isConnected;
}
