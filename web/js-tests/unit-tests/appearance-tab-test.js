//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Settings → Appearance: the theme menu and the tips switch. The language
 * menu has a tab of its own (language-tab-test.js).
 *
 * Under the en-XA pseudo-locale, using the generated web/i18n/en-XA.json (read
 * through /api/i18n/catalog, as the engine reads it), every
 * word the tab shows must come out accented: that is the check that the file
 * has no string left unwrapped, and that the catalogue covers all of them.
 * @module unit-tests/appearance-tab-test
 */

import { assert } from '../utilities/test-helpers.js';
import { AppearanceTab } from '../../js/components/settings/appearance-tab.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * Render the tab into a fresh host.
 * @returns {{host: HTMLElement, tab: AppearanceTab}} The host and the tab.
 */
function mount() {
  const host = document.createElement('div');
  host.innerHTML = '<div id="appearance-form"></div>';
  document.body.appendChild(host);
  const tab = new AppearanceTab(host);
  tab.render();
  return { host, tab };
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  await run('it holds the theme menu and the tips switch, and no language menu', async () => {
    const { host, tab } = mount();
    try {
      assert(host.querySelector('#appearance-theme-select'), 'the theme menu is drawn');
      assert(host.querySelector('input[type="checkbox"]'), 'the tips switch is drawn');
      assert(!host.querySelector('select[id*="language"]'), 'the language menu lives in its own tab');
    } finally {
      tab.dispose();
      host.remove();
    }
  });

  await run('under en-XA every visible string is pseudo-localised', async () => {
    // The engine's route to the catalogue: the same generated file the page
    // is handed inline.
    const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
    assert(body && Object.keys(body.messages || {}).length > 0, 'the en-XA catalogue is empty');
    registerCatalog('appearance-tab-test', PSEUDO_LOCALE, body.messages);
    const previous = setLocale(PSEUDO_LOCALE);
    const { host, tab } = mount();
    try {
      /** @type {string[]} */
      const shown = [];
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.textContent || '').trim();
        if (text) shown.push(text);
      }
      for (const el of host.querySelectorAll('[aria-label], [title], [placeholder]')) {
        for (const attr of ['aria-label', 'title', 'placeholder']) {
          const v = el.getAttribute(attr);
          if (v) shown.push(v);
        }
      }
      assert(shown.length >= 6, `expected the tab's text, found ${shown.length} strings`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    } finally {
      setLocale(previous);
      unregisterCatalog('appearance-tab-test');
      tab.dispose();
      host.remove();
    }
  });

  return { passed, failed, errors };
}
