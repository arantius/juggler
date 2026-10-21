//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The journal a run_code program replays from.
 *
 * A program that waits for an approval waits alive, holding the call. But if
 * the engine running it dies while it waits, the program is lost with it, and
 * is run again from the top once the user answers — so everything it did
 * before the stop must not happen twice. Each time a call is held, the program
 * keeps a snapshot of its journal (`snapshot`) for that.
 * The journal records every call the program makes through its capabilities
 * (`fs`, `grep`, `glob`, `tools`, and the read behind `image(path)`), by step:
 * the order in which the program makes them, with what each gave back. On a
 * replay, each call is matched against the record at its step and answered
 * from it without calling through; past the end of the record, or at a step
 * with no answer recorded, calls go through and are recorded in turn.
 *
 * The replay stands in for the program's state having been kept and restored:
 * it is how a program picks up where it stopped, not a second run. So a
 * replayed call answers with what it answered then, however the world has
 * changed since — the program goes on from the state it was in. What it does
 * next meets the world as it is now: a held edit whose file has changed since
 * the program read it is refused by the edit tool's own staleness check, which
 * the read credit a replay restores is there to feed.
 *
 * Capabilities are the program's only way to see or touch anything, so a
 * program that makes the same calls sees the same answers. One whose call at
 * some step differs from the record — another capability, other arguments —
 * has diverged: it would act on answers it never saw, so the call is refused,
 * as is every call after it, and `onDiverge` is told, which ends the program.
 * Nothing else needs to be deterministic: `Date.now` or `Math.random` matter
 * only when they change a call, and then they diverge. Nor is the order in
 * which concurrent answers arrived kept: a replay answers each recorded call
 * as soon as it is made again, so a program whose next calls depend on which
 * of several answers came first may make them in another order, and
 * diverges. That costs only the resume, which is the rare case of an engine
 * lost mid-hold: nothing from the diverging step on runs.
 *
 * A refusal or a cancel is not an answer, so neither is recorded: a replay
 * makes that call again, and asks again.
 *
 * A snapshot is the journal as it stands, with every call made and not yet
 * answered recorded as `pending`: the held call the user is asked about, and
 * any read running beside it. A replay checks a pending step like any other,
 * then calls through, and what the call gives back replaces the entry. So
 * every step a snapshot covers is checked: a call that ran before the
 * snapshot cannot be made again at a step it did not take, by a replay whose
 * calls come in another order.
 *
 * Pure — capabilities in, wrapped capabilities out; the journal is the
 * caller's to keep.
 * @module context-items/code/program-journal
 */

import { extractErrorMessage } from 'juggler/ui';

/** A replayed call differed from the record at its step. */
export class ProgramDiverged extends Error {
  /** @param {string} message - Which step, and how it differed */
  constructor(message) {
    super(message);
    this.name = 'ProgramDiverged';
  }
}

/**
 * @typedef {object} JournalEntry
 * @property {string} key - The capability called: `fs.readFile`, `grep`, `tools.edit`
 * @property {string} args - Its arguments, as JSON
 * @property {boolean} ok - Whether it answered or threw
 * @property {boolean} [pending] - Made, and not answered when the snapshot was taken
 * @property {unknown} [value] - What it answered
 * @property {string} [error] - What it threw
 * @property {string} [errorName] - The thrown error's name
 * @property {Array<[string, string|null]>} [reads] - Read credit it earned, path → hash
 */

/** Errors that are not a call's answer, and so are never recorded. */
const UNRECORDED = new Set(['ToolRefused', 'AbortError']);

/** Longest stretch of a call's arguments quoted in a divergence. */
const MAX_QUOTED = 120;

/**
 * Arguments as the journal compares them.
 * @param {unknown[]} args - A call's arguments
 * @returns {string} Their JSON, or a marker for what JSON cannot hold
 */
function argsKey(args) {
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return '[unserialisable]';
  }
}

/**
 * One call, as a divergence names it.
 * @param {string} key - The capability
 * @param {string} args - Its arguments, as JSON
 * @returns {string} e.g. `tools.bash({"command":"ls"})`
 */
function describeCall(key, args) {
  const inner = args.startsWith('[') && args.endsWith(']') ? args.slice(1, -1) : args;
  return `${key}(${inner.length > MAX_QUOTED ? inner.slice(0, MAX_QUOTED) + '…' : inner})`;
}

/**
 * Wrap a program's capabilities so every call is recorded in, or answered
 * from, `journal`.
 * @param {Record<string, any>} capabilities - Functions (`grep`) and namespaces (`fs`, `tools`)
 * @param {object} opts
 * @param {Array<JournalEntry|undefined>} opts.journal - The record; mutated
 * @param {Map<string, string|null>} [opts.ledger] - Read credit the program's reads earn, path → hash; a replayed call restores what it earned
 * @param {(err: ProgramDiverged) => void} opts.onDiverge - Told when a call diverges
 * @returns {Record<string, any>} The wrapped capabilities, by the same names,
 *   and — not enumerable, so they are never handed to the program among them —
 *   `stepNow()`: the step of the call being made, read synchronously while its
 *   capability is called, or null; and `snapshot()`: the journal to replay
 *   from should the program be lost while one of its calls waits on the user
 */
export function journalCapabilities(capabilities, opts) {
  const { journal, ledger, onDiverge } = opts;
  let step = 0;
  /**
   * The divergence, once there is one: every call after it is refused with
   * it, whatever its step, since none of them can be trusted to be the call
   * the record holds.
   * @type {ProgramDiverged|null}
   */
  let diverged = null;
  /** @type {number|null} */
  let calling = null;
  /**
   * Calls gone through and not yet answered, by step.
   * @type {Map<number, {key: string, args: string}>}
   */
  const inFlight = new Map();

  /**
   * The journal to replay from if the program is lost now, while one of its
   * calls waits on the user: every answer recorded, and every call made and
   * not yet answered marked pending. A copy: the journal goes on being written.
   * @returns {Array<JournalEntry|undefined>} The snapshot
   */
  const snapshot = () => {
    const out = [...journal];
    for (const [at, call] of inFlight) out[at] = { key: call.key, args: call.args, ok: false, pending: true };
    return out;
  };

  /**
   * One capability, journalled.
   * @param {string} key - Its name, as recorded
   * @param {(...args: unknown[]) => unknown} call - Calls through
   * @returns {(...args: unknown[]) => Promise<unknown>} The journalled call
   */
  const journalled = (key, call) => async (...args) => {
    if (diverged) throw diverged;
    const at = step++;
    const json = argsKey(args);
    const prior = journal[at];
    if (prior) {
      if (prior.key !== key || prior.args !== json) {
        diverged = new ProgramDiverged(`Couldn't resume the program: at step ${at + 1} it called `
          + `${describeCall(key, json)}, but last time it called ${describeCall(prior.key, prior.args)}. `
          + 'Nothing from that step on ran.');
        onDiverge(diverged);
        throw diverged;
      }
      if (!prior.pending) {
        for (const [p, hash] of prior.reads ?? []) ledger?.set(p, hash);
        if (prior.ok) return prior.value;
        const err = new Error(prior.error);
        if (prior.errorName) err.name = prior.errorName;
        throw err;
      }
    }
    const before = ledger ? new Map(ledger) : null;
    /**
     * The read credit this call earned.
     * @returns {Array<[string, string|null]>|undefined} New or changed entries
     */
    const earned = () => {
      if (!ledger || !before) return undefined;
      const reads = /** @type {Array<[string, string|null]>} */ ([...ledger].filter(([p, h]) => before.get(p) !== h));
      return reads.length > 0 ? reads : undefined;
    };
    /** @type {unknown} */
    let value;
    inFlight.set(at, { key, args: json });
    try {
      /** @type {unknown} */
      let pending;
      // The step is readable while the capability is called, synchronously,
      // so the caller can tag what it starts with it (stepNow).
      calling = at;
      try {
        pending = call(...args);
      } finally {
        calling = null;
      }
      value = await pending;
    } catch (err) {
      inFlight.delete(at);
      const e = /** @type {Error} */ (err);
      if (!UNRECORDED.has(e?.name)) {
        journal[at] = { key, args: json, ok: false, error: extractErrorMessage(err), errorName: e?.name, reads: earned() };
      }
      throw err;
    }
    inFlight.delete(at);
    journal[at] = { key, args: json, ok: true, value, reads: earned() };
    return value;
  };

  /** @type {Record<string, any>} */
  const wrapped = {};
  for (const [name, cap] of Object.entries(capabilities)) {
    if (typeof cap === 'function') {
      wrapped[name] = journalled(name, cap);
    } else if (cap && typeof cap === 'object') {
      /** @type {Map<string, (...args: unknown[]) => Promise<unknown>>} */
      const methods = new Map();
      wrapped[name] = new Proxy({}, {
        get: (_target, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          let fn = methods.get(method);
          if (!fn) {
            fn = journalled(`${name}.${method}`, (...args) => cap[method](...args));
            methods.set(method, fn);
          }
          return fn;
        },
      });
    } else {
      wrapped[name] = cap;
    }
  }
  Object.defineProperty(wrapped, 'stepNow', { value: () => calling, enumerable: false });
  Object.defineProperty(wrapped, 'snapshot', { value: snapshot, enumerable: false });
  return wrapped;
}
