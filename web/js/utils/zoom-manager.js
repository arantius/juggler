//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Zoom Manager - Handles UI zoom via root font-size scaling.
 *
 * The zoom is a machine preference, exactly as the theme is (see
 * theme-manager.js and services/prefs.js): every desktop window on the server's
 * own machine shares one, kept in settings.json, and any viewer on another
 * machine — a phone, or the desktop app's own window on a server elsewhere —
 * keeps one of its own and never writes back.
 *
 * It is applied before first paint (a font-size change reflows everything, so a
 * late correction is a visible jump), by index.html's pre-paint block from the
 * same sources this module reconciles: the machine's zoom (window.__machineZoom,
 * server-injected), a ?zoom= seed from the window that opened this one, the zoom
 * the project session stored before the machine had one (window.__projectZoom,
 * adopted once by the server's own window), and this device's cache. This
 * module is the authoritative reconciler and owns persistence.
 *
 * One limitation, in the transport rather than here: a Cloudflare quick tunnel
 * hands out a fresh hostname every session, so a viewer reaching a project that
 * way gets an empty localStorage each time and opens at the host's zoom again.
 */

import { onDocumentReady } from './document-ready.js';
import { postWindowControl } from '../../sdk/lib/window-control.js';
import {
  ownsServerPrefs, startingMachinePref, cachedMachinePref, setMachinePref, reconcilePref,
} from '../services/prefs.js';

/** The zoom's name in the machine realm. */
const ZOOM_PREF = 'juggler-zoom';
/** Announces that the machine realm's zoom changed (see prefs.reconcilePref). */
const ZOOM_PREF_EVENT = 'juggler-zoom-pref-changed';
const ZOOM_STEP = 10;
const ZOOM_MIN = 60;
const ZOOM_MAX = 160;
const ZOOM_DEFAULT = 110;

/** The live applied zoom level, resolved at init and updated on every change. */
let current = ZOOM_DEFAULT;

/**
 * Clamp a level to the supported range.
 * @param {number} level - Raw zoom percentage.
 * @returns {number} Clamped percentage.
 */
function clamp(level) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

/**
 * A usable level from a stored, injected or URL value; null when it is absent
 * or not a positive number.
 * @param {unknown} raw - Candidate value.
 * @returns {number|null} A valid clamped level, or null.
 */
function parseLevel(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? clamp(n) : null;
}

/**
 * This client's own stored zoom, as known right now: the machine's in the
 * server's own window, this device's copy in any other viewer.
 * @returns {number|null} The stored level, or null.
 */
function storedZoom() {
  return parseLevel(cachedMachinePref(ZOOM_PREF, null));
}

/**
 * The inherited seed from the window that opened this one (a ?zoom= param the
 * native host bakes into the URL).
 * @returns {number|null} The seed level, or null.
 */
function seedZoom() {
  try {
    return parseLevel(new URL(window.location.href).searchParams.get('zoom'));
  } catch (_e) {
    return null;
  }
}

/**
 * Apply a zoom level to the document root.
 * @param {number} level - Zoom percentage.
 * @private
 */
function applyZoom(level) {
  document.documentElement.style.fontSize = level + '%';
}

/**
 * Report the current zoom to the native host so the next window it opens
 * inherits this (last-active) size. A no-op in a plain browser tab.
 * @param {number} level - Zoom percentage.
 * @private
 */
function reportToHost(level) {
  postWindowControl('zoom', '?zoom=' + level);
}

/**
 * The live applied zoom level.
 * @returns {number} Current zoom percentage.
 */
export function getCurrentZoom() {
  return current;
}

/**
 * Set zoom level, apply, store it, and report to the native host so new windows
 * inherit it. In the server's own window the level becomes the machine's; in
 * any other viewer it stays on that device and the host is left alone.
 * @param {number} level - Zoom percentage (clamped to min/max).
 */
function setZoom(level) {
  current = clamp(level);
  applyZoom(current);
  void setMachinePref(ZOOM_PREF, current);
  reportToHost(current);
}

/**
 * Increase zoom by one step.
 */
export function zoomIn() {
  setZoom(current + ZOOM_STEP);
}

/**
 * Decrease zoom by one step.
 */
export function zoomOut() {
  setZoom(current - ZOOM_STEP);
}

/**
 * Adopt the machine realm's zoom when another window of this machine changed it
 * (or, at boot, when the realm knew something the cache did not).
 * @private
 */
function followStoredZoom() {
  const level = storedZoom();
  if (level === null || level === current) return;
  current = level;
  applyZoom(current);
}

/**
 * Initialize zoom on page load. Resolves the level the pre-paint block applied
 * (prefs.startingMachinePref), stores it when it was handed to this window
 * rather than chosen here — never the plain default — and reports it to the
 * host. The project session's zoom is offered only to the server's own window:
 * it is that machine's choice from before the machine realm held one.
 * @private
 */
function initZoom() {
  const owner = ownsServerPrefs();
  const start = startingMachinePref({
    owner,
    machine: parseLevel(window.__machineZoom),
    inherited: [seedZoom(), owner ? parseLevel(window.__projectZoom) : null],
    device: storedZoom(),
    fallback: ZOOM_DEFAULT,
  });
  current = start.value;
  applyZoom(current);
  // Report to the host so its inheritance seed tracks this window's size.
  reportToHost(current);
  if (start.adopt) void setMachinePref(ZOOM_PREF, current);

  window.addEventListener(ZOOM_PREF_EVENT, followStoredZoom);
  void reconcilePref('machine', ZOOM_PREF, ZOOM_PREF_EVENT);
}

// Auto-initialize when module loads. Zoom is a viewer affordance; onDocumentReady
// skips off the main thread (the engine worker has no document).
onDocumentReady(initZoom);
