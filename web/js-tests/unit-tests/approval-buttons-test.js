//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the text of an approval's buttons.
 *
 * `buildApprovalButtons` runs in the engine and its options are stored in the
 * conversation, so their labels are English data; `<action-confirmation>`
 * translates them, and words the "don't ask again" descriptor, where it draws
 * them. Under en-XA nothing the buttons show may be plain English. The
 * fixture's patterns are digits, which read as data inside a message.
 * @module unit-tests/approval-buttons
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { isolateFocus } from '../utilities/isolate-focus.js';
import { buildApprovalButtons } from '../../js/services/approval-options.js';
import { buildApprovalOptions } from '../../js/services/response-handler-actions.js';
import { isPseudoLocalized, setLocale } from '../../sdk/lib/i18n.js';
import '../../js/components/action-confirmation.js';

/**
 * Render the standard buttons for `suggestions` in a fresh `<action-confirmation>`.
 * @param {any[]} suggestions - What the plugin's `getApprovalSuggestions` returns.
 * @param {object} [extra] - `setOptions`'s third argument.
 * @returns {any} The element, attached to the document.
 */
function render(suggestions, extra) {
  const el = /** @type {any} */ (document.createElement('action-confirmation'));
  document.body.appendChild(el);
  el.setOptions({ options: buildApprovalButtons({ getApprovalSuggestions: () => suggestions }, {}) }, () => {}, extra);
  return el;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {HTMLElement[]} */
  const made = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      made.splice(0).forEach((el) => el.remove());
    }
  };

  const rules = [{ kind: 'glob', value: '1' }];

  await run('the stored labels are the English source', async () => {
    const opts = buildApprovalButtons({ getApprovalSuggestions: () => [{ itemType: 'execute', rules, patterns: ['1'] }] }, {});
    const labels = opts.map((o) => o.label);
    assert(JSON.stringify(labels) === JSON.stringify(['Yes', "Yes + Don't Ask Again", 'No']),
      `expected English labels in the options, got ${JSON.stringify(labels)}`);
  });

  await run('under en-XA every button shape shows only translated text', async () => {
    await underPseudoLocale('approval-buttons-test', async () => {
      const plain = render([]);
      made.push(plain);
      assertPseudoLocalized(plain, { atLeast: 2, where: 'Yes / No' });

      const single = render([{ itemType: 'execute', rules, patterns: ['1'] }],
        { onRevise: () => ({ valid: false }) });
      made.push(single);
      assert(!!single.querySelector('.pattern-edit-btn'), 'the single-pattern option drew no pencil');
      assertPseudoLocalized(single, { atLeast: 4, where: 'one command pattern, editable' });

      // Lanes share one window's focus, and a blur of the edit input cancels the
      // edit (hiding the notice for good), so a sibling lane's focus() would
      // fail this case. Focus is kept lane-local and a sibling's steal is taken
      // on every run (isolateFocus).
      const input = /** @type {HTMLInputElement} */ (single.querySelector('.pattern-edit-input'));
      const focus = isolateFocus();
      try {
        single.querySelector('.pattern-edit-btn').click();
        focus.steal();
        assert(focus.asked(input), 'editing did not put the cursor in the pattern input');
        await waitFor(() => !single.querySelector('.pattern-edit-notice')?.hidden,
          { description: 'the invalid-pattern notice' });
        assertPseudoLocalized(/** @type {Element} */ (single.querySelector('.pattern-edit-field')),
          { where: 'invalid edit' });
      } finally {
        focus.restore();
      }

      const two = render([{ itemType: 'execute', rules, patterns: ['1', '2'] }]);
      made.push(two);
      assertPseudoLocalized(two, { atLeast: 3, where: 'two patterns' });

      const three = render([{ itemType: 'execute', rules, patterns: ['1', '2', '3'] }]);
      made.push(three);
      assertPseudoLocalized(three, { atLeast: 3, where: 'three patterns' });

      const folder = render([{ itemType: 'read-file', allowedPaths: ['/1'], patterns: ['/1'] }]);
      made.push(folder);
      assertPseudoLocalized(folder, { atLeast: 3, where: 'folder grant' });
    });
  });

  await run('alternatives are listed the way the UI language lists them', async () => {
    const locale = 'de';
    const expected = new Intl.ListFormat(locale, { type: 'disjunction' }).format(['1', '2', '3']);
    assert(expected !== '1, 2, or 3', `${locale} lists alternatives as English does here, so this case proves nothing`);
    const previous = setLocale(locale);
    try {
      const three = render([{ itemType: 'execute', rules, patterns: ['1', '2', '3'] }]);
      made.push(three);
      const text = (three.textContent || '').replace(/\s+/g, ' ');
      assert(text.includes(expected), `expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
    } finally {
      setLocale(previous);
    }
  });

  // The approval's title is built in the engine, which follows the UI language,
  // beside the plugin's own (already translated) getTitle(): it is stored
  // translated, and the plugins that show the title show it as it is.
  await run('the approval title the engine builds is translated under en-XA', async () => {
    await underPseudoLocale('approval-buttons-test-engine', async () => {
      const built = buildApprovalOptions({
        getManifest: () => ({ id: 'read-file', name: 'Read File' }),
        getApprovalSuggestions: () => [],
      }, {});
      assert(isPseudoLocalized(built.title), `plain English approval title under en-XA: ${JSON.stringify(built.title)}`);
    }, { '@juggler/core': ['Read File'] });
  });

  return { passed, failed, errors };
}
