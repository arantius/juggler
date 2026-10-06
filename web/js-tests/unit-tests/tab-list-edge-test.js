//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A sidebar tab list longer than its room fades out at the bottom, where it
 * carries on under the info rail, and only while there is more of it below.
 *
 * The fade is drawn by .conversation-tabs-viewport, the box that holds the list,
 * and never by .conversation-tabs, the list itself, which scrolls. WebKitGTK
 * composites a masked scroll container wrongly: mid-scroll it paints the mask
 * and clip at a stale offset, so faded copies of rows flash up out of place.
 * @module unit-tests/tab-list-edge-test
 */

import { createTestSession, assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * The sidebar column as render() builds it, for reading computed style off the
 * real stylesheet.
 * @param {string[]} classes - Classes to put on both the viewport and the list,
 *   so a rule keyed to either element is given its chance to apply.
 * @returns {{viewport: HTMLElement, list: HTMLElement, teardown: () => void}} The two elements and the removal of them.
 */
function mountColumn(classes) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:240px;height:400px;';
  const bar = document.createElement('conversation-bar');
  bar.style.cssText = 'position:absolute;inset:0;';
  host.appendChild(bar);
  document.body.appendChild(host);
  bar.innerHTML = `
    <nav class="conversation-bar">
      <div class="conversation-tabs-viewport">
        <menu class="conversation-tabs"></menu>
      </div>
    </nav>`;
  const viewport = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs-viewport'));
  const list = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
  for (const el of [viewport, list]) el.classList.add(...classes);
  return { viewport, list, teardown: () => host.remove() };
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

  await run('a list that fits is not faded', () => {
    const { viewport, teardown } = mountColumn([]);
    try {
      const mask = window.getComputedStyle(viewport).maskImage;
      assert(mask === 'none', `an unmarked viewport carries no mask at all, got ${mask}`);
    } finally {
      teardown();
    }
  });

  await run('a list with rows below the fold fades its bottom edge', () => {
    const { viewport, teardown } = mountColumn(['overflow-end']);
    try {
      const mask = window.getComputedStyle(viewport).maskImage;
      assert(mask !== 'none' && mask.includes('gradient'),
        `the marked viewport masks its bottom edge, got ${mask}`);
    } finally {
      teardown();
    }
  });

  await run('the list itself is never masked', () => {
    const { list, teardown } = mountColumn(['overflow-end']);
    try {
      const mask = window.getComputedStyle(list).maskImage;
      assert(mask === 'none',
        `.conversation-tabs scrolls, so it must not carry the fade, got ${mask}`);
    } finally {
      teardown();
    }
  });

  await run('the bar marks the viewport from the list\'s scroll position', async () => {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:240px;height:300px;';
    // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
    // via document.querySelector, so it must exist somewhere in the document.
    container.appendChild(document.createElement('conversation-tabs-container'));
    const bar = /** @type {any} */ (document.createElement('conversation-bar'));
    bar.style.cssText = 'position:absolute;inset:0;';
    container.appendChild(bar);
    document.body.appendChild(container);
    try {
      bar._session = await createTestSession();
      bar.render();
      const viewport = /** @type {HTMLElement|null} */ (bar.querySelector('nav.conversation-bar > .conversation-tabs-viewport'));
      const list = /** @type {HTMLElement|null} */ (bar.querySelector('.conversation-tabs-viewport > .conversation-tabs'));
      assert(!!viewport && !!list, 'the bar renders its tab list inside a .conversation-tabs-viewport');
      if (!viewport || !list) return;

      // A list far taller than its room, whatever the session holds.
      const tall = document.createElement('li');
      tall.style.cssText = 'flex:0 0 auto;height:3000px;';
      list.appendChild(tall);

      bar._updateTabListOverflow();
      assert(viewport.classList.contains('overflow-end'),
        `with rows below the fold, the bottom is marked, got "${viewport.className}"`);

      list.scrollTop = list.scrollHeight;
      bar._updateTabListOverflow();
      assert(!viewport.classList.contains('overflow-end'),
        `scrolled to the end, nothing is below, got "${viewport.className}"`);

      assert(!list.classList.contains('overflow-end'),
        `and the list itself carries no mark, got "${list.className}"`);
    } finally {
      container.remove();
    }
  });

  return { passed, failed, errors };
}
