//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for `juggler/utils/path-containment` (web/sdk/lib/path-containment.js),
 * the static containment checks behind the shell and file-write approval gates.
 * A wrong answer here approves a write or a command outside the roots the user
 * granted, so each case names the way a path could slip past: a sibling that
 * shares a prefix, a `..` that climbs out, a `~` that expands elsewhere, a
 * Windows spelling that looks relative, an expansion nobody can resolve.
 * @module unit-tests/path-containment-test
 */

import {
  posixNormalize,
  windowsToComparable,
  resolveAgainstCwd,
  isPathInsideAllowedRoots,
  canonicalRoot,
  isGrantableRoot,
} from '../../sdk/lib/path-containment.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run the path-containment tests.
 * @param {object} _ctx - Test context (unused)
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

  // posixNormalize
  eq('empty is the current directory', posixNormalize(''), '.');
  eq('. and .. segments collapse', posixNormalize('/a/./b/../c'), '/a/c');
  eq('.. cannot climb above /', posixNormalize('/../../etc'), '/etc');
  eq('a relative .. past the start is kept', posixNormalize('a/../../b'), '../b');
  eq('trailing and doubled slashes go', posixNormalize('/a//b/'), '/a/b');
  eq('/ stays /', posixNormalize('/'), '/');

  // windowsToComparable
  eq('a native drive path folds', windowsToComparable('C:\\Users\\Me'), '/c/users/me');
  eq('a forward-slash drive path folds', windowsToComparable('C:/Users/Me'), '/c/users/me');
  eq('a cygwin path folds', windowsToComparable('/cygdrive/D/x'), '/d/x');
  eq('a bare drive folds', windowsToComparable('C:'), '/c');
  eq('folding is idempotent', windowsToComparable('/c/users/me'), '/c/users/me');

  // resolveAgainstCwd
  eq('a relative path resolves', resolveAgainstCwd('../x', '/p/q'), '/p/x');
  eq('an absolute path is kept', resolveAgainstCwd('/abs', '/p'), '/abs');
  eq('a ~ path is kept', resolveAgainstCwd('~/x', '/p'), '~/x');
  eq('an expansion is left for the check to refuse', resolveAgainstCwd('$HOME/x', '/p'), '$HOME/x');
  eq('a Windows drive path is rooted on Windows', resolveAgainstCwd('C:/x', '/p', 'windows'), 'C:/x');
  eq('with no cwd nothing moves', resolveAgainstCwd('../x', ''), '../x');

  // isPathInsideAllowedRoots
  const home = '/home/u';
  eq('a path inside a root', isPathInsideAllowedRoots('/p/a', ['/p']), true);
  eq('the root itself', isPathInsideAllowedRoots('/p', ['/p/']), true);
  eq('a sibling sharing the prefix is outside', isPathInsideAllowedRoots('/pp/a', ['/p']), false);
  eq('.. out of the root is outside', isPathInsideAllowedRoots('/p/../etc/passwd', ['/p']), false);
  eq('a ~ path inside an absolute root', isPathInsideAllowedRoots('~/proj/x', ['/home/u/proj'], home), true);
  eq('an absolute path inside a ~ root', isPathInsideAllowedRoots('/home/u/proj/x', ['~/proj'], home), true);
  eq('~/.. does not escape into a sibling', isPathInsideAllowedRoots('~/../v/x', ['/home'], home), false);
  eq('an expansion is never inside', isPathInsideAllowedRoots('$HOME/x', ['/'], home), false);
  eq('a backtick is never inside', isPathInsideAllowedRoots('/p/`id`', ['/p']), false);
  eq('no roots, nothing inside', isPathInsideAllowedRoots('/p/a', []), false);
  eq('a relative path that stays put', isPathInsideAllowedRoots('src/a.js', ['/p']), true);
  eq('a relative path that climbs out', isPathInsideAllowedRoots('../x', ['/p']), false);
  eq('Windows spellings of one folder match', isPathInsideAllowedRoots('C:/Proj/a', ['c:\\proj'], '', 'windows'), true);
  eq('a forward-slash drive path is not read as relative', isPathInsideAllowedRoots('C:/other/a', ['C:/proj'], '', 'windows'), false);

  // canonicalRoot
  eq('a ~ path grants its absolute folder', canonicalRoot('~/code/proj', home), '/home/u/code/proj');
  eq('an absolute path normalises', canonicalRoot('/srv/data/../app/', home), '/srv/app');
  eq('bare ~ is too broad', canonicalRoot('~', home), null);
  eq('home spelled out is too broad', canonicalRoot('/home/u', home), null);
  eq('a bare top-level is too broad', canonicalRoot('/usr', home), null);
  eq('/ is too broad', canonicalRoot('/', home), null);
  eq('~ with no known home cannot be granted', canonicalRoot('~/x', ''), null);
  eq('~/.. cannot be granted', canonicalRoot('~/../x', home), null);
  eq('an expansion cannot be granted', canonicalRoot('$HOME/x', home), null);
  eq('a relative path needs no grant', canonicalRoot('src', home), null);

  // isGrantableRoot
  eq('two segments deep is grantable', isGrantableRoot('/srv/app', home), true);
  eq('an ancestor of home is not', isGrantableRoot('/home', '/home/u/'), false);
  eq('a relative root is not', isGrantableRoot('srv/app', home), false);

  return { passed, failed, errors };
}
