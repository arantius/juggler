//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The `decide` op — asking a decision model questions about some text.
 *
 * Pinned here: it posts the request the endpoint documents (the chosen decision
 * model when none is named, an explicit one when it is), hands back the reply as
 * sent, refuses a request that cannot be asked before anything leaves, and
 * surfaces each status a caller classifies on — above all 409, "no decision
 * model", which is the one a caller falls back from rather than reports.
 * @module unit-tests/decide-op-test
 */

import { assert } from '../utilities/test-helpers.js';
import { decide, OpsError } from '../../js/services/ops-api.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Failure messages.
 */

/**
 * Route window.fetch to a canned reply, recording what was sent.
 * @param {{status?: number, body?: any}} [reply] - The reply.
 * @returns {{restore: () => void, calls: Array<{url: string, method: string, body: any, signal: any}>}} The recorder.
 */
function installFetch({ status = 200, body = { answers: {}, usage: { inputTokens: 0, outputTokens: 0 } } } = {}) {
  const original = window.fetch;
  /** @type {Array<{url: string, method: string, body: any, signal: any}>} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, signal: init.signal });
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text };
  });
  return { restore: () => { window.fetch = original; }, calls };
}

const QUESTION = { id: 'safe', kind: 'yes-no', instructions: 'The command is safe' };

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

  await run('decide posts the documented request to /api/llm/decide', async () => {
    const answers = { safe: { kind: 'yes-no', probability: 0.97 } };
    const net = installFetch({ body: { answers, usage: { inputTokens: 12, outputTokens: 1 } } });
    try {
      const controller = new AbortController();
      const result = await decide({ state: 'ls -la', questions: [QUESTION], timeoutMs: 15000 }, controller.signal);
      assert(net.calls.length === 1, `one request, got ${net.calls.length}`);
      const call = net.calls[0];
      assert(call.url === '/api/llm/decide' && call.method === 'POST', `got ${call.method} ${call.url}`);
      assert(call.body.state === 'ls -la' && call.body.timeoutMs === 15000, `state and bound travel, got ${JSON.stringify(call.body)}`);
      assert(JSON.stringify(call.body.questions) === JSON.stringify([QUESTION]), 'the questions travel untouched');
      assert(call.body.model === 'decision', `with no model named the chosen decision model is asked for, got ${JSON.stringify(call.body.model)}`);
      assert(call.signal === controller.signal, 'the caller\'s abort signal reaches the request');
      assert(result.answers.safe.probability === 0.97 && result.usage.inputTokens === 12, 'the reply is returned as sent');
    } finally {
      net.restore();
    }
  });

  await run('decide passes an explicit model through', async () => {
    const net = installFetch();
    try {
      await decide({ state: 's', questions: [QUESTION], model: { provider: 'jev', model: 'jev-latest' } });
      assert(JSON.stringify(net.calls[0].body.model) === JSON.stringify({ provider: 'jev', model: 'jev-latest' }),
        `got ${JSON.stringify(net.calls[0].body.model)}`);
    } finally {
      net.restore();
    }
  });

  await run('decide surfaces 409 as an OpsError a caller can fall back from', async () => {
    const net = installFetch({ status: 409, body: { error: 'no decision model available' } });
    try {
      let caught = /** @type {any} */ (null);
      try {
        await decide({ state: 's', questions: [QUESTION] });
      } catch (e) {
        caught = e;
      }
      assert(caught instanceof OpsError, `expected an OpsError, got ${caught}`);
      assert(caught.status === 409, `the status is the contract, got ${caught.status}`);
    } finally {
      net.restore();
    }
  });

  await run('decide carries the other statuses a caller classifies on', async () => {
    for (const status of [400, 429, 502, 504]) {
      const net = installFetch({ status, body: { error: 'nope' } });
      try {
        await decide({ state: 's', questions: [QUESTION] }).then(
          () => { throw new Error(`${status} did not reject`); },
          (e) => { assert(e instanceof OpsError && e.status === status, `${status} must surface as an OpsError, got ${e}`); }
        );
      } finally {
        net.restore();
      }
    }
  });

  await run('decide refuses a request that cannot be asked, before sending anything', async () => {
    const net = installFetch();
    try {
      for (const bad of [undefined, {}, { state: '' , questions: [QUESTION] }, { state: 's' }, { state: 's', questions: [] }]) {
        let threw = false;
        try {
          await decide(/** @type {any} */ (bad));
        } catch (e) {
          threw = e instanceof TypeError;
        }
        assert(threw, `${JSON.stringify(bad)} must be a TypeError`);
      }
      assert(net.calls.length === 0, 'nothing may be sent for a malformed request');
    } finally {
      net.restore();
    }
  });

  return { passed, failed, errors };
}
