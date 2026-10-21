//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/escape-html-interpolation. Run by `make lint-js`; throws
 * (exit 1) on the first case that disagrees. Which files the rule applies to is
 * the config's business (tooling/eslint.config.js); every case here is a file
 * it applies to.
 */

import { log } from 'node:console';
import { RuleTester } from 'eslint';
import rule from './escape-html-interpolation.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const unescaped = { messageId: 'unescaped' };

tester.run('escape-html-interpolation', rule, {
  valid: [
    // The escapers, bare and as members.
    'el.innerHTML = `<b>${escapeHtml(name)}</b>`;',
    'el.innerHTML = `<a title="${escapeAttr(label)}"></a>`;',
    'el.innerHTML = `<b>${ui.escapeHtml(name)}</b>`;',
    // Names that declare markup: identifiers, members, callees.
    'el.innerHTML = `<ul>${rowsHTML}</ul>`;',
    'el.innerHTML = `<i>${this.iconSvg}</i><p>${bodyHtml}</p>${LOCK_SVG}${ICONS.TICK_SVG}`;',
    'el.innerHTML = `${this.renderBodyHTML()}${getIconSvg(kind)}${obj?.partHTML}${emptyHintMarkup()}`;',
    // Literals and numbers.
    "el.innerHTML = `<b>${'fixed'}</b>${42}`;",
    'el.innerHTML = `${items.length} of ${total - done} (${-x}) ${a > b} ${typeof v} ${i++}`;',
    // Compounds whose every outcome passes.
    "el.innerHTML = `${open ? escapeHtml(a) : ''}`;",
    'el.innerHTML = `${open && `<b>${escapeHtml(a)}</b>`}`;',
    "el.innerHTML = `${partHTML || ''}${partHTML ?? escapeHtml(x)}`;",
    "el.innerHTML = `${'<b>' + escapeHtml(a) + '</b>'}`;",
    // The other sinks, and += .
    'el.outerHTML = `<b>${escapeHtml(a)}</b>`;',
    'el.innerHTML += `<b>${escapeHtml(a)}</b>`;',
    "el.insertAdjacentHTML('beforeend', `<b>${escapeHtml(a)}</b>`);",
    // A sink value that is a conditional or concatenation of templates.
    "el.innerHTML = open ? `<b>${escapeHtml(a)}</b>` : '';",
    // Not sinks: other properties, a template in a variable, textContent.
    'el.textContent = `${name}`;',
    'const html = `<b>${name}</b>`;',
    'el.title = `${name}`;',
    'el.innerHTML = html;',
    // A local insertAdjacentHTML function is not the DOM method.
    "insertAdjacentHTML('x', `${name}`);",
    'el[prop] = `${name}`;',
  ],
  invalid: [
    { code: 'el.innerHTML = `<b>${name}</b>`;', errors: [unescaped] },
    { code: 'el.innerHTML = `<b>${t(\'Hello\')}</b>`;', errors: [unescaped] },
    { code: 'el.innerHTML = `<b>${this.renderControls(view)}</b>`;', errors: [unescaped] },
    { code: 'el.innerHTML = `<b>${user.name}</b>`;', errors: [unescaped] },
    { code: 'el.outerHTML = `<b>${name}</b>`;', errors: [unescaped] },
    { code: 'el.innerHTML += `<b>${name}</b>`;', errors: [unescaped] },
    { code: "el.insertAdjacentHTML('beforeend', `<b>${name}</b>`);", errors: [unescaped] },
    // Each unsafe outcome is reported where it stands.
    { code: "el.innerHTML = `${open ? name : ''}`;", errors: [unescaped] },
    { code: 'el.innerHTML = `${open && `<b>${name}</b>`}`;', errors: [unescaped] },
    { code: "el.innerHTML = `${name || ''}`;", errors: [unescaped] },
    { code: "el.innerHTML = `${'<b>' + name}`;", errors: [unescaped] },
    { code: 'el.innerHTML = `${a}${b}`;', errors: [unescaped, unescaped] },
    { code: "el.innerHTML = open ? `<b>${name}</b>` : '';", errors: [unescaped] },
    { code: "el.innerHTML = '<p>' + `<b>${name}</b>`;", errors: [unescaped] },
    // A computed member or an unmarked call is not a name that says markup.
    { code: 'el.innerHTML = `${parts[\'bodyHTML\']}`;', errors: [unescaped] },
    { code: 'el.innerHTML = `${String(count)}`;', errors: [unescaped] },
    // The escaper's name on a non-escaper callee says nothing.
    { code: 'el.innerHTML = `${escapeText(name)}`;', errors: [unescaped] },
  ],
});

log('✓ escape-html-interpolation: all cases agree');
