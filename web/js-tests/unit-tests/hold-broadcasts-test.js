//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `holdBroadcasts()` keeps the server's realm-wide events out of one case.
 *
 * Every lane is a client of one server, so what a sibling lane does reaches
 * this window as a broadcast, and this lane's own socket blinking reaches it as
 * a reconnect — and both move realm state a case may be counting (a reconnect
 * re-reads the settings document). The helper holds the named events for the
 * length of a case and delivers them, in order, when it ends: the window
 * converges exactly as it would have, just not inside the assertion.
 * @module unit-tests/hold-broadcasts-test
 */

import wsService from '../../js/services/websocket.js';
import { holdBroadcasts } from '../utilities/hold-broadcasts.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

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
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * Events no real server sends, so nothing else in the realm hears them — or
   * is disturbed by a fake one. `wsService.on` accepts only names it has a
   * listener list for, so this suite gives its two names lists of their own
   * for as long as it runs.
   */
  const HELD = 'test-hold-broadcasts-held';
  const PASSED = 'test-hold-broadcasts-passed';
  const listeners = /** @type {any} */ (wsService)._listeners;
  listeners[HELD] = [];
  listeners[PASSED] = [];
  try {

    run('a held event reaches nobody until release, then everybody, in order', () => {
      /** @type {string[]} */
      const heard = [];
      const onHeld = (/** @type {any} */ d) => heard.push(`held:${d}`);
      const onPassed = (/** @type {any} */ d) => heard.push(`passed:${d}`);
      wsService.on(HELD, onHeld);
      wsService.on(PASSED, onPassed);
      const hold = holdBroadcasts([HELD]);
      try {
        wsService._emit(HELD, 1);
        wsService._emit(PASSED, 2);
        wsService._emit(HELD, 3);
        if (heard.join(',') !== 'passed:2') throw new Error(`during the hold: ${heard.join(',')}`);
        if (hold.held.map((h) => `${h.event}:${h.data}`).join(',') !== `${HELD}:1,${HELD}:3`) {
          throw new Error(`what was held: ${JSON.stringify(hold.held)}`);
        }
        if (!hold.describe().includes(`${HELD} ×2`)) throw new Error(`described as ${hold.describe()}`);
        hold.release();
        if (heard.join(',') !== 'passed:2,held:1,held:3') throw new Error(`after release: ${heard.join(',')}`);
        wsService._emit(HELD, 4);
        if (heard[heard.length - 1] !== 'held:4') throw new Error('after release the event is not held any more');
        hold.release();
        if (heard.length !== 4) throw new Error('a second release replayed again');
      } finally {
        hold.release();
        wsService.off(HELD, onHeld);
        wsService.off(PASSED, onPassed);
      }
    });

    run('a simulated event is held like a real one, and never delivered', () => {
      /** @type {any[]} */
      const heard = [];
      const onHeld = (/** @type {any} */ d) => heard.push(d);
      wsService.on(HELD, onHeld);
      const hold = holdBroadcasts([HELD]);
      try {
        hold.simulate(HELD, 'sibling');
        wsService._emit(HELD, 'real');
        if (heard.length) throw new Error(`heard during the hold: ${JSON.stringify(heard)}`);
        if (!hold.describe().includes(`${HELD} (simulated) ×1`) || !hold.describe().includes(`${HELD} ×1`)) {
          throw new Error(`described as ${hold.describe()}`);
        }
        hold.release();
        if (JSON.stringify(heard) !== '["real"]') throw new Error(`delivered on release: ${JSON.stringify(heard)}`);
      } finally {
        hold.release();
        wsService.off(HELD, onHeld);
      }
    });

    run('release puts the socket\u2019s own dispatch back', () => {
      const before = Object.getOwnPropertyDescriptor(wsService, '_emit');
      const hold = holdBroadcasts([HELD]);
      hold.release();
      const after = Object.getOwnPropertyDescriptor(wsService, '_emit');
      if (JSON.stringify(before) !== JSON.stringify(after) || before?.value !== after?.value) {
        throw new Error('the dispatch was not restored as it was');
      }
    });

    run('with nothing held, the description says so', () => {
      const hold = holdBroadcasts([HELD]);
      try {
        if (hold.describe() !== `nothing held (${HELD})`) throw new Error(`got ${hold.describe()}`);
      } finally {
        hold.release();
      }
    });
  } finally {
    delete listeners[HELD];
    delete listeners[PASSED];
  }

  return { passed, failed, errors };
}
