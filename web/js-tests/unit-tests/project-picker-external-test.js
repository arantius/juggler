//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: what the project picker's confirm button does in each kind of
 * client.
 *
 * A desktop window on a server the app spawned opens another project in a new
 * window, leaving this one alone. A desktop window opened with --url views a
 * server the app did not start, possibly on another machine, so the paths the
 * picker offers are paths there; a new window would spawn a local server for a
 * folder that is not here. That window switches in place, as a browser does.
 * @module unit-tests/project-picker-external-test
 */

import { assert } from '../utilities/test-helpers.js';
import { closePopupById } from '../../js/utils/popup-manager.js';
import apiService from '../../js/services/api.js';
import { openProjectPicker } from '../../js/components/project-picker.js';

/**
 * Present the picker for a loaded project and read its footer.
 *
 * The picker unregisters itself only once its dismissal has settled, and a
 * second open while it is still registered is the toggle that closes it — so
 * each read waits for the previous picker to be gone first.
 * @returns {Promise<{confirm: string, newWindowButton: boolean}>} What the footer offers
 */
async function presentAndRead() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void openProjectPicker('/remote/current', null);
  const panel = document.querySelector('.pp-panel-popup');
  assert(!!panel, 'the picker never presented');
  const open = /** @type {HTMLElement|null} */ (panel?.querySelector('.pp-btn-open') ?? null);
  const result = {
    confirm: open ? (open.textContent || '').trim() : '',
    newWindowButton: !!panel?.querySelector('.pp-btn-newwindow'),
  };
  closePopupById('project-picker');
  return result;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const root = document.documentElement;
  const hadWindowMode = root.dataset.windowMode;
  const hadExternal = root.dataset.externalServer;
  const realGetRecents = apiService.getRecents;
  apiService.getRecents = async () => ({ paths: [] });

  const chip = document.createElement('button');
  chip.id = 'project-path-chip';
  chip.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  document.body.appendChild(chip);

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (error) {
      failed++;
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    await run('desktop window on its own server opens in a new window', async () => {
      root.dataset.windowMode = '1';
      delete root.dataset.externalServer;
      const { confirm } = await presentAndRead();
      assert(confirm === 'Open', `confirm was "${confirm}", want "Open"`);
    });

    await run('desktop window on an external server switches in place', async () => {
      root.dataset.windowMode = '1';
      root.dataset.externalServer = '1';
      const { confirm, newWindowButton } = await presentAndRead();
      assert(confirm === 'Switch', `confirm was "${confirm}", want "Switch"`);
      assert(!newWindowButton, 'offered "Open in new window", which would spawn a local server for a remote path');
    });

    await run('a browser switches in place', async () => {
      delete root.dataset.windowMode;
      delete root.dataset.externalServer;
      const { confirm, newWindowButton } = await presentAndRead();
      assert(confirm === 'Switch', `confirm was "${confirm}", want "Switch"`);
      assert(!newWindowButton, 'a browser has no native host to open a window');
    });
  } finally {
    closePopupById('project-picker');
    apiService.getRecents = realGetRecents;
    chip.remove();
    if (hadWindowMode === undefined) delete root.dataset.windowMode;
    else root.dataset.windowMode = hadWindowMode;
    if (hadExternal === undefined) delete root.dataset.externalServer;
    else root.dataset.externalServer = hadExternal;
  }

  return { passed, failed, errors };
}
