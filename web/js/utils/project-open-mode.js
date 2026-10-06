//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Whether choosing another project opens it in a new native window rather
 * than switching this one in place.
 *
 * Only a desktop window on a server the app spawned can: the app starts a
 * server for the new project on this machine. A window the app opened with
 * --url (`?external=1`) views a server it did not start, possibly on another
 * machine, whose paths are not this machine's — so, like a browser, it switches
 * in place.
 * @returns {boolean} True when another project opens in its own window.
 */
export function projectsOpenInNewWindow() {
  const { windowMode, externalServer } = document.documentElement.dataset;
  return windowMode === '1' && externalServer !== '1';
}
