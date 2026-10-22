//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Hold the server's realm-wide events off one case.
 *
 * Every lane is a client of one server. A sibling lane saving a setting reaches
 * this window as `settings-changed`; this lane's socket blinking reaches it as a
 * second `open`, on which the prefs store re-reads the settings document. Neither
 * is the case's doing, and stubbing HTTP stops neither (`updates-settings`
 * learned the first, `settings-first-load` the second: a reconnect mid-case was
 * the second GET it counted). A case that counts requests or reads realm state
 * holds the events it would be fooled by, and they are delivered — in order, to
 * every subscriber — when it ends, so the window converges exactly as it would
 * have, only not inside the assertion.
 *
 * Holding is done at `wsService._emit`, the one dispatch every server message
 * and socket lifecycle event goes through, so it holds the real ones. A case
 * plays a sibling's part — or its own socket's — with `simulate()`: the event is
 * held like a real one, which proves on every run that the hold is what the case
 * rests on, and is never delivered, because nothing really happened. (A replayed
 * reconnect that never was would re-run every `open` subscriber in the realm.)
 * @module js-tests/utilities/hold-broadcasts
 */

import wsService from '../../js/services/websocket.js';

/**
 * @typedef {object} BroadcastHold
 * @property {{event: string, data: any, simulated: boolean}[]} held - What was held, in arrival order.
 * @property {(event: string, data?: any) => void} simulate - Emit `event` as the server would; held if it is one of the held names, and never delivered on release.
 * @property {() => string} describe - One clause for a failure message: what was held and how often.
 * @property {() => void} release - Restore the dispatch and deliver everything really held, in order. Idempotent.
 */

/**
 * Hold `events` until `release()`. Call it in a finally, after the case's
 * stubs are taken down, so a replayed event talks to the real server.
 * @param {string[]} events - Event names to hold, as `wsService.on` names them.
 * @returns {BroadcastHold} The hold.
 */
export function holdBroadcasts(events) {
  const ws = /** @type {any} */ (wsService);
  const own = Object.getOwnPropertyDescriptor(ws, '_emit');
  const dispatch = ws._emit;
  const names = new Set(events);
  /** @type {{event: string, data: any, simulated: boolean}[]} */
  const held = [];
  let simulating = false;
  let released = false;

  ws._emit = function holdingEmit(/** @type {string} */ event, /** @type {any} */ data) {
    if (names.has(event)) {
      held.push({ event, data, simulated: simulating });
      return;
    }
    return dispatch.call(this, event, data);
  };

  return {
    held,
    simulate: (event, data) => {
      simulating = true;
      try { ws._emit(event, data); } finally { simulating = false; }
    },
    describe: () => {
      if (!held.length) return `nothing held (${events.join(', ')})`;
      /** @type {Map<string, number>} */
      const counts = new Map();
      for (const { event, simulated } of held) {
        const key = simulated ? `${event} (simulated)` : event;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return `held ${[...counts].map(([event, n]) => `${event} ×${n}`).join(', ')}`;
    },
    release: () => {
      if (released) return;
      released = true;
      if (own) Object.defineProperty(ws, '_emit', own);
      else delete ws._emit;
      for (const { event, data, simulated } of held.splice(0)) if (!simulated) ws._emit(event, data);
    },
  };
}
