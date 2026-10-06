//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The image lightbox zooms and pans.
 *
 *   1. It opens fitted, with zoom out disabled.
 *   2. The toolbar's + and level buttons zoom in and back to fit.
 *   3. A WebKit pinch (gesturestart/gesturechange with a cumulative scale) —
 *      the shape the desktop app's WKWebView delivers — zooms from where the
 *      gesture began.
 *   4. Ctrl-wheel (the Chromium/Firefox pinch) zooms, keeping the point under
 *      the cursor fixed; a plain wheel pans a zoomed image.
 *   5. The View menu's zoom events and the +/-/0 keys zoom the image, and do
 *      not reach the app's own font-size zoom while it is open.
 *   6. A click on the image toggles fit ⇄ zoomed; a click on the backdrop
 *      closes it.
 * @module unit-tests/image-lightbox-test
 */

/* global WheelEvent */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { openImageLightbox } from '../../js/utils/image-lightbox.js';

/**
 * A 400×300 PNG data URL.
 * @returns {string} The URL.
 */
function testImageURL() {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, 400, 300);
  return canvas.toDataURL('image/png');
}

/**
 * The scale the lightbox has applied to its image.
 * @param {HTMLImageElement} img - The lightbox image.
 * @returns {number} The scale (1 = fitted).
 */
function scaleOf(img) {
  const m = /scale\(([\d.]+)\)/.exec(img.style.transform);
  return m ? Number(m[1]) : NaN;
}

/**
 * Dispatch a WebKit-shaped gesture event.
 * @param {Element} target - Where to dispatch it.
 * @param {string} type - gesturestart / gesturechange / gestureend.
 * @param {number} scale - Cumulative gesture scale.
 * @param {number} x - Client x.
 * @param {number} y - Client y.
 */
function gesture(target, type, scale, x, y) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    scale: { value: scale },
    clientX: { value: x },
    clientY: { value: y },
  });
  target.dispatchEvent(e);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  const src = testImageURL();

  /**
   * Run one case against a freshly opened lightbox.
   * @param {string} name - Case name.
   * @param {(root: HTMLElement, img: HTMLImageElement) => void | Promise<void>} fn - The case.
   */
  async function test(name, fn) {
    const close = openImageLightbox(src, 'test image');
    try {
      const root = /** @type {HTMLElement} */ (document.querySelector('.image-lightbox'));
      const img = /** @type {HTMLImageElement} */ (root.querySelector('.image-lightbox-img'));
      await waitFor(() => img.complete && img.naturalWidth > 0, { description: 'lightbox image to load' });
      await fn(root, img);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      close();
    }
  }

  await test('opens fitted, zoom out disabled', (root, img) => {
    assert(scaleOf(img) === 1, `expected scale 1, got ${img.style.transform}`);
    const out = /** @type {HTMLButtonElement} */ (root.querySelector('.image-lightbox-zoom-out'));
    assert(out.disabled, 'zoom out should be disabled at fit');
    assert(!root.classList.contains('is-zoomed'), 'fitted lightbox is not is-zoomed');
  });

  await test('toolbar buttons zoom in and back to fit', (root, img) => {
    /** @type {HTMLElement} */ (root.querySelector('.image-lightbox-zoom-in')).click();
    assert(scaleOf(img) > 1, `zoom in should scale up, got ${img.style.transform}`);
    assert(root.classList.contains('is-zoomed'), 'zoomed lightbox is is-zoomed');
    assert(document.querySelector('.image-lightbox') === root, 'a toolbar click must not close it');
    /** @type {HTMLElement} */ (root.querySelector('.image-lightbox-level')).click();
    assert(scaleOf(img) === 1, `level button should return to fit, got ${img.style.transform}`);
  });

  await test('WebKit pinch gesture zooms', (root, img) => {
    const r = img.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    gesture(root, 'gesturestart', 1, x, y);
    gesture(root, 'gesturechange', 3, x, y);
    assert(Math.abs(scaleOf(img) - 3) < 1e-6, `pinch to 3 should scale 3, got ${img.style.transform}`);
    gesture(root, 'gesturechange', 2, x, y);
    assert(Math.abs(scaleOf(img) - 2) < 1e-6, 'the gesture scale is cumulative from gesturestart');
    gesture(root, 'gestureend', 2, x, y);
    gesture(root, 'gesturestart', 1, x, y);
    gesture(root, 'gesturechange', 2, x, y);
    assert(Math.abs(scaleOf(img) - 4) < 1e-6, 'a second pinch starts from the current zoom');
  });

  await test('ctrl-wheel zooms about the cursor; plain wheel pans', (root, img) => {
    const r0 = img.getBoundingClientRect();
    const x0 = r0.left + r0.width / 2;
    const y0 = r0.top + r0.height / 2;
    // Zoom well past the window so the pan clamp leaves the point free.
    for (let i = 0; i < 6; i++) {
      root.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -50, clientX: x0, clientY: y0, bubbles: true, cancelable: true }));
    }
    assert(scaleOf(img) > 8, `ctrl-wheel should zoom in, got ${img.style.transform}`);

    const before = img.getBoundingClientRect();
    const px = x0 + 10;
    const py = y0 + 10;
    const fx = (px - before.left) / before.width;
    const fy = (py - before.top) / before.height;
    root.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 20, clientX: px, clientY: py, bubbles: true, cancelable: true }));
    const after = img.getBoundingClientRect();
    assert(after.width < before.width, 'positive ctrl-wheel zooms out');
    const ax = after.left + fx * after.width;
    const ay = after.top + fy * after.height;
    assert(Math.abs(ax - px) < 1 && Math.abs(ay - py) < 1,
      `the point under the cursor should stay put: (${px},${py}) moved to (${ax.toFixed(1)},${ay.toFixed(1)})`);

    const s = scaleOf(img);
    const t0 = img.style.transform;
    root.dispatchEvent(new WheelEvent('wheel', { deltaX: 30, deltaY: 30, bubbles: true, cancelable: true }));
    assert(scaleOf(img) === s, 'a plain wheel does not zoom');
    assert(img.style.transform !== t0, 'a plain wheel pans a zoomed image');
  });

  await test('menu zoom events and keys zoom the image, not the app', (root, img) => {
    let appZoomed = 0;
    const appHandler = () => { appZoomed++; };
    window.addEventListener('juggler:zoom-in', appHandler);
    try {
      window.dispatchEvent(new CustomEvent('juggler:zoom-in'));
      assert(scaleOf(img) > 1, 'juggler:zoom-in zooms the image');
      assert(appZoomed === 0, 'juggler:zoom-in must not reach the app font zoom while open');
      const s = scaleOf(img);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true, cancelable: true }));
      assert(scaleOf(img) > s, '⌘= zooms the image in');
      const s2 = scaleOf(img);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true }));
      assert(scaleOf(img) < s2, '- zooms out a step');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true }));
      assert(scaleOf(img) === 1, '0 returns to fit');
    } finally {
      window.removeEventListener('juggler:zoom-in', appHandler);
    }
    // Closing releases the interception.
    /** @type {HTMLElement} */ (root.querySelector('.image-lightbox-close')).click();
    assert(!root.isConnected, 'close button closes the lightbox');
    let reached = 0;
    const after = () => { reached++; };
    window.addEventListener('juggler:zoom-in', after);
    window.dispatchEvent(new CustomEvent('juggler:zoom-in'));
    window.removeEventListener('juggler:zoom-in', after);
    assert(reached === 1, 'once closed, juggler:zoom-in reaches the app again');
  });

  await test('image click toggles zoom; backdrop click closes', (root, img) => {
    const r = img.getBoundingClientRect();
    const opts = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true };
    img.dispatchEvent(new MouseEvent('click', opts));
    assert(scaleOf(img) >= 2, `a click on the fitted image zooms in, got ${img.style.transform}`);
    assert(root.isConnected, 'a click on the image does not close it');
    img.dispatchEvent(new MouseEvent('click', opts));
    assert(scaleOf(img) === 1, 'a click on the zoomed image returns to fit');
    root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(!root.isConnected, 'a backdrop click closes the lightbox');
  });

  return { passed, failed, errors };
}
