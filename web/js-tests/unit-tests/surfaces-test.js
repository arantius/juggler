//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A boxed region inside a panel is one of two shared surfaces
 * (patterns/surfaces.css): a `.surface-card`, an item raised off the panel, or
 * a `.surface-well`, a sunken box holding a list, a log or raw text. The
 * settings, catalog, skills, workspace and command-editor boxes wear one of
 * them rather than each choosing a fill and a corner of its own — which is how
 * three cards on the same settings panel came to be lighter, darker and level
 * with it, at three different radii.
 * @module unit-tests/surfaces-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The boxes that wear a shared surface, by the selector of their own base rule. */
const MEMBERS = [
  '.ext-cap', '.tool-item', '.extension-setting-field',
  '.skills-card', '.skills-manage-row', '.skills-section',
  'settings-panel .model-visibility-list', 'settings-panel .logs-viewer',
  '.skill-load-raw', '.workspace-finish-work-list', '.command-editor-preview',
  '.strategy-guidance-text'
];

/** Each surface: its fill token and its corner token. */
const SURFACES = {
  card: { fill: '--bg-tertiary', radius: '--radius-xl' },
  well: { fill: '--bg-primary', radius: '--radius-lg' }
};

/**
 * Every style rule the page carries, from every stylesheet it loaded, layers
 * and media blocks included.
 * @returns {CSSStyleRule[]} The rules, in the order the sheets declare them.
 */
function styleRules() {
  /** @type {CSSStyleRule[]} */
  const found = [];
  /** @param {CSSRuleList} rules */
  const walk = (rules) => {
    for (const rule of rules) {
      const grouped = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (grouped) walk(grouped);
      if (/** @type {CSSStyleRule} */ (rule).selectorText) found.push(/** @type {CSSStyleRule} */ (rule));
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A sheet from another origin refuses to be read; the app's own are same-origin.
    }
  }
  return found;
}

/**
 * The computed value a probe gets for one declaration.
 * @param {string} property - A CSS property.
 * @param {string} value - Its declared value.
 * @returns {string} As the engine computes it.
 */
function computed(property, value) {
  const probe = document.createElement('div');
  probe.style.setProperty(property, value);
  document.body.appendChild(probe);
  const result = getComputedStyle(probe).getPropertyValue(property);
  probe.remove();
  return result;
}

/**
 * The computed width of the shared hairline (0.0625rem, solid). The engine
 * snaps a border to whole device pixels, so this is 1px at a device pixel
 * ratio of 1 or 2 but 0.666667px at 1.5; the probe reads what this display
 * makes of it. A width only computes with a style beside it — none is 0px.
 * @returns {string} As the engine computes it.
 */
function hairline() {
  const probe = document.createElement('div');
  probe.style.borderTop = '0.0625rem solid';
  document.body.appendChild(probe);
  const result = getComputedStyle(probe).borderTopWidth;
  probe.remove();
  return result;
}

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

  check('no boxed region chooses its own fill, border or corner', () => {
    const own = styleRules()
      .filter(rule => MEMBERS.includes(rule.selectorText))
      .filter(rule => ['background', 'background-color', 'border', 'border-radius']
        .some(property => rule.style.getPropertyValue(property) !== ''))
      .map(rule => rule.selectorText);
    assert(own.length === 0, `these still draw a surface of their own: ${own.join(' | ')}`);
  });

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;';
  document.body.appendChild(host);
  try {
    for (const [name, { fill, radius }] of Object.entries(SURFACES)) {
      check(`.surface-${name} is ${fill} with a hairline border and ${radius} corners`, () => {
        host.innerHTML = `<div class="surface-${name}">x</div>`;
        const style = getComputedStyle(/** @type {HTMLElement} */ (host.firstElementChild));
        const wantFill = computed('background-color', `var(${fill})`);
        const wantRadius = computed('border-top-left-radius', `var(${radius})`);
        const wantBorder = computed('border-top-color', 'var(--border-color)');
        const wantWidth = hairline();
        assert(style.backgroundColor === wantFill, `fill ${wantFill}, got ${style.backgroundColor}`);
        assert(style.borderTopLeftRadius === wantRadius, `corner ${wantRadius}, got ${style.borderTopLeftRadius}`);
        assert(style.borderTopStyle === 'solid' && style.borderTopWidth === wantWidth,
          `a ${wantWidth} solid hairline, got ${style.borderTopWidth} ${style.borderTopStyle}`);
        assert(style.borderTopColor === wantBorder, `border ${wantBorder}, got ${style.borderTopColor}`);
      });
    }
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
