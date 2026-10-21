//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the model and services raise dialogs through the typed UI port
 * (`services/ui-port.js`) and reach the app through declared dependencies,
 * never through the `window.*` globals.
 *
 * The globals stay — they are how extensions reach the dialogs — so each case
 * trips a wire on the global it must no longer read: a caller that still went
 * through `window` fails the case at once, instead of raising a real dialog
 * nobody answers.
 * @module unit-tests/ui-port
 */

import { assert } from '../utilities/test-helpers.js';
import Conversation from '../../js/model/conversation.js';
import slashCommandHandler from '../../js/services/slash-command-handler.js';
import { registerUiPort, uiPort } from '../../js/services/ui-port.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import { getAppSession, provideAppSession } from '../../js/utils/app-session.js';

/** The globals a model or service must not read. */
const GLOBALS = ['showModal', 'showAlert', 'showConfirm', 'showPrompt', 'showChoice', 'showNotice', 'openSettings', 'jugglerApp'];

/**
 * Replace every UI global with a tripwire for the length of `body`.
 * @param {() => Promise<void>} body
 * @returns {Promise<string[]>} The globals something read
 */
async function withTripwires(body) {
  const win = /** @type {any} */ (window);
  /** @type {string[]} */
  const tripped = [];
  /** @type {Map<string, PropertyDescriptor|undefined>} */
  const saved = new Map();
  for (const name of GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(win, name));
    Object.defineProperty(win, name, {
      configurable: true,
      get: () => { tripped.push(name); return undefined; },
    });
  }
  try {
    await body();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(win, name, descriptor);
      else delete win[name];
    }
  }
  return tripped;
}

/**
 * A port that records each call and answers as told.
 * @param {{confirm?: boolean|null}} [answers]
 * @returns {{port: import('../../js/services/ui-port.js').UiPort, calls: {kind: string, args: any[]}[]}} The port and its record
 */
function recordingPort(answers = {}) {
  /** @type {{kind: string, args: any[]}[]} */
  const calls = [];
  const record = (/** @type {string} */ kind, /** @type {any} */ answer) =>
    async (/** @type {any[]} */ ...args) => { calls.push({ kind, args }); return answer; };
  return {
    calls,
    port: {
      alert: record('alert', undefined),
      confirm: record('confirm', answers.confirm ?? false),
      prompt: record('prompt', null),
      choice: record('choice', null),
      notice: (/** @type {any[]} */ ...args) => { calls.push({ kind: 'notice', args }); },
    },
  };
}

/**
 * A conversation stand-in for the provider-settings offer.
 * @param {string[]} warnings - Where showWarning writes.
 * @returns {any} The stand-in
 */
function offeringConversation(warnings) {
  const conv = Object.create(Conversation.prototype);
  Object.defineProperty(conv, 'showWarning', { value: (/** @type {string} */ m) => { warnings.push(m); } });
  return conv;
}

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

  await run('the dialogs register themselves on the port as they load', async () => {
    await import('../../js/components/modal-dialog.js');
    const port = uiPort();
    assert(!!port, 'no port is registered once modal-dialog has loaded');
    for (const kind of ['alert', 'confirm', 'prompt', 'choice', 'notice']) {
      assert(typeof (/** @type {any} */ (port))[kind] === 'function', `the port has no ${kind}`);
    }
  });

  await run('a conversation offers provider settings through the port and the settings launcher', async () => {
    const { port, calls } = recordingPort({ confirm: true });
    /** @type {any[]} */
    const opened = [];
    const restorePort = registerUiPort(port);
    const restoreOpener = registerSettingsOpener((tab) => { opened.push(tab); });
    /** @type {string[]} */
    const warnings = [];
    try {
      const tripped = await withTripwires(() => offeringConversation(warnings)._offerProviderSettings('1', '2'));
      assert(tripped.length === 0, `read the window globals: ${tripped.join(', ')}`);
    } finally {
      restoreOpener();
      restorePort();
    }
    assert(calls.length === 1 && calls[0].kind === 'confirm' && calls[0].args[0] === '1' && calls[0].args[1] === '2',
      `expected one confirm('1', '2'), got ${JSON.stringify(calls)}`);
    assert(JSON.stringify(opened) === JSON.stringify(['providers']), `settings opened at ${JSON.stringify(opened)}`);
    assert(warnings.length === 0, 'warned as well as asking');
  });

  await run('with no port mounted, the offer falls back to the inline warning', async () => {
    const restorePort = registerUiPort(null);
    /** @type {string[]} */
    const warnings = [];
    try {
      const tripped = await withTripwires(() => offeringConversation(warnings)._offerProviderSettings('1', '2'));
      assert(tripped.length === 0, `read the window globals: ${tripped.join(', ')}`);
    } finally {
      restorePort();
    }
    assert(JSON.stringify(warnings) === JSON.stringify(['1']), `expected the warning '1', got ${JSON.stringify(warnings)}`);
  });

  await run('a command that would stop a running turn asks through the port', async () => {
    const { port, calls } = recordingPort({ confirm: false });
    const restorePort = registerUiPort(port);
    let settled = 0;
    const busy = { conversation: { isTurnActive: () => true, cancelAndSettle: async () => { settled++; } } };
    try {
      const tripped = await withTripwires(async () => { await slashCommandHandler.execute('/clear', /** @type {any} */ (busy)); });
      assert(tripped.length === 0, `read the window globals: ${tripped.join(', ')}`);
    } finally {
      restorePort();
    }
    assert(calls.length === 1 && calls[0].kind === 'confirm', `expected one confirm, got ${JSON.stringify(calls.map((c) => c.kind))}`);
    assert(settled === 0, 'stopped the turn the user chose to leave running');
  });

  await run('the app session is a provided dependency, not read off window.jugglerApp', async () => {
    const session = /** @type {any} */ ({ id: 'provided' });
    const restore = provideAppSession(() => session);
    try {
      /** @type {any} */
      let got = null;
      const tripped = await withTripwires(async () => { got = getAppSession(); });
      assert(tripped.length === 0, `read the window globals: ${tripped.join(', ')}`);
      assert(got === session, 'getAppSession did not answer with the provided session');
    } finally {
      restore();
    }
  });

  return { passed, failed, errors };
}
