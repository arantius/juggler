//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The main app's live session, for code that is not handed one: the settings
 * tabs, the plugin catalog, the registry reloader.
 *
 * The app provides it as it boots (app.js, once the app is constructed), the way the
 * dialogs register on the UI port, so a reader depends on this module rather
 * than on a global the app happens to publish. A test stands in for the app's
 * session with {@link provideAppSession} and puts it back with the restorer.
 * @module utils/app-session
 */

/** @type {(() => import('../model/session.js').default|null)|null} */
let provider = null;

/**
 * Provide the app's session. Called once by the app; the returned function
 * puts the previous provider back.
 * @param {(() => import('../model/session.js').default|null)|null} next - Answers the live session (null before it has loaded)
 * @returns {() => void} Restores the provider registered before this call
 */
export function provideAppSession(next) {
  const previous = provider;
  provider = next;
  return () => { provider = previous; };
}

/**
 * The app's live session.
 *
 * Null before the session loads, and in any realm with no app at all — the
 * engine page and workers provide none.
 * @returns {import('../model/session.js').default|null} The session, or null.
 */
export function getAppSession() {
  return provider?.() ?? null;
}
