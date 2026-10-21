//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Which processingState statuses mean "a turn is in flight".
 *
 * The worker decides this, not the viewer: `statusHoldsClaim`
 * (`cmd/juggler/worker/activity_state.go`) treats `idle` and the two
 * terminal-error statuses as resting, and a frame can stay at
 * `validation-error` indefinitely — a send refused for want of a model writes
 * it and returns without running anything. Every viewer reader that asks "is a
 * turn running here?" of the frame has to give the worker's answer, or a
 * conversation whose last send bounced reads as mid-turn: New Thread disabled,
 * undo and redo locked, the model picker noting a running turn, a turn-end
 * scheduled send never firing.
 *
 * Each case drives one real reader against a stand-in carrying only the state
 * it reads, over the same table of statuses, so the readers cannot drift apart
 * again without one of them failing here.
 * @module unit-tests/turn-active-status-test
 */

import { assert } from '../utilities/test-helpers.js';
import Conversation from '../../js/model/conversation.js';
import actionExecutor from '../../js/services/action-executor.js';
import Session from '../../js/model/session.js';
import { isConversationBusy } from '../../js/registries/reload-registries.js';
import { inspectTurn, observeUntil, waitForTurnOutcome } from '../../js/model/turn-completion.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';

/** Statuses the worker writes while a turn is in flight. */
const RUNNING = ['preparing', 'streaming', 'processing_tools', 'retrying', 'compacting', 'mock-paused'];

/** Statuses the worker rests at. */
const RESTING = ['idle', 'validation-error'];

/**
 * A Conversation carrying only what isTurnActive reads: the real prototype,
 * a processingState frame, and an action executor.
 *
 * The executor is the real one's shape — one page-wide registry of running
 * actions, each naming its conversation — because the question is which of
 * them this conversation may count.
 * @param {string|undefined} status - The frame's status, or undefined for no frame.
 * @param {string[]} [runningIn] - The conversations a frontend tool action is mid-flight in.
 * @returns {any} The stand-in conversation, id 'c1'.
 */
function makeConversation(status, runningIn = []) {
  const conv = Object.create(Conversation.prototype);
  Object.defineProperty(conv, 'processingState', {
    value: status === undefined ? undefined : { status },
  });
  Object.defineProperty(conv, 'id', { value: 'c1' });
  const executor = Object.create(Object.getPrototypeOf(actionExecutor));
  executor._runningActions = new Map(runningIn.map((id, i) => [`exec-${i}`, { conversationId: id, toolUseId: `t${i}` }]));
  conv._actionExecutor = executor;
  return conv;
}

/**
 * Run the turn-active status test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => void} body
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('conversation-is-turn-active', () => {
    for (const status of RUNNING) {
      assert(makeConversation(status).isTurnActive() === true,
        `a frame at '${status}' is a turn in flight`);
    }
    for (const status of RESTING) {
      assert(makeConversation(status).isTurnActive() === false,
        `a frame resting at '${status}' is not a turn in flight`);
    }
    assert(makeConversation(undefined).isTurnActive() === false, 'no frame is not a turn');
    assert(makeConversation('validation-error', ['c1']).isTurnActive() === true,
      'a frontend tool action still running is a turn in flight whatever the frame says');
    // The registry is the page's, and a page holds many conversations — the
    // engine every conversation's tools, a lane whatever an earlier suite left
    // running. Another conversation's action is not a turn here: counting it
    // refuses New Thread and asks to stop a turn that does not exist.
    assert(makeConversation('idle', ['c2']).isTurnActive() === false,
      'an action running in another conversation is not a turn in flight here');
  });

  check('session-tab-busy-barrier', () => {
    const isBusy = /** @type {any} */ (Session.prototype)._isConvBusy;
    /**
     * @param {string} status
     * @returns {any} A stand-in carrying a frame at that status.
     */
    const conv = (status) => ({
      id: 'c1',
      isProcessing: false,
      processingState: { status },
    });
    for (const status of RUNNING) {
      assert(isBusy.call({}, conv(status)) === true, `the tab barrier counts '${status}' as busy`);
    }
    for (const status of RESTING) {
      assert(isBusy.call({}, conv(status)) === false, `the tab barrier counts '${status}' as resting`);
    }
  });

  check('extension-reload-quiescence', () => {
    /**
     * @param {string} status
     * @returns {any} A stand-in carrying a frame at that status.
     */
    const conv = (status) => /** @type {any} */ ({ processingState: { status }, isAwaitingApproval: () => false });
    for (const status of RUNNING) {
      assert(isConversationBusy(conv(status)) === true, `a reload waits for '${status}'`);
    }
    for (const status of RESTING) {
      assert(isConversationBusy(conv(status)) === false, `a reload does not wait for '${status}'`);
    }
  });

  check('turn-completion-settle-mode', () => {
    for (const status of RUNNING) {
      assert(!inspectTurn({ processingState: { status } }, []).done, `'${status}' has not settled`);
    }
    for (const status of RESTING) {
      assert(inspectTurn({ processingState: { status } }, []).done, `'${status}' has settled`);
    }
    // A frame the worker has written with no status yet (a continuation marker
    // or a queued dispatch, ahead of the first status) is work about to start.
    assert(!inspectTurn({ processingState: { activity: 'awaiting_llm' } }, []).done,
      'a frame carrying no status yet has not settled');
  });

  // The wait's rejections are not UI text: `engine-one-shot.js` hands them to
  // the CLI as the run's `errorText`, which prints them inside its own English
  // (`cmd/juggler/app/one_shot.go`). The engine follows the UI locale, so they
  // must stay English under en-XA.
  try {
    /** @type {string[]} */
    const problems = [];
    await underPseudoLocale('turn-active-status-test', async () => {
      const conversation = {
        _doc: {
          metadata: { observe() {}, unobserve() {}, get() { return undefined; } },
          root: { observeDeep() {}, unobserveDeep() {} },
        },
        rootMessageThread: { items: [] },
        completedTurns: 0,
      };
      /**
       * @param {Promise<unknown>} wait
       * @param {string} expected
       */
      const expectRejection = async (wait, expected) => {
        try {
          await wait;
          problems.push(`expected a rejection reading ${JSON.stringify(expected)}`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message !== expected) problems.push(`got ${JSON.stringify(message)}, want ${JSON.stringify(expected)}`);
        }
      };
      const aborted = new AbortController();
      aborted.abort();
      await expectRejection(waitForTurnOutcome(conversation, { sinceTurn: 0, signal: aborted.signal }),
        'Aborted waiting for condition: turn complete');
      await expectRejection(waitForTurnOutcome(conversation, { sinceTurn: 0, timeoutMs: 1 }),
        'Timeout waiting for condition: turn complete');
      await expectRejection(observeUntil(conversation, () => false, { timeoutMs: 1 }),
        'Timeout waiting for condition');
    });
    assert(problems.length === 0, problems.join('; '));
    passed++;
  } catch (e) {
    failed++;
    errors.push(`turn-completion-errors-stay-english: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
