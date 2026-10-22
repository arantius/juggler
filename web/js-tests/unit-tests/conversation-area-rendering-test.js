//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the transcript helpers draw around the items follows the UI language:
 * the queued-messages zone, the workspace banner in every state it can be in,
 * the compaction fold's result block, and the error row's fallback.
 *
 * Every helper is driven with a stand-in `area` on a detached list, so nothing
 * reaches the server and no custom element connects. Workspace labels, roots
 * and the name a workspace was finished with by are data, written in digits.
 * @module unit-tests/conversation-area-rendering-test
 */

import {
  ensurePendingMessages,
  ensureWorkspaceBanner,
  ensureThreadResult,
  positionElements,
} from '../../js/components/conversation-area-rendering.js';
import { MESSAGE_TYPES } from '../../sdk/lib/message.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * An item that reads like a Y.Map.
 * @param {Record<string, any>} fields
 * @returns {{get: (key: string) => any}} The stand-in item.
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * A root-column area bound to a workspace whose row is `row`.
 * @param {any} row - The workspace row, or null for one the table has lost.
 * @param {string|null} root - What `workspaceRoot` resolves to.
 * @returns {any} The stand-in area.
 */
function boundArea(row, root) {
  return {
    conversation: {
      workspaceId: 'ws_rendering_xa',
      workspaceRoot: root,
      session: { getWorkspace: () => row, selectWorkspace: () => {} },
    },
  };
}

/**
 * Run the conversation-area-rendering test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('en-XA: every state the transcript helpers draw is translated', async () => {
    await underPseudoLocale('conversation-area-rendering-test', async () => {
      /** @type {Array<[string, string]>} */
      const seen = [];
      /**
       * @param {string} where - The state drawn
       * @param {string[]} strings - What it showed
       * @param {number} atLeast - How many it must have shown
       * @returns {void}
       */
      const see = (where, strings, atLeast) => {
        assert(strings.length >= atLeast, `${where}: expected at least ${atLeast} strings, got ${JSON.stringify(strings)}`);
        for (const s of strings) seen.push([where, s]);
      };

      // The queued-messages zone: its label and each bubble's remove button.
      {
        const list = document.createElement('div');
        const thread = { pendingItems: [item({ type: MESSAGE_TYPES.USER, itemId: 'q1', content: '7' })] };
        const area = { getMessageThread: () => thread };
        ensurePendingMessages(area, list);
        const label = list.querySelector('.pending-messages-label');
        const button = list.querySelector('.queued-message-delete-btn');
        assert(!!label && !!button, 'the queue drew no label or no remove button');
        see('queue', [label?.textContent || '', button?.getAttribute('title') || '', button?.getAttribute('aria-label') || ''], 3);
      }

      // The workspace banner, with and without a label. The label and root are data.
      for (const label of ['7', '']) {
        const list = document.createElement('div');
        ensureWorkspaceBanner(boundArea({ id: 'ws_rendering_xa', label, root: '/7/8', state: 'ready', available: true }, '/7/8'), list);
        assert(!!list.querySelector('.workspace-banner-open'), `banner (label ${JSON.stringify(label)}): drew nothing`);
        see(`banner (label ${JSON.stringify(label)})`, shownStrings(list, '.workspace-banner-label, .workspace-banner-root'), 2);
      }

      // The stranded banner: every lead, and both buttons.
      /** @type {Array<[string, any]>} */
      const stranded = [
        ['stranded: no record', null],
        ['stranded: closed by someone', { id: 'ws_rendering_xa', label: '7', root: '/7', state: 'closed', available: true, meta: { closedBy: '8' } }],
        // The stored name is English; a placeholder one is drawn in the UI language.
        ['stranded: closed by an untitled conversation', { id: 'ws_rendering_xa', label: '7', root: '/7', state: 'closed', available: true, meta: { closedBy: 'Untitled 3' } }],
        ['stranded: closed by nobody named', { id: 'ws_rendering_xa', label: '7', root: '/7', state: 'closed', available: true, meta: {} }],
        ['stranded: not where it was', { id: 'ws_rendering_xa', label: '', root: '/7/9', state: 'ready', available: false }],
      ];
      for (const [where, row] of stranded) {
        const list = document.createElement('div');
        ensureWorkspaceBanner(boundArea(row, null), list);
        const lead = list.querySelector('.workspace-banner-lead');
        assert(!!lead?.textContent, `${where}: drew no lead`);
        see(where, shownStrings(list), row ? 2 : 3);
      }

      // The fold's result block, with no summary and with one (the summary is data).
      for (const result of ['', '7']) {
        const list = document.createElement('div');
        const footer = document.createElement('div');
        list.appendChild(footer);
        const area = {
          threadYMap: item({ boundedCompaction: true, result, itemId: 't1' }),
          snapshotLiveStatus: () => null,
        };
        ensureThreadResult(area, list, footer);
        assert(!!list.querySelector('.thread-result-label'), `fold (result ${JSON.stringify(result)}): drew nothing`);
        see(`fold (result ${JSON.stringify(result)})`, shownStrings(list, result ? '.thread-result-body' : undefined), 3);
      }

      // The error row's fallback when the item carries no text of its own.
      {
        const list = document.createElement('div');
        const footer = document.createElement('div');
        list.appendChild(footer);
        positionElements({}, list, footer, [item({ type: MESSAGE_TYPES.ERROR, itemId: 'e1' })], new Map());
        const row = list.querySelector('error-message');
        assert(!!row, 'the error item drew no row');
        see('error fallback', [row?.getAttribute('content') || ''], 1);
      }

      const raw = seen.filter(([, s]) => !isPseudoLocalized(s)).map(([where, s]) => `${where}: ${JSON.stringify(s)}`);
      assert(raw.length === 0, `plain English under en-XA:\n  ${raw.join('\n  ')}`);
    });
  });

  // Error and notice items keep their English and, from builds that send one,
  // the message it was rendered from in `data`. A row is drawn from the message
  // in the UI language; an item saved before there was one still shows the
  // English it was stored with. Every value is a digit, so only the template is
  // under test.
  await run('en-XA: error and notice rows draw a stored message translated, and old items in their English', async () => {
    await underPseudoLocale('conversation-area-rendering-test', async () => {
      /**
       * Draw one item and return its row.
       * @param {Record<string, any>} fields
       * @param {string} tag - The row element it must draw
       * @returns {Element} The row.
       */
      const draw = (fields, tag) => {
        const list = document.createElement('div');
        const footer = document.createElement('div');
        list.appendChild(footer);
        positionElements({}, list, footer, [item(fields)], new Map());
        const row = list.querySelector(tag);
        assert(!!row, `${tag}: the item drew no row`);
        return /** @type {Element} */ (row);
      };

      const errorText = 'Thread item 7 not found';
      const errorMessage = { key: 'Thread item {id} not found', params: { id: '7' } };
      const newError = draw({ type: MESSAGE_TYPES.ERROR, itemId: 'e2', content: errorText, summary: errorText, data: { message: errorMessage } }, 'error-message');
      const shown = newError.getAttribute('content') || '';
      assert(isPseudoLocalized(shown) && shown.includes('7'), `error with a message drew ${JSON.stringify(shown)}, want it translated`);

      const oldError = draw({ type: MESSAGE_TYPES.ERROR, itemId: 'e3', content: errorText, summary: errorText }, 'error-message');
      assert(oldError.getAttribute('content') === errorText, `error without a message drew ${JSON.stringify(oldError.getAttribute('content'))}, want its stored English`);

      // A summary the worker pulled out of the provider's own JSON is the
      // provider's text, not the message's: it is shown as stored.
      const pulled = draw({
        type: MESSAGE_TYPES.ERROR, itemId: 'e4', content: 'Error processing response: {"message":"7"}', summary: '7',
        data: { message: { key: 'Error processing response: {detail}', params: { detail: '{"message":"7"}' } } },
      }, 'error-message');
      assert(pulled.getAttribute('content') === '7', `provider summary drew ${JSON.stringify(pulled.getAttribute('content'))}, want it as stored`);

      const noticeSummary = 'Folded 4 earlier items into a summary thread. Nothing was discarded.';
      const newNotice = draw({
        type: 'notice', itemId: 'n1', summary: noticeSummary, content: '8',
        data: { summaryMessage: { key: 'Folded {count} earlier items into a summary thread. Nothing was discarded.', params: { count: 4 } } },
      }, 'notice-message');
      const noticeShown = newNotice.getAttribute('notice-text') || '';
      assert(isPseudoLocalized(noticeShown) && noticeShown.includes('4'), `notice with a message drew ${JSON.stringify(noticeShown)}, want it translated`);

      const oldNotice = draw({ type: 'notice', itemId: 'n2', summary: noticeSummary, content: '8' }, 'notice-message');
      assert(oldNotice.getAttribute('notice-text') === noticeSummary, `notice without a message drew ${JSON.stringify(oldNotice.getAttribute('notice-text'))}, want its stored English`);
    });
  });

  // A truncation notice that offers a one-off retry hands its figure to the row,
  // which draws the button only while the notice is the thread's last word.
  await run('a truncation notice carries its retry figure to the row', async () => {
    const list = document.createElement('div');
    const footer = document.createElement('div');
    list.appendChild(footer);
    positionElements({}, list, footer, [item({
      type: 'notice', itemId: 'n-retry', summary: 'The model hit its output limit before it finished, so this turn stops mid-reply.',
      data: { retryMaxOutput: 65536, discard: ['t1'] },
    })], new Map());
    const row = list.querySelector('notice-message');
    assert(!!row, 'the notice drew no row');
    assert(row?.getAttribute('notice-retry-max-output') === '65536',
      `retry figure on the row = ${JSON.stringify(row?.getAttribute('notice-retry-max-output'))}, want "65536"`);
  });

  return { passed, failed, errors };
}
