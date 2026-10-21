//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What ConnectionManager does when the first session load fails.
 *
 * There is one recovery, whatever the failure says: wire the session into the
 * UI anyway, so the project picker is reachable, reject `whenReadyToRun()` with
 * the reason, and tell the user. No failure is special-cased into a page
 * reload. `GET /api/session` has no not-found answer, so a 404 during the load
 * comes from a request made after it — and a reload repeats that request, in a
 * loop the user cannot get out of. Reading "404" out of the message text was
 * worse still: a project path, a conversation name or a file name containing
 * those digits was enough.
 *
 * `window.location.reload` is unforgeable and cannot be stubbed, so these cases
 * assert the recovery happened rather than that a reload did not: the reload
 * branch returned before any of it.
 * @module unit-tests/session-load-failure-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import ConnectionManager from '../../js/services/connection-manager.js';
import SessionPersistence from '../../js/model/session-persistence.js';
import { HttpError } from '../../js/services/http.js';
import { registerUiPort, uiPort } from '../../js/services/ui-port.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run the real `_loadSession` against a session whose load throws `thrown`,
 * and report what the manager did about it.
 * @param {unknown} thrown - What `SessionPersistence.load()` throws
 * @returns {Promise<{alerts: string[], alertTitles: string[], readyError: unknown, loaded: boolean}>} The alerts raised (messages and titles), the readiness rejection, and whether the session was marked loaded
 */
async function failLoadWith(thrown) {
  const proto = /** @type {any} */ (SessionPersistence.prototype);
  const origLoad = proto.load;
  /** @type {string[]} */
  const alerts = [];
  /** @type {string[]} */
  const alertTitles = [];
  const cm = /** @type {any} */ (new ConnectionManager({
    llmState: /** @type {any} */ (null),
    onServerMessage: () => {},
    services: /** @type {any} */ ({})
  }));
  proto.load = async function () {
    throw thrown;
  };
  const restorePort = registerUiPort({
    ...(uiPort() || /** @type {any} */ ({})),
    alert: async (/** @type {string} */ message, /** @type {string|undefined} */ title) => {
      alerts.push(message);
      alertTitles.push(String(title));
    },
  });
  try {
    await cm._loadSession();
    if (cm._session) trackTestSession(cm._session);
    let readyError = null;
    try {
      await cm.whenReadyToRun();
    } catch (e) {
      readyError = e;
    }
    return { alerts, alertTitles, readyError, loaded: cm._sessionLoaded };
  } finally {
    proto.load = origLoad;
    restorePort();
    cm._unfollowGit?.();
  }
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
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

  /**
   * The recovery every failure must get.
   * @param {{alerts: string[], readyError: unknown, loaded: boolean}} outcome - What failLoadWith reported
   * @param {string} detail - Text of the failure that must reach the user and the waiters
   */
  const assertRecovered = (outcome, detail) => {
    assert(outcome.alerts.length === 1,
      `the failure must be surfaced once, with the picker behind it; got ${outcome.alerts.length} alert(s)`);
    assert(outcome.alerts[0]?.includes(detail),
      `the alert must carry the failure; got ${JSON.stringify(outcome.alerts[0])}`);
    assert(outcome.readyError instanceof Error && outcome.readyError.message.includes(detail),
      `whenReadyToRun() must reject with the load's reason; got ${String(outcome.readyError)}`);
    assert(outcome.loaded === false, 'a failed load must not mark the session loaded');
  };

  await run('a 404 from a request inside the load is a load failure, not a reload', async () => {
    const detail = 'conversation not found';
    assertRecovered(await failLoadWith(new HttpError(`HTTP 404: ${detail}`, 404, detail, { error: detail })), detail);
  });

  await run('"404" in an error message is a load failure, not a reload', async () => {
    const detail = 'open /Users/someone/sites/404-page/.juggler/config.json: permission denied';
    assertRecovered(await failLoadWith(new Error(detail)), detail);
  });

  await run('"Not Found" in an error message is a load failure, not a reload', async () => {
    const detail = 'extension module Not Found: my-plugin';
    assertRecovered(await failLoadWith(new Error(detail)), detail);
  });

  // The alert is the user's; the readiness rejection is the one-shot caller's
  // (the CLI prints it inside its own English), so it stays English.
  await run('en-XA: the load-failure alert is translated, the readiness error is not', async () => {
    const detail = '12345';
    /** @type {{alerts: string[], alertTitles: string[], readyError: unknown, loaded: boolean}|null} */
    let outcome = null;
    await underPseudoLocale('session-load-failure-test', async () => {
      outcome = await failLoadWith(new Error(detail));
    });
    const o = /** @type {{alerts: string[], alertTitles: string[], readyError: unknown, loaded: boolean}} */ (/** @type {unknown} */ (outcome));
    assert(o.alerts.length === 1, `expected one alert; got ${o.alerts.length}`);
    assert(o.alerts[0].includes(detail), `the alert must carry the failure; got ${JSON.stringify(o.alerts[0])}`);
    /** @type {string[]} */
    const shown = [...o.alerts[0].split('\n\n'), o.alertTitles[0]];
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    assert(o.readyError instanceof Error && o.readyError.message === `the engine could not load its session: ${detail}`,
      `whenReadyToRun() must reject in English; got ${String(o.readyError)}`);
  });

  return { passed, failed, errors };
}
