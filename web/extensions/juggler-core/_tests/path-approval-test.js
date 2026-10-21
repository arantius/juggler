//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests the path helpers path-approval.js shares with the write and shell
 * tools: the `~` display form a folder grant is shown and typed in, and the
 * canonical key two spellings of one file compare by.
 * @module unit-tests/path-approval
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { homeBase, tildeify, untildeify, absolutePathKey } from '../context-items/path-approval.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the path-approval helper tests.
 * @param {any} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - What the case shows
   * @param {unknown} got - The answer
   * @param {unknown} want - The right answer
   */
  const eq = (label, got, want) => {
    try {
      assert(got === want, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  };

  eq('homeBase drops one trailing slash', homeBase('/home/u/'), '/home/u');
  eq('homeBase keeps a bare home', homeBase('/home/u'), '/home/u');

  eq('home itself is ~', tildeify('/home/u', '/home/u/'), '~');
  eq('a path under home collapses', tildeify('/home/u/code', '/home/u'), '~/code');
  eq('a sibling sharing the prefix does not', tildeify('/home/user2/x', '/home/u'), '/home/user2/x');
  eq('no home, no collapse', tildeify('/home/u/code', ''), '/home/u/code');

  eq('~ expands to home', untildeify('~', '/home/u/'), '/home/u');
  eq('~/ expands to home', untildeify('~/', '/home/u'), '/home/u');
  eq('~/x expands under home', untildeify('~/code/x', '/home/u'), '/home/u/code/x');
  eq('an absolute path is unchanged', untildeify('/srv/x', '/home/u'), '/srv/x');
  eq('~user is not ours to expand', untildeify('~other/x', '/home/u'), '~other/x');
  eq('no home, no expansion', untildeify('~/x', ''), '~/x');
  eq('round trip', untildeify(tildeify('/home/u/a/b', '/home/u'), '/home/u'), '/home/u/a/b');

  const session = { projectPath: '/proj/' };
  eq('a relative path resolves against the project', absolutePathKey(session, './src/../src/a.js'), '/proj/src/a.js');
  eq('backslashes fold', absolutePathKey(session, 'src\\a.js'), '/proj/src/a.js');
  eq('.. cannot climb above /', absolutePathKey(session, '/../../etc'), '/etc');
  eq('a drive path keeps its drive', absolutePathKey(null, 'C:\\a\\..\\b\\'), 'C:/b');
  eq('a bare drive is its root', absolutePathKey(null, 'C:'), 'C:/');
  eq('.. cannot climb above a drive', absolutePathKey(null, 'C:/../x'), 'C:/x');
  eq('a UNC path keeps its //', absolutePathKey(null, '//server/share/../x'), '//server/x');
  eq('no root: a relative .. is kept', absolutePathKey(null, 'a/../../b'), '../b');
  eq('no root: . is empty', absolutePathKey(null, '.'), '');
  eq('no path, no key', absolutePathKey(session, ''), '');

  return { passed, failed, errors };
}
