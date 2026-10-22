//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { t } from '../../../sdk/lib/i18n.js';
import { isDevMode } from '../../services/context-menu-service.js';
import {
  chooseUILocale, fetchUILocales, pageUILocale, uiLocaleChoices, uiLocaleMenuValue,
} from '../../services/ui-locale.js';
import { buildSelectRow, fillSelect } from './appearance-tab.js';

/**
 * Language tab: the UI language.
 *
 * It is for someone who may not read the language the app is in, so nothing
 * about finding it or choosing in it depends on reading that language: its
 * button is first in the Settings strip and carries the language icon, and
 * every entry in its menu — English too — names a language in that language
 * (ui-locale.js). It offers the languages the server has catalogues for, and
 * the pseudo-locale in dev mode.
 *
 * Choosing a language saves it and reloads this window into it; other windows
 * follow once idle (createUILocaleReloader).
 */
export class LanguageTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {Promise<void>} - Settles once the menu holds the server's languages. */
    this.languagesSettled = Promise.resolve();
    /** @type {Promise<void>} - Settles once the last language choice is saved. */
    this.languageSaved = Promise.resolve();
    /** @type {() => void} - Reloads the window into a newly chosen language; a test replaces it. */
    this.reload = () => window.location.reload();
  }

  /**
   * Eager render into the tab's section (called from the shell's render()). The
   * menu opens offering English alone and gains the server's languages once
   * they are known (fetchUILocales).
   */
  render() {
    const container = this.host.querySelector('#language-form');
    if (!container) return;
    container.innerHTML = '';

    const current = pageUILocale();
    const { row, select } = buildSelectRow({
      id: 'language-select',
      name: t('Language'),
      description: t('The language Juggler is shown in. This window reloads to apply it; '
        + 'other windows switch once they are idle.'),
      options: uiLocaleChoices([], { current }),
      value: uiLocaleMenuValue(current),
    });
    row.id = 'language-row';
    select.addEventListener('change', () => {
      this.languageSaved = chooseUILocale(select.value, () => this.reload()).catch((err) => {
        console.error('[Language] could not save the UI language:', err);
        select.value = uiLocaleMenuValue(pageUILocale());
      });
    });
    container.appendChild(row);

    this.languagesSettled = fetchUILocales().then((available) => {
      const now = pageUILocale();
      fillSelect(select, uiLocaleChoices(available, { pseudo: isDevMode(), current: now }), uiLocaleMenuValue(now));
    });
  }

  /** Holds nothing outside its own DOM. */
  dispose() {}
}
