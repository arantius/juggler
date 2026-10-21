//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: an op leaves nothing behind on the caller's signal.
 *
 * A turn hands one AbortSignal to every op it runs, and that signal lives as
 * long as the turn. An op that chained itself onto the signal and never let go
 * would leave a listener (and the controller it closes over) on it per call, so
 * a long turn would accumulate one for every file it read. Each case counts the
 * signal's live listeners after the op has finished, however it finished.
 * @module unit-tests/ops-api-signal
 */

import { assert } from '../utilities/test-helpers.js';
import { readFile } from '../../js/services/ops-api.js';

/**
 * A live signal that counts the `abort` listeners currently attached to it.
 * @returns {{controller: AbortController, live: () => number}} The controller and its count.
 */
function countedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const attached = new Set();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = /** @type {any} */ ((/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) => {
    if (type === 'abort') attached.add(fn);
    add(type, fn, opts);
  });
  signal.removeEventListener = /** @type {any} */ ((/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) => {
    if (type === 'abort') attached.delete(fn);
    remove(type, fn, opts);
  });
  return { controller, live: () => attached.size };
}

/**
 * Run `call` against a stub fetch.
 * @param {(init: RequestInit) => Promise<Response>} answer - What the stub fetch does.
 * @param {() => Promise<any>} call - The op call.
 * @returns {Promise<{error: any}>} The rejection, if any.
 */
async function withFetch(answer, call) {
  const real = window.fetch;
  window.fetch = /** @type {any} */ ((/** @type {any} */ _input, /** @type {RequestInit} */ init) => answer(init));
  try {
    await call();
    return { error: null };
  } catch (error) {
    return { error };
  } finally {
    window.fetch = real;
  }
}

/** @returns {Response} A successful op response. */
const ok = () => new window.Response(JSON.stringify({ success: true, data: { content: '' } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });

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
   * @param {() => Promise<void>} fn - Test body.
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

  await run('ops that succeed leave no listener on the caller\'s signal', async () => {
    const { controller, live } = countedSignal();
    for (let i = 0; i < 5; i++) {
      const { error } = await withFetch(async () => ok(), () => readFile({ path: 'a' }, controller.signal));
      assert(!error, `op ${i} failed: ${error}`);
    }
    assert(live() === 0, `${live()} listeners left on a signal five finished ops had used`);
  });

  await run('an op that fails leaves no listener on the caller\'s signal', async () => {
    const { controller, live } = countedSignal();
    const { error } = await withFetch(async () => { throw new TypeError('network down'); },
      () => readFile({ path: 'a' }, controller.signal));
    assert(error, 'the op did not fail');
    assert(live() === 0, `${live()} listeners left after a failed op`);
  });

  await run('the caller\'s abort still cancels an op in flight', async () => {
    const { controller, live } = countedSignal();
    const { error } = await withFetch((init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      controller.abort();
    }), () => readFile({ path: 'a' }, controller.signal));
    assert(error?.name === 'AbortError', `expected the caller's AbortError, got ${error}`);
    assert(live() === 0, `${live()} listeners left after a cancelled op`);
  });

  return { passed, failed, errors };
}
