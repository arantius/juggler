//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the two typed event feeds' subscription contracts.
 *
 * - The session feed (`model/session-events.js`) takes a subscription to one
 *   type as well as to everything: a per-type listener hears only its type,
 *   and the feed keeps its one ordering and its live-set rules for both kinds.
 * - The socket's emitter (`services/websocket.js`) refuses a listener for a
 *   name it never emits, rather than taking a subscription nothing will ever
 *   call.
 * @module unit-tests/event-feeds
 */

import { assert } from '../utilities/test-helpers.js';
import SessionEvents from '../../js/model/session-events.js';
import { WebSocketService } from '../../js/services/websocket.js';

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

  const session = /** @type {any} */ ({ id: 'event-feeds' });

  run('a per-type subscription hears only its type', () => {
    const events = new SessionEvents(session);
    /** @type {any[]} */
    const heard = [];
    events.subscribe('conversation:renamed', (e) => { heard.push([e.type, e.data, e.session]); });
    events.notify('conversation:created', 1);
    events.notify('conversation:renamed', 2);
    assert(JSON.stringify(heard.map(([t, d]) => [t, d])) === JSON.stringify([['conversation:renamed', 2]]),
      `heard ${JSON.stringify(heard.map(([t, d]) => [t, d]))}`);
    assert(heard[0][2] === session, 'the event is not stamped with its session');
  });

  run('per-type and catch-all listeners are called in one subscription order', () => {
    const events = new SessionEvents(session);
    /** @type {string[]} */
    const order = [];
    events.subscribe(() => { order.push('all-1'); });
    events.subscribe('session:saved', () => { order.push('saved'); });
    events.subscribe(() => { order.push('all-2'); });
    events.notify('session:saved', null);
    assert(order.join(',') === 'all-1,saved,all-2', `called in the order ${order.join(',')}`);
  });

  run('a per-type unsubscribe releases only its own subscription', () => {
    const events = new SessionEvents(session);
    let a = 0;
    let b = 0;
    const cb = () => { a++; };
    const offFirst = events.subscribe('session:saved', cb);
    events.subscribe('session:saved', () => { b++; });
    offFirst();
    offFirst();
    events.notify('session:saved', null);
    assert(a === 0 && b === 1, `a=${a} b=${b}`);
  });

  run('a per-type listener subscribed during the fan-out hears the event, one removed first does not', () => {
    const events = new SessionEvents(session);
    let late = 0;
    let removed = 0;
    /** @type {() => void} */
    let offRemoved = () => {};
    events.subscribe(() => {
      events.subscribe('session:saved', () => { late++; });
      offRemoved();
    });
    offRemoved = events.subscribe('session:saved', () => { removed++; });
    events.notify('session:saved', null);
    assert(late === 1, `the late subscriber heard it ${late} time(s)`);
    assert(removed === 0, `the removed subscriber heard it ${removed} time(s)`);
  });

  run('the socket refuses a listener for a name it never emits', () => {
    const ws = new WebSocketService();
    let threw = null;
    try {
      ws.on(/** @type {any} */ ('no-such-event'), () => {});
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof TypeError, `on('no-such-event') did not throw a TypeError (got ${threw})`);
    const off = ws.on('providers-update', () => {});
    assert(typeof off === 'function', 'a known name did not subscribe');
    off();
  });

  return { passed, failed, errors };
}
