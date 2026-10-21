//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/sdk-boundary. Run by `make lint-js`; throws (exit 1) on the
 * first case that disagrees. Which files the rule applies to, and what each
 * boundary declares, is the config's business (tooling/eslint.config.js,
 * tooling/sdk-boundary.json, tooling/layer-boundary.json).
 */

import { log } from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { RuleTester } from 'eslint';
import rule from './sdk-boundary.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const ext = path.join(process.cwd(), 'web/extensions/demo/context-items/demo-context-item.js');
const sdk = path.join(process.cwd(), 'web/sdk/demo.js');
const extOptions = [{
  forbidden: ['web/js/', 'web/sdk/lib/'],
  allowed: { 'web/extensions/demo/context-items/demo-context-item.js': ['web/js/services/declared.js'] },
}];
const sdkOptions = [{ forbidden: ['web/js/'], allowed: {} }];
const service = path.join(process.cwd(), 'web/js/services/demo.js');
const layerOptions = [{ forbidden: ['web/js/components/'], allowed: {}, declaredIn: 'tooling/layer-boundary.json' }];

const undeclared = { messageId: 'undeclared' };
const stale = { messageId: 'stale' };
const declaredImport = "import d from '../../../js/services/declared.js';";

tester.run('sdk-boundary', rule, {
  valid: [
    // Specifiers and in-tree relative paths.
    { filename: ext, options: extOptions, code: `${declaredImport} import ContextItem from 'juggler/context-item';` },
    { filename: ext, options: extOptions, code: `${declaredImport} import { x } from '../lib/helper.js';` },
    { filename: ext, options: extOptions, code: `${declaredImport} import '../../juggler-core/lib/thing.js';` },
    // A declared crossing, dynamically too.
    { filename: ext, options: extOptions, code: "const d = await import('../../../js/services/declared.js');" },
    // A JSDoc type reference is a comment, not an import.
    { filename: ext, options: extOptions, code: `${declaredImport} /** @type {import('../../../js/model/session.js').default} */ let s;` },
    // A computed dynamic import cannot be judged and is not.
    { filename: ext, options: extOptions, code: `${declaredImport} const m = await import(url);` },
    // The SDK reaching its own lib.
    { filename: sdk, options: sdkOptions, code: "export { escapeHtml } from './lib/html.js';" },
  ],
  invalid: [
    { filename: ext, options: extOptions, code: `${declaredImport} import api from '../../../js/services/api.js';`, errors: [undeclared] },
    { filename: ext, options: extOptions, code: `${declaredImport} import '../../../js/services/side-effect.js';`, errors: [undeclared] },
    { filename: ext, options: extOptions, code: `${declaredImport} export { a } from '../../../js/utils/a.js';`, errors: [undeclared] },
    { filename: ext, options: extOptions, code: `${declaredImport} export * from '../../../sdk/lib/html.js';`, errors: [undeclared] },
    { filename: ext, options: extOptions, code: `${declaredImport} const m = await import('../../../js/services/skills.js');`, errors: [undeclared] },
    { filename: ext, options: extOptions, code: `${declaredImport} const m = await import(\`../../../sdk/lib/i18n.js\`);`, errors: [undeclared] },
    { filename: ext, options: extOptions, code: `${declaredImport} import { t } from '../../../sdk/lib/i18n.js';`, errors: [undeclared] },
    // The declared crossing, gone.
    { filename: ext, options: extOptions, code: "import ContextItem from 'juggler/context-item';", errors: [stale] },
    { filename: sdk, options: sdkOptions, code: "import x from '../js/services/ops-api.js';", errors: [undeclared] },
    { filename: sdk, options: sdkOptions, code: "const { a } = await import('../js/model/session.js');", errors: [undeclared] },
    // The layering boundary: a service reaching into the components, and a
    // stale declaration naming the file it is declared in.
    { filename: service, options: layerOptions, code: "import { showAlert } from '../components/modal-dialog.js';", errors: [undeclared] },
    {
      filename: service,
      options: [{ ...layerOptions[0], allowed: { 'web/js/services/demo.js': ['web/js/components/declared.js'] } }],
      code: "import x from './ui-port.js';",
      errors: [{ message: 'web/js/services/demo.js is declared in tooling/layer-boundary.json as importing web/js/components/declared.js, and no longer does: remove the entry.' }],
    },
  ],
});

log('✓ sdk-boundary: all cases agree');
