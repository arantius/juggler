//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The dialogs the model and services layers raise, as a typed port rather than
 * the `window.*` globals.
 *
 * The dialogs themselves are a component and this is a service, so the
 * dependency runs one way, as it does for {@link ./settings-launcher.js}:
 * `modal-dialog.js` registers its presenters as it loads, and the model and the
 * services ask {@link uiPort} for them without importing the component. Opening
 * settings is the one UI command not here; it has its own port,
 * `settings-launcher.js`.
 *
 * {@link uiPort} answers null until a presenter is registered — the engine
 * realm, a headless page, a test that mounts no UI — and every caller decides
 * what that means for it (a refusal falls back to an inline warning; a
 * confirmation the user cannot be asked proceeds). A test stands in for the
 * whole port with {@link registerUiPort} and puts the real one back with the
 * restorer it returns.
 *
 * The `window.show*` globals stay, as the API extensions reach the dialogs by.
 * @module services/ui-port
 */

/**
 * @typedef {object} ConfirmOptions
 * @property {string} [confirmText] - Confirm button label
 * @property {string} [cancelText] - Cancel button label
 * @property {boolean} [danger] - Style the confirm button as destructive
 */

/**
 * @typedef {object} UiPort
 * @property {(message: string, title?: string) => Promise<unknown>} alert - An alert with an OK button; settles when dismissed
 * @property {(message: string, title?: string, options?: ConfirmOptions) => Promise<boolean|null>} confirm - True when confirmed; false or null (dismissed) otherwise
 * @property {(message: string, defaultValue?: string, title?: string) => Promise<string|null>} prompt - The entered text, or null when cancelled
 * @property {(message: string, choices: string[], title?: string, allowCustom?: boolean, options?: {noneText?: string}) => Promise<string|null>} choice - The chosen (or typed) answer, or null
 * @property {(message: string, options?: {duration?: number}) => void} notice - A transient notice; `duration` 0 stays until dismissed
 */

/** @type {UiPort|null} */
let port = null;

/**
 * Register the presenters that actually show the dialogs.
 *
 * Called once by `modal-dialog.js`; the returned function puts the previous
 * port back, which is how a test stands in for it for the length of one case.
 * @param {UiPort|null} next - The presenters, or null for none
 * @returns {() => void} Restores the port that was registered before this call
 */
export function registerUiPort(next) {
  const previous = port;
  port = next;
  return () => { port = previous; };
}

/**
 * The registered dialog presenters, or null when none is mounted.
 * @returns {UiPort|null} The port
 */
export function uiPort() {
  return port;
}
