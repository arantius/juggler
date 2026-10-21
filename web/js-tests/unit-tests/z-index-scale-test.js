//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The stacking scale in tokens/scale.css is an order, and every layer in it is
 * a rung of its own: two tokens with one value leave the browser to settle by
 * DOM order which of two things sits on top, and a popup appended later beats a
 * tooltip appended earlier. Host chrome stacks only on those rungs, so a bare
 * number in a stylesheet is a rung nobody can see.
 * @module unit-tests/z-index-scale-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The scale, bottom to top. */
const ORDER = ['--z-base', '--z-raised', '--z-controls', '--z-dropdown', '--z-modal', '--z-above-modal', '--z-toast'];

/**
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try { body(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  check('every rung of the stacking scale sits strictly above the one below it', () => {
    const root = getComputedStyle(document.documentElement);
    const values = ORDER.map(token => Number(root.getPropertyValue(token).trim()));
    const shown = ORDER.map((token, i) => `${token}=${values[i]}`).join(' ');
    assert(values.every(Number.isFinite), `every token resolves to a number: ${shown}`);
    assert(values.every((v, i) => i === 0 || v > values[i - 1]), `out of order or tied: ${shown}`);
  });

  check('no stylesheet stacks on a bare number at a host-chrome height', () => {
    const bare = [];
    /** @param {CSSRuleList} rules */
    const walk = (rules) => {
      for (const rule of rules) {
        const grouped = /** @type {CSSGroupingRule} */ (rule).cssRules;
        if (grouped) walk(grouped);
        const style = /** @type {CSSStyleRule} */ (rule).style;
        const z = style?.getPropertyValue('z-index').trim();
        if (z && /^\d+$/.test(z) && Number(z) >= 100) bare.push(`${/** @type {CSSStyleRule} */ (rule).selectorText} { z-index: ${z} }`);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A sheet from another origin refuses to be read; the app's own are same-origin.
      }
    }
    assert(bare.length === 0, `these stack on a number instead of a --z-* token: ${bare.join(' | ')}`);
  });

  return { passed, failed, errors };
}
