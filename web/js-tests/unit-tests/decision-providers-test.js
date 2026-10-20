//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Decision-only providers on the client — the cache and the chat picker.
 *
 * A decision model such as Jev answers questions with probabilities and cannot
 * hold a conversation. The server publishes it in the one provider list that
 * every picker reads, flagged `decisionOnly`, so the client has to do the
 * excluding. Pinned here:
 *
 *   - the providers cache hands a chat picker only the providers that chat, and
 *     a decision picker only the ones that decide;
 *   - a decision model alone does not count as "a provider is set up", because
 *     it cannot answer a message;
 *   - the composer's model selector never offers one, on first load or after a
 *     push from the server.
 *
 * The `decide` op that talks to a decision model is in decide-op-test.js.
 * @module unit-tests/decision-providers-test
 */

import { assert } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import providersCache from '../../js/services/providers-cache.js';
import '../../js/components/model-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Failure messages.
 */

/**
 * A provider that chats.
 * @param {string} name - Provider name.
 * @param {boolean} [available] - Whether it can serve.
 * @returns {any} A provider status.
 */
const chatProvider = (name, available = true) => ({
  name,
  displayName: name,
  available,
  modelsWithContext: [{ id: `${name}-model`, displayName: `${name} model`, contextWindow: 1000 }],
});

/**
 * A decision-only provider, as the server publishes Jev.
 * @param {boolean} [available] - Whether it can serve.
 * @returns {any} A provider status.
 */
const decisionProvider = (available = true) => ({
  name: 'jev',
  displayName: 'Jev',
  available,
  decisions: true,
  decisionOnly: true,
  modelsWithContext: [{ id: 'jev-latest', displayName: 'Jev latest', contextWindow: 64000 }],
});

/**
 * Publish a provider list the way the server does.
 * @param {any[]} list - The providers.
 */
function push(list) {
  /** @type {any} */ (wsService)._emit('providers-update', list);
}

const names = (/** @type {any[]} */ list) => list.map((p) => p.name);

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

  // The cache is module-global and shared with the rest of the lane, so each
  // test publishes its own list and the last one puts the original back.
  const original = [...providersCache.get()];

  await run('the cache hands each picker only the providers that suit it', () => {
    push([chatProvider('a'), decisionProvider(), chatProvider('b')]);
    assert(names(providersCache.get()).join() === 'a,jev,b', 'get() is the whole list, for the settings Providers tab');
    assert(names(providersCache.getChat()).join() === 'a,b', `a chat picker gets no decision model, got ${names(providersCache.getChat())}`);
    assert(names(providersCache.getDecision()).join() === 'jev', `a decision picker gets only decision models, got ${names(providersCache.getDecision())}`);
  });

  await run('a provider that is neither flagged is a chat provider', () => {
    // The flags are absent on nearly every provider the server publishes, and
    // absent has to mean "chats" or every existing provider would vanish.
    push([chatProvider('a')]);
    assert(providersCache.getChat().length === 1, 'an unflagged provider chats');
    assert(providersCache.getDecision().length === 0, 'and does not decide');
  });

  await run('a provider can decide and chat, and then appears in both', () => {
    push([{ ...chatProvider('both'), decisions: true }]);
    assert(providersCache.getChat().length === 1 && providersCache.getDecision().length === 1,
      'decisions without decisionOnly is a provider that does both');
  });

  await run('a decision model alone is not "a provider is set up"', () => {
    push([decisionProvider()]);
    assert(providersCache.hasAvailableProvider() === false,
      'it cannot answer a message, so a user with only Jev still needs a chat provider');
    push([decisionProvider(), chatProvider('a')]);
    assert(providersCache.hasAvailableProvider() === true, 'a chat provider alongside it counts');
    push([decisionProvider(), chatProvider('a', false)]);
    assert(providersCache.hasAvailableProvider() === false, 'an unavailable chat provider does not');
  });

  await run('the model selector never offers a decision model, on load or after a push', () => {
    const selector = /** @type {any} */ (document.createElement('model-selector'));
    selector.fetchProviders = async () => {};
    selector._refreshProvidersInBackground = () => {};
    selector.providers = [chatProvider('a'), decisionProvider()];
    document.body.appendChild(selector);
    try {
      assert(names(selector._offerableProviders()).join() === 'a',
        `the offered list drops the decision model, got ${names(selector._offerableProviders())}`);

      // A workspace that cannot host a local provider rewrites the list; the
      // decision model must stay out of it as well.
      selector.conversation = { workspaceHostsLocalProviders: false, isTurnActive: () => false };
      assert(names(selector._offerableProviders()).join() === 'a', 'still dropped when the list is rewritten for a workspace');

      // A push from the server replaces the list wholesale; the open picker must
      // be given the filtered one, not the raw push.
      const picker = { providers: [], refresh() {} };
      selector._picker = picker;
      push([chatProvider('a'), chatProvider('c'), decisionProvider()]);
      assert(names(picker.providers).join() === 'a,c',
        `a push must not hand the open picker the decision model, got ${names(picker.providers)}`);
    } finally {
      selector._picker = null;
      selector.remove();
    }
  });

  push(original);
  return { passed, failed, errors };
}
