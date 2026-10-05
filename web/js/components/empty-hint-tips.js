//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <empty-hint-tips> — the rolling tip at the foot of the starting hint (see
 * {@link module:components/empty-hint-stack}): one tip from
 * {@link module:services/tips-manager} at a time, slow-rotating on its own, with
 * ‹ › buttons either side so it is plain there are more to step through.
 *
 * Every tip is in the rotation, seen or not — a hint read at the start of every
 * conversation that ran out of things to say would just vanish. "Seen" only
 * picks where a mount starts: the first tip the user has not yet learnt by
 * doing, searching on from where the previous mount began, so consecutive new
 * conversations open on different tips.
 *
 * On a touch composer the keyboard-shortcut tips teach keys there are none of,
 * so only the feature tips rotate — keyed off the same `(hover: none) and
 * (pointer: coarse)` query the rest of the hint hides its keyboard rows by.
 *
 * Not an ARIA live region — rotating text would spam a screen reader; the same
 * content is available on demand in Settings › Keyboard shortcuts.
 * @module components/empty-hint-tips
 */

import JugglerElement from './juggler-element.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { allTips, isSeen } from '../services/tips-manager.js';

/** @typedef {import('../services/tips-manager.js').Tip} Tip */

/** Rotate to the next tip this often (ms). */
const ROTATE_MS = 20000;

/** The query the starting hint hides its keyboard-only rows by. */
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Index a mount searches for an unseen tip from; each mount moves it on by one,
 * so the next new conversation does not open on the same tip.
 */
let startCursor = 0;

/**
 * @param {'left'|'right'} dir
 * @returns {string} A chevron icon's markup.
 */
function chevron(dir) {
  const points = dir === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6';
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

/**
 * @returns {Tip[]} The tips this composer can use, in priority order.
 */
function rotation() {
  const touch = typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches;
  return touch ? allTips().filter((t) => t.kind !== 'shortcut') : allTips();
}

class EmptyHintTips extends JugglerElement {
  constructor() {
    super();
    /** @type {Tip[]} @private */
    this._tips = [];
    /** @type {number} @private Index into `_tips` of the tip on show. */
    this._index = 0;
    /** @type {ReturnType<typeof setInterval>|null} @private */
    this._timer = null;
  }

  connectedCallback() {
    this._tips = rotation();
    if (this._tips.length === 0) return;
    this._index = this._startIndex();

    this.replaceChildren(
      this._navButton('prev'),
      Object.assign(document.createElement('div'), { className: 'empty-hint-tips__tip' }),
      this._navButton('next'),
    );
    this._render();
    this._restartRotation();
    this.addCleanup(() => this._stopRotation());
  }

  /**
   * The first unseen tip at or after the shared cursor (wrapping), or the
   * cursor's own tip once every one is seen. Moves the cursor on for the next
   * mount.
   * @returns {number} The index to open on.
   * @private
   */
  _startIndex() {
    const n = this._tips.length;
    const from = startCursor % n;
    startCursor = from + 1;
    for (let i = 0; i < n; i++) {
      const idx = (from + i) % n;
      const tip = this._tips[idx];
      if (tip && !isSeen(tip.id)) return idx;
    }
    return from;
  }

  /**
   * @param {'prev'|'next'} which
   * @returns {HTMLButtonElement} A step button.
   * @private
   */
  _navButton(which) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = which === 'prev'
      ? 'btn-ghost empty-hint-tips__nav empty-hint-tips__nav--prev'
      : 'btn-ghost empty-hint-tips__nav empty-hint-tips__nav--next';
    btn.setAttribute('aria-label', which === 'prev' ? 'Previous tip' : 'Next tip');
    btn.innerHTML = chevron(which === 'prev' ? 'left' : 'right');
    btn.addEventListener('click', () => {
      this.step(which === 'prev' ? -1 : 1);
      this._restartRotation();
    });
    return btn;
  }

  /**
   * Move through the tips by `delta`, wrapping at either end.
   * @param {number} delta - +1 for the next tip, -1 for the previous one.
   * @returns {void}
   */
  step(delta) {
    const n = this._tips.length;
    if (n === 0) return;
    this._index = (((this._index + delta) % n) + n) % n;
    this._render();
  }

  /** @returns {string|null} Id of the tip on show, or null when there is none. */
  get currentTipId() {
    return this._tips[this._index]?.id ?? null;
  }

  /**
   * Write the current tip into the tip slot. Shortcut tips lead with the live key
   * glyph, formatted now so a rebinding shows on the next render. Built with
   * createElement/textContent (CSP-safe).
   * @private
   */
  _render() {
    const slot = this.querySelector('.empty-hint-tips__tip');
    const tip = this._tips[this._index];
    if (!slot || !tip) return;

    const title = document.createElement('div');
    title.className = 'empty-hint-tips__title';
    if (tip.kind === 'shortcut' && tip.shortcutId) {
      const combo = keyShortcutManager.formatBinding(tip.shortcutId);
      if (combo) {
        const key = document.createElement('span');
        key.className = 'empty-hint-key empty-hint-tips__key';
        key.textContent = combo;
        title.appendChild(key);
      }
    }
    title.appendChild(document.createTextNode(tip.title));

    const body = document.createElement('div');
    body.className = 'empty-hint-tips__body';
    body.textContent = tip.body;

    slot.replaceChildren(title, body);
    slot.setAttribute('data-tip-id', tip.id);
  }

  /**
   * (Re)start the rotation clock, so a tip the user just stepped to gets its
   * full turn. A hint that is not on screen (its conversation has history, or
   * the tab is in the background) skips the tick rather than rewriting text no
   * one can see.
   * @private
   */
  _restartRotation() {
    this._stopRotation();
    this._timer = setInterval(() => {
      if (this.checkVisibility?.() === false) return;
      this.step(1);
    }, ROTATE_MS);
  }

  /** @private */
  _stopRotation() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

customElements.define('empty-hint-tips', EmptyHintTips);

export default EmptyHintTips;
