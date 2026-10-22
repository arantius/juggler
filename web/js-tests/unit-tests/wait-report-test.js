//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A unit suite that times out says what it was waiting for.
 *
 * The suite timeout used to report "it stopped making progress" and nothing
 * else, so a suite lost to it named no case and no wait, and the next sighting
 * could say no more than the last. Every wait now registers itself while it
 * runs, and the timeout prints the ones still running: where each was called,
 * how long it had been waiting, and its description evaluated at that moment,
 * so a description written as a function reports the state the wait last saw.
 * This pins that report.
 * @module unit-tests/wait-report-test
 */

import { waitFor, withTimeout } from '../utilities/test-helpers.js';
import { waitsInFlightReport } from '../utilities/test-patience.js';
import { observeUntil } from '../utilities/turn-sync.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/** This file's name, as a call site in the report carries it. */
const HERE = 'wait-report-test.js:';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
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
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  await run('a running wait is named by its call site, and described as it stands when the report is taken', async () => {
    let release = false;
    let seen = 'the first read';
    const pending = waitFor(() => release, () => `the probe flag (last saw ${seen})`, 5000);
    seen = 'the second read';
    const lines = waitsInFlightReport();
    release = true;
    await pending;
    const line = lines.find((l) => l.includes('STILL WAITING'));
    if (!line) throw new Error(`no running wait was reported: ${JSON.stringify(lines)}`);
    if (!line.includes(HERE)) throw new Error(`the wait's call site is not this file: ${line}`);
    if (!line.includes('the probe flag (last saw the second read)')) throw new Error(`the description was not taken at report time: ${line}`);
  });

  // Also the check that the runner's own race over this suite is not listed:
  // it is running now, in this suite's generation, for as long as the suite is.
  await run('with nothing running, the report names the last wait to finish instead', async () => {
    const lines = waitsInFlightReport();
    const running = lines.filter((l) => l.includes('STILL WAITING'));
    if (running.length) throw new Error(`a finished wait, or the runner's own race, was reported as running: ${JSON.stringify(running)}`);
    const line = lines.find((l) => l.includes('NO WAIT IN FLIGHT'));
    if (!line) throw new Error(`an idle suite was not reported as such: ${JSON.stringify(lines)}`);
    if (!line.includes(HERE) || !line.includes('the probe flag')) throw new Error(`the last wait to finish was not named: ${line}`);
  });

  await run('a raced promise is reported as a running wait too', async () => {
    /** @type {(v: string) => void} */
    let settle = () => {};
    const promise = new Promise((resolve) => { settle = resolve; });
    const pending = withTimeout(promise, 5000, 'the handed-over promise');
    const lines = waitsInFlightReport();
    settle('done');
    await pending;
    const line = lines.find((l) => l.includes('STILL WAITING') && l.includes('the handed-over promise'));
    if (!line) throw new Error(`the race was not reported: ${JSON.stringify(lines)}`);
    if (!line.includes(HERE)) throw new Error(`the race's call site is not this file: ${line}`);
  });

  // The harnesses' waits on a conversation are woken by observers, not polled,
  // so they register through `trackWait`; and the state they report is the
  // conversation's, read when the report is taken.
  await run('a wait on the turn reports the frame, the threads and the tools it last saw', async () => {
    const conversation = fakeConversation();
    const pending = observeUntil(conversation, () => conversation.done, { timeoutMs: 5000, label: 'idle after the probe' });
    conversation.status = 'calling_llm';
    const lines = waitsInFlightReport();
    conversation.done = true;
    conversation.fire();
    await pending;
    const line = lines.find((l) => l.includes('STILL WAITING') && l.includes('idle after the probe'));
    if (!line) throw new Error(`the turn wait was not reported: ${JSON.stringify(lines)}`);
    if (!line.includes(HERE)) throw new Error(`the wait's call site is not this file: ${line}`);
    for (const part of ['status=calling_llm', 'completedTurns=3', 'thread_1 run=open driven=true', 'bash#tu_1 running']) {
      if (!line.includes(part)) throw new Error(`the report is missing "${part}": ${line}`);
    }
  });

  await run('and its own timeout carries the same account', async () => {
    const conversation = fakeConversation();
    let message = '';
    try {
      await observeUntil(conversation, () => false, { timeoutMs: 20, label: 'a turn that never ends' });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    if (!message.includes('a turn that never ends') || !message.includes('thread_1 run=open') || !message.includes('bash#tu_1 running')) {
      throw new Error(`the timeout did not say what it saw: ${message}`);
    }
  });

  return { passed, failed, errors };
}

/**
 * The little of a conversation a turn wait reads: a frame, a turn counter, and
 * a root holding one open sub-thread with a running tool in it.
 * @returns {any} The stand-in, with `fire()` to wake its observers.
 */
function fakeConversation() {
  /** @type {Set<() => void>} */
  const observers = new Set();
  const ymap = (/** @type {Record<string, any>} */ fields) => ({ get: (/** @type {string} */ k) => fields[k] });
  const tool = ymap({ type: 'tool-action', toolName: 'bash', toolUseId: 'tu_1', state: 'running', result: null });
  const starter = ymap({ type: 'user', runToolUseId: 'call_1' });
  const thread = ymap({ type: 'thread', itemId: 'thread_1', items: { toArray: () => [starter, tool] } });
  const conversation = {
    status: 'idle',
    done: false,
    completedTurns: 3,
    get processingState() { return { status: conversation.status }; },
    isThreadProcessing: (/** @type {string|null} */ id) => id === 'thread_1',
    rootMessageThread: { items: [thread] },
    _doc: {
      metadata: {
        get: () => ({ status: conversation.status }),
        observe: (/** @type {() => void} */ fn) => observers.add(fn),
        unobserve: (/** @type {() => void} */ fn) => observers.delete(fn),
      },
      root: {
        observeDeep: (/** @type {() => void} */ fn) => observers.add(fn),
        unobserveDeep: (/** @type {() => void} */ fn) => observers.delete(fn),
      },
    },
    fire: () => { for (const fn of [...observers]) fn(); },
  };
  return conversation;
}
