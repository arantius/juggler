//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Lane-local focus, for a case that asserts where focus went or runs code that
 * reads `document.activeElement` itself.
 *
 * Every lane is a frame of one window, and a window has one focused frame. So a
 * sibling lane's focus() moves this document's activeElement to <body> mid-case,
 * a real focus() here may not take at all (`proxy-settings` failed that way on a
 * quiet CI runner), WebKit's select() focuses too (`approval-buttons`), and a
 * steal changes what code that reads activeElement does rather than only what
 * an assertion sees (`strategy-menu-refresh`). `document.hasFocus()` is false in
 * every lane, so there is no guard to lean on either.
 *
 * The recipe those suites each wrote by hand, as one call: focus() and select()
 * are recorded rather than performed, `document.activeElement` answers with the
 * last element asked for, and {@link FocusIsolation.steal} takes the window's
 * real focus the way a sibling would. Assert that focus was ASKED for
 * (`asked`, `requests`) or on the roving tabIndex, and call `steal()` after the
 * triggering action: the old form of the assertion — reading the real focus —
 * then fails on every run, not just on an unlucky one.
 * @module js-tests/utilities/isolate-focus
 */

/**
 * One request for focus the code under test made.
 * @typedef {object} FocusRequest
 * @property {HTMLElement} element - What it asked to focus.
 * @property {'focus'|'select'} via - focus(), or a select() (which focuses in WebKit).
 * @property {FocusOptions|undefined} options - What focus() was passed.
 */

/**
 * @typedef {object} FocusIsolation
 * @property {FocusRequest[]} requests - Every request, in order.
 * @property {(element: Element) => boolean} asked - Whether focus was ever asked for on `element`.
 * @property {(element: Element|null) => void} set - Place the lane-local focus without counting it as a request, as a case's setup would.
 * @property {(opts?: {blurring?: boolean}) => HTMLButtonElement} steal - Take the window's real focus onto a decoy <button>, as a sibling lane's focus() would; with `blurring`, the lane-local element hears the blur a real steal would give it. Returns the decoy.
 * @property {() => void} restore - Put focus(), select() and activeElement back and remove the decoy. Idempotent.
 */

/**
 * Isolate this case's focus. Call `restore()` in a finally.
 * @param {{activeElement?: Element|null}} [opts] - Where focus starts (default <body>).
 * @returns {FocusIsolation} The record and its levers.
 */
export function isolateFocus({ activeElement = null } = {}) {
  const proto = window.HTMLElement.prototype;
  const inputProto = window.HTMLInputElement.prototype;
  const textareaProto = window.HTMLTextAreaElement.prototype;
  const realFocus = proto.focus;
  const realBlur = proto.blur;
  const realInputSelect = inputProto.select;
  const realTextareaSelect = textareaProto.select;

  /** @type {Element|null} */
  let focused = activeElement;
  /** @type {FocusRequest[]} */
  const requests = [];
  /** @type {HTMLButtonElement|null} */
  let decoy = null;
  let restored = false;

  proto.focus = function focus(options) {
    requests.push({ element: this, via: 'focus', options });
    focused = this;
  };
  proto.blur = function blur() {
    if (focused === this) focused = null;
  };
  const select = function select(/** @type {HTMLInputElement|HTMLTextAreaElement} */ this_) {
    requests.push({ element: this_, via: 'select', options: undefined });
    focused = this_;
  };
  inputProto.select = function () { select(this); };
  textareaProto.select = function () { select(this); };
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    // What a document with nothing focused answers.
    get: () => (focused && focused.isConnected ? focused : document.body),
  });

  return {
    requests,
    asked: (element) => requests.some((r) => r.element === element),
    set: (element) => { focused = element; },
    steal: ({ blurring = false } = {}) => {
      if (!decoy) {
        decoy = document.createElement('button');
        decoy.type = 'button';
        decoy.textContent = 'a sibling lane';
        document.body.appendChild(decoy);
      }
      // `blurring` also delivers what a steal does to an element that really
      // held focus — its blur — by really focusing the lane-local element first
      // and taking it from there. Off by default: an edit that cancels or
      // commits on blur is exactly what a case keeping focus lane-local is
      // protecting.
      if (blurring && focused instanceof window.HTMLElement && focused.isConnected) realFocus.call(focused);
      realFocus.call(decoy);
      return decoy;
    },
    restore: () => {
      if (restored) return;
      restored = true;
      proto.focus = realFocus;
      proto.blur = realBlur;
      inputProto.select = realInputSelect;
      textareaProto.select = realTextareaSelect;
      delete (/** @type {any} */ (document).activeElement);
      decoy?.remove();
    },
  };
}
