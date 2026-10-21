//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tab-list focus is a mode the conversation bar enters and leaves, and the
 * components that stand down for it read it from `services/tab-list-focus.js`
 * — never by finding the bar in the document and reading its classes.
 * @module unit-tests/tab-list-focus-test
 */

import { assert } from '../utilities/test-helpers.js';
import { isTabListFocused, setTabListFocus } from '../../js/services/tab-list-focus.js';
import '../../js/components/conversation-bar.js';
import '../../js/components/composer.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Mount a bar off screen, beside the tabs container its keyboard setup looks for.
 * @returns {{container: HTMLElement, bar: any}} The container and the bar.
 */
function mountBar() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);
  return { container, bar };
}

/**
 * Connect a composer while nothing holds the keyboard, and report whether it
 * took it.
 * @returns {boolean} Whether the new composer's textarea has focus.
 */
function composerTakesUnclaimedKeyboard() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:400px;';
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);
  try {
    const textarea = box.querySelector('textarea');
    return !!textarea && document.activeElement === textarea;
  } finally {
    container.remove();
  }
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('the bar says when the keyboard enters and leaves its tab list', () => {
    const { container, bar } = mountBar();
    try {
      assert(!isTabListFocused(), 'precondition: nothing holds tab-list focus');
      bar._enterTabListFocus();
      assert(isTabListFocused(), 'entering the tab list must be visible to the components that stand down for it');
      bar._exitTabListFocus();
      assert(!isTabListFocused(), 'leaving it must be too');
    } finally {
      container.remove();
    }
  });

  await run('a bar taken out of the document holds nothing', () => {
    const { container, bar } = mountBar();
    try {
      bar._enterTabListFocus();
      assert(isTabListFocused(), 'precondition: the bar holds tab-list focus');
    } finally {
      container.remove();
    }
    assert(!isTabListFocused(),
      'a removed bar cannot be steering the arrow keys, so the mode must not outlive it');
  });

  await run('one owner leaving does not end another\'s mode', () => {
    const mine = document.createElement('div');
    const theirs = document.createElement('div');
    document.body.append(mine, theirs);
    try {
      setTabListFocus(mine, true);
      setTabListFocus(theirs, false);
      assert(isTabListFocused(), 'only the holder may end the mode');
    } finally {
      setTabListFocus(mine, false);
      mine.remove();
      theirs.remove();
    }
  });

  await run('a composer arriving while the tab list holds the keys leaves them there', () => {
    assert(composerTakesUnclaimedKeyboard(),
      'precondition: a composer arriving on an unclaimed keyboard takes it');
    // Whoever holds the mode — the composer asks the mode, not the document.
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    try {
      setTabListFocus(holder, true);
      assert(!composerTakesUnclaimedKeyboard(),
        'with the tab list holding the keyboard, a new composer must not take it');
    } finally {
      setTabListFocus(holder, false);
      holder.remove();
    }
  });

  return { passed, failed, errors };
}
