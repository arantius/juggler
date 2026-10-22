//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `isolateFocus()` keeps a case's focus lane-local.
 *
 * Every lane is a frame of one window with one focused frame, so a sibling's
 * focus() moves this document's activeElement to <body>, and a real focus()
 * may not take at all. The helper records what focus was asked for, answers
 * `document.activeElement` from that record, and can steal the window's real
 * focus the way a sibling would — so a case written against it is proven, on
 * every run, not to depend on the focus nobody here owns.
 * @module unit-tests/isolate-focus-test
 */

import { isolateFocus } from '../utilities/isolate-focus.js';

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

  /** @returns {{host: HTMLElement, input: HTMLInputElement, textarea: HTMLTextAreaElement, button: HTMLButtonElement}} A host in the document, with one of each focusable control the helper patches. */
  const make = () => {
    const host = document.createElement('div');
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const button = document.createElement('button');
    host.append(input, textarea, button);
    document.body.appendChild(host);
    return { host, input, textarea, button };
  };

  run('a focus() is recorded and answers activeElement, without taking the window\u2019s focus', () => {
    const { host, input } = make();
    const focus = isolateFocus();
    try {
      input.focus({ preventScroll: true });
      if (document.activeElement !== input) throw new Error(`activeElement is ${document.activeElement?.localName}, not the input`);
      if (!focus.asked(input)) throw new Error('the request was not recorded');
      if (focus.requests[0]?.options?.preventScroll !== true) throw new Error(`the options were lost: ${JSON.stringify(focus.requests[0]?.options)}`);
      if (focus.requests[0]?.via !== 'focus') throw new Error(`recorded as ${focus.requests[0]?.via}`);
    } finally {
      focus.restore();
      host.remove();
    }
  });

  run('select() focuses too, as it does in WebKit, and is recorded as a select', () => {
    const { host, input, textarea } = make();
    const focus = isolateFocus();
    try {
      textarea.select();
      if (document.activeElement !== textarea) throw new Error('a select did not move the lane-local focus');
      input.select();
      if (focus.requests.map((r) => r.via).join(',') !== 'select,select') throw new Error(`got ${JSON.stringify(focus.requests.map((r) => r.via))}`);
    } finally {
      focus.restore();
      host.remove();
    }
  });

  run('a case can start with focus somewhere, and blurring it leaves <body>', () => {
    const { host, input } = make();
    const focus = isolateFocus({ activeElement: input });
    try {
      if (document.activeElement !== input) throw new Error('the starting activeElement was not the input');
      input.blur();
      if (document.activeElement !== document.body) throw new Error(`after blur activeElement is ${document.activeElement?.localName}`);
      focus.set(input);
      if (document.activeElement !== input || focus.requests.length !== 0) throw new Error('set() must place focus without counting as a request');
    } finally {
      focus.restore();
      host.remove();
    }
  });

  run('steal() takes the real focus, as a sibling lane would, and the lane-local focus stays put', () => {
    const { host, input } = make();
    const focus = isolateFocus();
    try {
      input.focus();
      const decoy = focus.steal();
      if (!(decoy instanceof window.HTMLButtonElement) || !decoy.isConnected) throw new Error('no decoy button in the document');
      if (document.activeElement !== input) throw new Error('the steal moved the lane-local focus');
      if (focus.asked(decoy)) throw new Error('the steal was recorded as the case asking for focus');
    } finally {
      focus.restore();
      host.remove();
    }
  });

  run('restore() puts the real focus, select and activeElement back, and removes the decoy', () => {
    const realFocus = HTMLElement.prototype.focus;
    const realInputSelect = window.HTMLInputElement.prototype.select;
    const realTextareaSelect = window.HTMLTextAreaElement.prototype.select;
    const focus = isolateFocus();
    const decoy = focus.steal();
    focus.restore();
    if (HTMLElement.prototype.focus !== realFocus) throw new Error('focus was not restored');
    if (window.HTMLInputElement.prototype.select !== realInputSelect || window.HTMLTextAreaElement.prototype.select !== realTextareaSelect) {
      throw new Error('select was not restored');
    }
    if (Object.getOwnPropertyDescriptor(document, 'activeElement')) throw new Error('document.activeElement is still stubbed');
    if (decoy.isConnected) throw new Error('the decoy was left in the document');
    focus.restore();
  });

  return { passed, failed, errors };
}
