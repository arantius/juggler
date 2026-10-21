//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: `busyState(conv)` names each of a conversation's busy answers.
 *
 * A conversation has four sources that say it is busy — the worker's frame, a
 * frontend tool action, LLMState's run, outstanding work in the document — and a
 * fifth that subtracts (parked on an approval). Callers combine different ones,
 * and a caller reading a raw predicate cannot tell from the call which it got.
 * Each case sets one source on a stand-in built on the real prototype and
 * checks that busyState reports exactly that one, and that the callers built on
 * it agree with what they combine.
 * @module unit-tests/busy-state
 */

import { assert } from '../utilities/test-helpers.js';
import Conversation from '../../js/model/conversation.js';
import { busyState } from '../../js/model/processing-status.js';
import { isConversationBusy } from '../../js/registries/reload-registries.js';

/**
 * A stand-in conversation with each busy source set as given.
 * @param {object} sources
 * @param {string} [sources.status] - processingState.status
 * @param {boolean} [sources.localActions] - a frontend action of it is running
 * @param {boolean} [sources.running] - LLMState reports a run
 * @param {boolean} [sources.outstandingItems] - the root thread has busy items
 * @param {boolean} [sources.awaitingApproval] - parked on an approval
 * @returns {any} The stand-in, id 'c1'
 */
function conversation({ status, localActions = false, running = false, outstandingItems = false, awaitingApproval = false }) {
  const conv = Object.create(Conversation.prototype);
  const pin = (/** @type {string} */ key, /** @type {any} */ value) =>
    Object.defineProperty(conv, key, { value, configurable: true });
  pin('id', 'c1');
  pin('processingState', status === undefined ? undefined : { status });
  pin('_actionExecutor', { hasRunningActionsFor: (/** @type {string} */ id) => localActions && id === 'c1' });
  pin('_llmState', { isConversationProcessing: (/** @type {string} */ id) => running && id === 'c1' });
  pin('rootMessageThread', { hasBusyItems: () => outstandingItems, items: [] });
  pin('isAwaitingApproval', () => awaitingApproval);
  return conv;
}

/** The fields busyState reports, in order. */
const FIELDS = /** @type {const} */ (['turn', 'localActions', 'turnActive', 'running', 'outstandingItems', 'awaitingApproval']);

/**
 * @param {any} state - A busyState answer.
 * @returns {string} Its fields, for a message
 */
const describe = (state) => FIELDS.map((f) => `${f}=${state[f]}`).join(' ');

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => void} fn - Test body.
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** @type {[string, any, Record<string, boolean>][]} */
  const cases = [
    ['nothing', {}, {}],
    ['a resting frame', { status: 'idle' }, {}],
    ['a refused send', { status: 'validation-error' }, {}],
    ['a streaming frame', { status: 'streaming' }, { turn: true, turnActive: true }],
    ['a frontend action', { localActions: true }, { localActions: true, turnActive: true }],
    ['an LLMState run', { running: true }, { running: true }],
    ['outstanding document work', { outstandingItems: true }, { outstandingItems: true }],
    ['a parked approval', { status: 'processing_tools', awaitingApproval: true }, { turn: true, turnActive: true, awaitingApproval: true }],
  ];

  for (const [label, sources, expected] of cases) {
    run(`${label}: busyState names exactly that`, () => {
      const conv = conversation(sources);
      const state = busyState(conv);
      for (const field of FIELDS) {
        assert(state[field] === (expected[field] === true), `${field} wrong — ${describe(state)}`);
      }
      assert(state.status === sources.status, `status ${state.status} !== ${sources.status}`);
      assert(state.turnActive === conv.isTurnActive(), 'turnActive disagrees with isTurnActive()');
      assert(state.running === conv.isProcessing, 'running disagrees with isProcessing');
    });
  }

  run('a registry reload waits for a turn, never for a parked approval', () => {
    assert(isConversationBusy(conversation({ status: 'streaming' })), 'a streaming turn is not busy');
    assert(!isConversationBusy(conversation({ status: 'processing_tools', awaitingApproval: true })), 'a parked approval is busy');
    assert(!isConversationBusy(conversation({ running: true })), 'an LLMState run without a frame is busy for a reload');
  });

  run('a partial conversation answers false rather than throwing', () => {
    const state = busyState(/** @type {any} */ ({ id: 'x' }));
    for (const field of FIELDS) assert(state[field] === false, `${field} — ${describe(state)}`);
  });

  return { passed, failed, errors };
}
