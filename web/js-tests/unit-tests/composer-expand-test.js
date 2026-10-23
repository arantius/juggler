//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The composer's height cap follows the column it sits in, and a capped box can
 * be expanded to fill that column.
 *
 * A fixed pixel cap suits a desktop window and swallows a phone: with the
 * on-screen keyboard up the column is only a few hundred pixels tall, and a box
 * allowed 400 of them leaves no transcript at all. So the cap is a share of the
 * column's height (never more than the desktop cap), and once the text
 * outgrows it an expand button offers the whole column for editing, giving it
 * back when collapsed again or when the message is sent.
 *
 * The column is the box's parent element, sized explicitly here. autoResize is
 * called directly: the keystroke path defers it a frame, and a lane never
 * delivers one (see composer-autoresize-defer-test).
 * @module unit-tests/composer-expand-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/**
 * Mount a <composer-box> in a column of the given height, listeners bound.
 * @param {number} columnHeight - The column's height in px.
 * @returns {{box: any, textarea: HTMLTextAreaElement, button: HTMLButtonElement, container: HTMLElement}} The mounted box, its textarea, its expand button, and the column to remove.
 */
function mountComposer(columnHeight) {
  const container = document.createElement('div');
  container.style.cssText = `position:absolute;left:-9999px;top:0;width:600px;height:${columnHeight}px;display:flex;flex-direction:column;`;
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};
  /** @type {any} */ (box)._messageThread = {
    getContextItems: () => [],
    hasBusyItems: () => false,
    draft: null,
  };

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  const button = /** @type {HTMLButtonElement} */ (box.querySelector('.expand-input-btn'));
  assert(!!textarea, 'composer-box must render a textarea');
  assert(!!button, 'composer-box must render an expand button');
  return { box, textarea, button, container };
}

/** Text far taller than any cap. */
const LONG_TEXT = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');

/**
 * Run the composer height-cap and expand suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  const errors = [];

  /**
   * @param {string} name
   * @param {number} columnHeight
   * @param {(m: ReturnType<typeof mountComposer>) => void} body
   */
  const check = (name, columnHeight, body) => {
    const mounted = mountComposer(columnHeight);
    try {
      body(mounted);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      mounted.container.remove();
    }
  };

  // A tall column keeps the desktop cap.
  check('tall-column-keeps-desktop-cap', 1200, ({ box, textarea }) => {
    textarea.value = LONG_TEXT;
    box.autoResize(textarea);
    assert(textarea.style.height === '400px',
      `a 1200px column must cap the box at 400px, got ${textarea.style.height}`);
    assert(textarea.style.overflowY === 'auto', 'a capped box must scroll');
  });

  // A short column — a phone with its keyboard up — caps the box at a share of it.
  check('short-column-caps-to-share', 360, ({ box, textarea, button }) => {
    textarea.value = LONG_TEXT;
    box.autoResize(textarea);
    const h = parseFloat(textarea.style.height);
    assert(h <= 360 * 0.4 + 1,
      `a 360px column must cap the box at 40% of it (≤144px), got ${textarea.style.height}`);
    assert(textarea.style.overflowY === 'auto', 'a capped box must scroll');
    assert(!button.hidden, 'a box at its cap must offer the expand button');
  });

  // Text that fits needs no expand button.
  check('fitting-text-hides-button', 360, ({ box, textarea, button }) => {
    textarea.value = 'short';
    box.autoResize(textarea);
    assert(button.hidden, 'a box under its cap must not show the expand button');
    assert(!box.hasAttribute('expanded'), 'a fresh box is not expanded');
  });

  // Expanding hands the height to CSS (the column), and collapsing takes it back.
  check('expand-and-collapse', 360, ({ box, textarea, button }) => {
    textarea.value = LONG_TEXT;
    box.autoResize(textarea);
    const capped = textarea.style.height;

    button.click();
    assert(box.hasAttribute('expanded'), 'clicking expand must mark the box expanded');
    assert(button.getAttribute('aria-pressed') === 'true', 'the expanded button must read as pressed');
    assert(textarea.style.height === '', `an expanded box leaves its height to the column, got ${textarea.style.height}`);
    assert(textarea.style.overflowY === 'auto', 'an expanded box must scroll its overflow');

    // Deleting the text keeps it expanded, with the button to collapse it.
    textarea.value = '';
    box.autoResize(textarea);
    assert(box.hasAttribute('expanded'), 'emptying an expanded box must not collapse it');
    assert(!button.hidden, 'an expanded box must always offer the collapse button');

    textarea.value = LONG_TEXT;
    button.click();
    assert(!box.hasAttribute('expanded'), 'clicking again must collapse the box');
    assert(button.getAttribute('aria-pressed') === 'false', 'the collapsed button must read as unpressed');
    assert(textarea.style.height === capped, `a collapsed box returns to its cap ${capped}, got ${textarea.style.height}`);
  });

  // Sending clears the box, and that gives the column back.
  check('send-collapses', 360, ({ box, textarea, button }) => {
    textarea.value = LONG_TEXT;
    box.autoResize(textarea);
    button.click();
    assert(box.hasAttribute('expanded'), 'precondition: expanded');

    box.clearInput();
    assert(!box.hasAttribute('expanded'), 'clearing the box after a send must collapse it');
    assert(button.hidden, 'an emptied, collapsed box must hide the expand button');
  });

  return { passed, failed, errors };
}
