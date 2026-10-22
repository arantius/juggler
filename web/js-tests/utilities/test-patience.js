//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Whether a wait that has run out of time was actually being served.
 *
 * Every bound in this suite used to be wall-clock: a test got 25 seconds, a
 * `waitFor` got five, and the machine's opinion did not enter into it. So a
 * saturated machine failed tests that were working perfectly — the worker tape
 * would show a turn still landing deltas at the instant it was killed — and the
 * failure block would take the load average, print "this run is not evidence of
 * anything", and fail the build regardless. A whole verdict table existed to
 * launder those runs afterwards, and the re-run was on the reader.
 *
 * A wait should measure the work it is waiting for, not the second hand. This
 * module is where that is decided: at the instant a wait would have thrown, it
 * asks the machine what it was doing, and a machine that was not serving this
 * lane buys the wait another slice instead of a red build. A busy machine makes
 * the suite SLOW, which is what a busy machine should make it.
 *
 * Three properties matter, and they are why this is a judgement at the point of
 * expiry rather than a bigger constant or a scaled clock:
 *
 *   - **A healthy run is bit-for-bit unchanged.** The probes run only when a
 *     wait is already out of time, so a passing test never takes a reading, and
 *     no nominal timeout moves. Stretching every wait up-front was measured on
 *     2026-09-05 and made things much worse (one clean suite in three, against
 *     five in six either side; see `waitFor`'s own comment and the entry in
 *     scratch/flaky-tests.md) — the suspicion being that the most-used wait in
 *     the suite reshuffles how three lanes interleave. Nothing here touches a
 *     wait that is not already failing.
 *   - **A quiet machine still fails fast.** A wedge does not consume a CPU, so
 *     the reading comes back quiet and the wait fails on its nominal, with the
 *     diagnostics it always had. That is the common case and it stays sharp.
 *   - **The extension is spoken aloud.** Every grant is recorded, and the run
 *     reports what it granted. A suite that took four minutes because the
 *     machine was loaded says so; it never passes off a slow run as a fast one.
 *
 * A timer grid is deliberately NOT a reason to be patient. A hidden page whose
 * DOM timers have been coarsened to a one-second quantum is a real fault with a
 * real fix (`unthrottleHiddenPageTimers`, `ensureHiddenPoolWebViewSized`), and
 * waiting longer would hide the one symptom that finds it.
 * @module js-tests/utilities/test-patience
 */

import { fetchMachineLoad, measureTimerGrid } from './machine-load.js';
import { testGeneration } from './test-deadline.js';

/**
 * Per-CPU load above which the machine is not serving this lane properly.
 *
 * The same figure the failure block calls busy, so one number means one thing
 * everywhere: at 0.9 runnable threads per core there is already someone else's
 * work in front of ours.
 */
const BUSY_PER_CPU = 0.9;

/**
 * A timer hop at or past this is not load: either the hidden-page grid, or the
 * main thread every lane in this window shares held by something else for that
 * long. Both are faults to report rather than wait out. Mirrors
 * `GRID_SUSPECT_MS` in `machine-load.js`, which is where the reading itself is
 * explained.
 */
const GRID_FAULT_MS = 250;

/**
 * A timer hop above this says the lane is being served late. Zero-delay timers
 * cost a fraction of a millisecond unthrottled and jitter to a few milliseconds
 * under ordinary load, so ten is comfortably clear of healthy jitter while
 * still catching the 20-90ms hops a saturated machine produces.
 */
const SERVED_LATE_MS = 10;

/**
 * How long a reading stays good.
 *
 * Load averages move over tens of seconds and a lane's waits expire in clumps,
 * so re-probing per wait would spend the lane's time measuring instead of
 * waiting. Two seconds is shorter than any bound that rides this and long
 * enough that a burst of expiries shares one answer.
 */
const READING_CACHE_MS = 2000;

/**
 * Ceiling on how much one expiry may buy, as a multiple of the wait's nominal.
 *
 * The extension is proportional to how overloaded the machine is — twice the
 * work in front of us, twice the patience — because that is the honest estimate
 * of what the wait would have cost on a quiet machine. The cap stops an absurd
 * reading (a load spike from a `make` of its own) turning a five-second wait
 * into a five-minute one in a single step; a machine that is still busy when
 * the extension runs out simply buys another.
 */
const MAX_STRETCH = 4;

/**
 * Total extension one test may be granted, across every wait in it, as a
 * multiple of the bound that was about to fail — and in absolute terms.
 *
 * The backstop for the one case the quiet-machine path does not cover: wedged
 * AND saturated, where every expiry honestly reports a busy machine and would go
 * on doing so forever. A test whose healthy cost is under a second does not need
 * two extra minutes to prove it is stuck.
 */
const MAX_TEST_STRETCH = 2;
const MAX_TEST_EXTENSION_MS = 30_000;

/**
 * Total extension this lane may hand out across the whole run.
 *
 * Patience exists to stop a busy machine failing correct tests, not to make an
 * unusable machine look usable. Without a run-level bound a hopeless machine
 * turns a four-minute red run into an hour-long one that nobody can read, which
 * is a worse outcome than the honest verdict: this machine was too slow for this
 * run to mean anything. Generous next to the seconds an ordinarily busy machine
 * needs, small next to the run it protects.
 */
const MAX_RUN_EXTENSION_MS = 90_000;

/**
 * @typedef {object} MachineReading
 * @property {boolean} busy Machine was not serving this lane.
 * @property {number} stretch Multiple of the nominal the conditions justify (>= 1).
 * @property {string} why One clause naming what was read, for the failure line.
 * @property {boolean} gridFault The lane's timers ran a hop late enough to be a grid or a held main thread — a fault, not load.
 */

/** @type {{at: number, reading: MachineReading}|null} */
let cached = null;

/** @type {{grants: number, totalMs: number, worst: string}} */
let ledger = { grants: 0, totalMs: 0, worst: '' };

/** Extension handed out across every test this lane has run. */
let runTotalMs = 0;

/**
 * Take both readings and turn them into a verdict, reusing a recent one.
 * @returns {Promise<MachineReading>} What the machine was doing.
 */
async function readMachine() {
  if (cached && Date.now() - cached.at < READING_CACHE_MS) return cached.reading;

  const [load, grid] = await Promise.all([
    fetchMachineLoad(),
    measureTimerGrid().catch(() => null)
  ]);

  const perCpu = load?.available ? load.perCpu : 0;
  const worstMs = grid?.worstMs ?? 0;
  const gridFault = worstMs >= GRID_FAULT_MS;

  // Two independent ways of being underserved, and the worse one decides: the
  // load average is the machine's own account of the queue in front of us, and
  // the timer hop is what this lane actually experienced. Either alone is
  // enough — a lane can be starved on a box whose average has not caught up,
  // and a box can be saturated by work that leaves our timers alone.
  const byLoad = perCpu > BUSY_PER_CPU ? perCpu / BUSY_PER_CPU : 0;
  const byTimers = !gridFault && worstMs > SERVED_LATE_MS ? worstMs / SERVED_LATE_MS : 0;
  const stretch = Math.min(MAX_STRETCH, Math.max(byLoad, byTimers));

  /** @type {string[]} */
  const clauses = [];
  clauses.push(perCpu ? `${perCpu.toFixed(2)}/CPU` : 'load unreadable');
  if (grid) clauses.push(`worst timer hop ${worstMs}ms`);
  if (gridFault) clauses.push('a hop that long is a TIMER GRID or a main thread busy with something else, not load');

  const reading = {
    busy: !gridFault && stretch >= 1,
    stretch: Math.max(1, stretch),
    why: clauses.join(', '),
    gridFault
  };
  cached = { at: Date.now(), reading };
  return reading;
}

/**
 * A wait has reached its bound. Should it be given more time?
 *
 * The caller is expected to loop: ask, and if an extension comes back, keep
 * waiting that much longer and ask again when THAT runs out. Each grant is
 * proportional to how badly the machine is behaving, so a lane behind eight
 * siblings' work gets a proportionate share of patience rather than a constant
 * someone guessed.
 * @param {number} nominalMs - The bound the wait has just reached.
 * @param {number} [forGeneration] - The test generation the wait belongs to, captured when it started; defaults to the current one for callers that cannot outlive their test.
 * @returns {Promise<{extendByMs: number, why: string}|null>} An extension, or null when the machine has no excuse and the wait should fail.
 */
export async function askForMoreTime(nominalMs, forGeneration = testGeneration()) {
  const ownTestStillRunning = () => testGeneration() === forGeneration;
  // A wait whose test has already finished is asking on behalf of nobody. It
  // must not be given time, and above all must not be given time out of the
  // budget of the test that replaced it.
  if (!ownTestStillRunning()) return null;

  const testCeilingMs = Math.min(MAX_TEST_EXTENSION_MS, Math.ceil(nominalMs * MAX_TEST_STRETCH));
  const room = Math.min(testCeilingMs - ledger.totalMs, MAX_RUN_EXTENSION_MS - runTotalMs);
  if (room <= 0) return null;

  const reading = await readMachine();
  if (!reading.busy) return null;
  // The reading is an await, so the test may have ended while it was in flight.
  if (!ownTestStillRunning()) return null;

  const wanted = Math.ceil(Math.max(nominalMs, 250) * reading.stretch);
  const extendByMs = Math.min(wanted, room);
  if (extendByMs <= 0) return null;

  ledger.grants++;
  ledger.totalMs += extendByMs;
  runTotalMs += extendByMs;
  ledger.worst = reading.why;
  return { extendByMs, why: reading.why };
}

/**
 * The clause a wait appends to its timeout message, saying what was read before
 * giving up. A wait that failed on a quiet machine has earned a plain "this is
 * the code"; one that failed having exhausted its extensions says that instead.
 * @returns {Promise<string>} A clause describing the machine, ready to append.
 */
export async function whyGivingUp() {
  const reading = await readMachine();
  if (reading.gridFault) return `the machine was ${reading.why} — find what is holding this lane's timers (the grid, or another lane's work on the shared main thread), not the test`;
  if (runTotalMs >= MAX_RUN_EXTENSION_MS) {
    return `this lane has spent its whole run's patience (${Math.round(runTotalMs / 1000)}s) on a machine that will not settle (${reading.why}) — the run is too slow to mean anything, not necessarily wrong`;
  }
  if (ledger.totalMs > 0) {
    return `the machine was ${reading.why} and this test has already been given ${Math.round(ledger.totalMs / 1000)}s of extra time — it is stuck, not slow`;
  }
  if (reading.busy) return `the machine was ${reading.why}`;
  return `the machine was quiet (${reading.why}), so this is the code`;
}

/**
 * Start a fresh ledger for a test, and drop any reading taken during the last
 * one. The runner calls this alongside arming the deadline.
 */
export function resetPatience() {
  ledger = { grants: 0, totalMs: 0, worst: '' };
  cached = null;
}

/**
 * Poll `probe` until it returns something truthy, staying patient for as long as
 * the machine — not the code — is the reason it has not.
 *
 * The shape every polling wait in the suite wants: probe, sleep, probe, and on
 * reaching the bound ask {@link askForMoreTime} rather than throwing. Callers
 * get `null` back when patience ran out and raise their own error, because the
 * message a wait fails with is the most useful line in its failure block and
 * belongs to the wait, not to this module.
 * A wait outlives its test whenever that test fails: the runner abandons the
 * body where it stands, and the promises inside it keep their own counsel. So
 * the generation is captured on the way in and checked on every round — the
 * instant this wait belongs to nobody it stops, rather than polling on for a
 * state that is never coming and charging its patience to the next test.
 *
 * While it runs it is listed for {@link waitsInFlightReport}, under `what`.
 * @template T
 * @param {() => T} probe - Checked immediately and after every interval; any truthy value ends the wait.
 * @param {{nominalMs: number, intervalMs?: number, what?: WaitDescription}} opts - The wait's own bound, how often to look, and what it waits for.
 * @returns {Promise<T|null>} The probe's truthy value, or null if the wait gave up or was abandoned.
 */
export async function pollPatiently(probe, { nominalMs, intervalMs = 10, what }) {
  const mine = testGeneration();
  const wait = openWait(what);
  let outcome = 'gave up';
  try {
    const started = Date.now();
    let allowanceMs = nominalMs;
    for (;;) {
      const got = probe();
      if (got) {
        outcome = 'satisfied';
        return got;
      }
      if (testGeneration() !== mine) {
        outcome = 'abandoned';
        return null;
      }
      if (Date.now() - started >= allowanceMs) {
        const more = await askForMoreTime(nominalMs, mine);
        if (!more) return null;
        allowanceMs += more.extendByMs;
        // Round again without sleeping: the probe has not been asked since the
        // reading was taken, and the reading itself took time.
        continue;
      }
      await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
  } catch (e) {
    outcome = 'threw';
    throw e;
  } finally {
    closeWait(wait, outcome);
  }
}

/**
 * {@link pollPatiently} for a wait that has a promise to race rather than a
 * condition to poll.
 *
 * The promise is re-raced after each extension, which is safe — awaiting one
 * twice is free — and means the work carries on across the extension rather than
 * being restarted by it.
 *
 * Listed for {@link waitsInFlightReport} like a polling wait, unless `track` is
 * false — which is for the runner's own race over a whole suite, a wait that is
 * running whenever anything in the suite is and so would name nothing.
 * @template T
 * @param {Promise<T>} promise - The work being waited on.
 * @param {number} nominalMs - The wait's own bound.
 * @param {{what?: WaitDescription, track?: boolean}} [opts] - What it waits for, and whether to list it.
 * @returns {Promise<{value: T}|null>} The settled value, or null if the wait gave up. A rejection propagates.
 */
export async function racePatiently(promise, nominalMs, { what, track = true } = {}) {
  const mine = testGeneration();
  const wait = track ? openWait(what) : null;
  let outcome = 'gave up';
  try {
    const wrapped = promise.then((value) => ({ value }), (error) => { throw error; });
    let remainingMs = nominalMs;
    for (;;) {
      /** @type {{value: T}|undefined} */
      const settled = await Promise.race([
        wrapped,
        new Promise((resolve) => { setTimeout(() => resolve(undefined), remainingMs); })
      ]);
      if (settled) {
        outcome = 'satisfied';
        return settled;
      }
      const more = await askForMoreTime(nominalMs, mine);
      if (!more) return null;
      remainingMs = more.extendByMs;
    }
  } catch (e) {
    outcome = 'threw';
    throw e;
  } finally {
    if (wait) closeWait(wait, outcome);
  }
}

/**
 * List a wait that neither polls nor races — one woken by observers, which
 * {@link pollPatiently} and {@link racePatiently} cannot carry — for
 * {@link waitsInFlightReport}, until the returned function is called.
 * @param {WaitDescription} what - What it waits for; a function is evaluated when a report asks.
 * @returns {(outcome: 'satisfied'|'gave up'|'threw'|'abandoned') => void} Call once, as the wait ends.
 */
export function trackWait(what) {
  const wait = openWait(what);
  let closed = false;
  return (outcome) => {
    if (closed) return;
    closed = true;
    closeWait(wait, outcome);
  };
}

/**
 * A wait in progress, as the suite timeout reports it.
 * @typedef {object} OpenWait
 * @property {WaitDescription|undefined} what What it waits for, if its caller said.
 * @property {number} startedAt When it began (Date.now()).
 * @property {number} generation The test it belongs to.
 * @property {Error} origin Taken as it began, for its call site; the stack is parsed only if a report needs it.
 */

/** @typedef {string | (() => string)} WaitDescription */

/**
 * The waits running now.
 *
 * A suite that outlives its budget used to be reported as having "stopped making
 * progress" and nothing more, so the sighting named no case and no wait, and the
 * next sighting could say no more than the last. Every wait registers here for
 * as long as it runs, so the timeout can say where the suite was parked. The
 * cost on a passing run is one `new Error()` per wait.
 * @type {Set<OpenWait>}
 */
const openWaits = new Set();

/** @type {{wait: OpenWait, endedAt: number, outcome: string}|null} */
let lastSettled = null;

/**
 * Register a wait that is starting. Waits left behind by an earlier test are
 * dropped here: they stop on their own next round, and are not this test's.
 * @param {WaitDescription|undefined} what - What it waits for.
 * @returns {OpenWait} The token to close it with.
 */
function openWait(what) {
  const generation = testGeneration();
  for (const w of openWaits) if (w.generation !== generation) openWaits.delete(w);
  const wait = { what, startedAt: Date.now(), generation, origin: new Error() };
  openWaits.add(wait);
  return wait;
}

/**
 * @param {OpenWait} wait - The wait that has ended.
 * @param {string} outcome - How: 'satisfied', 'gave up', or 'abandoned'.
 */
function closeWait(wait, outcome) {
  openWaits.delete(wait);
  if (wait.generation === testGeneration()) lastSettled = { wait, endedAt: Date.now(), outcome };
}

/** The frames that are this machinery's own, never a caller worth naming. */
const OWN_FRAME = /\/js-tests\/utilities\/(test-patience|test-helpers|turn-sync)\.js:/;

/**
 * Where a wait was called from: the first two frames outside the waits
 * themselves, which is the helper that waited and the case that called it —
 * or the case alone, when it waited directly.
 * @param {Error} origin - Taken when the wait began.
 * @returns {string} One `name@path:line` per frame, innermost first.
 */
function callSite(origin) {
  const frames = String(origin.stack ?? '').split('\n')
    .map((f) => f.trim())
    .filter((f) => /\.js:\d+/.test(f) && !OWN_FRAME.test(f))
    .slice(0, 2)
    .map((f) => f
      .replace(/^at\s+/, '')
      .replace(/[a-z]+:\/\/[^/]+\//, '')
      .replace(/:(\d+):\d+\)?$/, ':$1')
      .replace(/\s*\(/, '@'));
  return frames.length ? frames.join(' ← ') : 'an unknown call site';
}

/**
 * @param {WaitDescription|undefined} what - The wait's description.
 * @returns {string} It, evaluated now when it is a function.
 */
function describeWait(what) {
  if (typeof what !== 'function') return what ?? 'an undescribed condition';
  try { return what(); }
  catch (e) { return `(its description threw: ${e instanceof Error ? e.message : String(e)})`; }
}

/**
 * Where the current test is parked, for a timeout's failure block: each wait
 * still running, oldest first, with its call site, its age, and its description
 * evaluated now — so a description written as a function reports the state the
 * wait last saw. With none running, the suite is parked on an await no wait
 * guards, and the last wait to finish is what places it.
 * @returns {string[]} Report lines, indented for a failure block.
 */
export function waitsInFlightReport() {
  const now = Date.now();
  const generation = testGeneration();
  const secs = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)}s`;
  const running = [...openWaits].filter((w) => w.generation === generation)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (running.length) {
    const shown = running.slice(0, 5).map((w) =>
      `  STILL WAITING (${secs(now - w.startedAt)}): ${callSite(w.origin)} — for ${describeWait(w.what)}`);
    if (running.length > shown.length) shown.push(`  …and ${running.length - shown.length} more wait(s) still running`);
    return shown;
  }
  if (lastSettled && lastSettled.wait.generation === generation) {
    const { wait, endedAt, outcome } = lastSettled;
    return [`  NO WAIT IN FLIGHT: the suite is parked on an await no wait guards. The last wait to finish (${outcome}, ${secs(now - endedAt)} ago) was ${callSite(wait.origin)} — for ${describeWait(wait.what)}`];
  }
  return ['  NO WAIT IN FLIGHT, and none has run in this test: it is parked before its first wait'];
}

/**
 * What this test was granted, for the failure block and the run's own report.
 * @returns {{grants: number, totalMs: number, line: string}} The tally, with an empty line when nothing was granted.
 */
export function patienceGranted() {
  if (ledger.grants === 0) return { grants: 0, totalMs: 0, line: '' };
  return {
    grants: ledger.grants,
    totalMs: ledger.totalMs,
    line: `  PATIENCE: waited ${Math.round(ledger.totalMs / 1000)}s longer than nominal across ${ledger.grants} extension(s) — ${ledger.worst}`
  };
}
