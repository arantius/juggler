//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/** @typedef {import('estree').Node & {parent?: ASTNode, [key: string]: unknown}} ASTNode */

/**
 * ESLint rule: every `${}` in a template literal that becomes markup is escaped
 * or is named as markup.
 *
 * The sinks are `x.innerHTML = …`, `x.outerHTML = …` (`=` or `+=`) and the
 * second argument of `x.insertAdjacentHTML(position, …)`. The value is followed
 * through `?:`, `&&`/`||`/`??` and `+` to every template literal it can be, and
 * each interpolation in those templates must be one of:
 * - `escapeHtml(…)` or `escapeAttr(…)` (bare or as a member, `ui.escapeHtml(…)`):
 *   the escapers, whose output is safe in content and in a quoted attribute;
 * - a name declaring the value is markup: an identifier, a member property, or
 *   the callee of a call, ending `HTML` / `Html` / `SVG` / `Svg` / `Markup`
 *   (`rowsHTML`, `this.iconSvg`, `LOCK_SVG`, `tabMarkup`, `renderBodyHTML()`,
 *   `getIconSvg(name)`) — the convention
 *   the codebase already uses, made checkable. A plain-text value never gets
 *   such a name, so the check is only as good as that rule, and that is the
 *   point of it: the name is where a reviewer looks;
 * - a literal, or a nested template literal whose own interpolations pass:
 *   the author wrote the markup, and nothing outside reaches it;
 * - an expression that can only be a number, a boolean, or a `typeof` word —
 *   arithmetic other than `+`, unary operators, comparisons, `x.length` — none
 *   of which can spell a tag or an entity;
 * - a conditional whose branches both pass, `a || b` / `a ?? b` with both
 *   sides passing, `a && b` with `b` passing (a falsy `a` stringifies to
 *   `false`, `0`, `NaN`, `null`, `undefined` or the empty string), and `a + b`
 *   with both sides passing.
 *
 * Anything else — a variable, `t(…)`, a call with an unmarked name — is
 * reported. Fix it by escaping a plain-text value, by renaming a value that is
 * genuinely built markup, or with a disable naming why it is safe.
 *
 * A template assembled in a variable (`html += \`…\`; el.innerHTML = html`) is
 * not followed: the rule sees only what is written at the sink.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Interpolations in markup templates must be escaped or named as markup' },
    schema: [],
    messages: {
      unescaped: 'This `${}` becomes markup ({{sink}}) but is neither escaped nor named as markup. '
        + 'Wrap plain text in escapeHtml() (escapeAttr() in an attribute); name a value that is built HTML '
        + '`…HTML` / `…Html` / `…SVG` / `…Svg` / `…Markup`; or disable this line saying why it is safe.',
    },
  },
  create(context) {
    const MARKUP_NAME = /(?:HTML|Html|SVG|Svg|Markup)$/;
    const ESCAPERS = new Set(['escapeHtml', 'escapeAttr']);
    const NUMERIC_BINARY = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>',
      '==', '!=', '===', '!==', '<', '<=', '>', '>=', 'in', 'instanceof']);

    /**
     * @param {ASTNode} node - A callee, identifier or member expression
     * @returns {string|null} The name it ends in, if it has one
     */
    function trailingName(node) {
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name;
      if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'PrivateIdentifier') return node.property.name;
      if (node.type === 'ChainExpression') return trailingName(node.expression);
      return null;
    }

    /**
     * Whether a single (non-compound) interpolated value is safe in markup.
     * @param {ASTNode} node - The expression
     * @returns {boolean} True when it is escaped, marked, literal or numeric
     */
    function safeLeaf(node) {
      switch (node.type) {
        case 'Literal':
          return true;
        case 'Identifier':
          return MARKUP_NAME.test(node.name);
        case 'MemberExpression': {
          const name = trailingName(node);
          return name !== null && (MARKUP_NAME.test(name) || name === 'length');
        }
        case 'ChainExpression':
          return safeLeaf(node.expression);
        case 'CallExpression': {
          const name = trailingName(node.callee);
          return name !== null && (ESCAPERS.has(name) || MARKUP_NAME.test(name));
        }
        case 'BinaryExpression':
          return NUMERIC_BINARY.has(node.operator);
        case 'UnaryExpression':
        case 'UpdateExpression':
          return true;
        default:
          return false;
      }
    }

    /**
     * Report each unsafe value an interpolated expression can produce.
     * @param {ASTNode} node - The expression inside `${}`, or a part of it
     * @param {string} sink - The sink, for the message
     */
    function checkInterpolation(node, sink) {
      switch (node.type) {
        case 'TemplateLiteral':
          for (const expr of node.expressions) checkInterpolation(expr, sink);
          return;
        case 'ConditionalExpression':
          checkInterpolation(node.consequent, sink);
          checkInterpolation(node.alternate, sink);
          return;
        case 'LogicalExpression':
          if (node.operator !== '&&') checkInterpolation(node.left, sink);
          checkInterpolation(node.right, sink);
          return;
        case 'BinaryExpression':
          if (node.operator === '+') {
            checkInterpolation(node.left, sink);
            checkInterpolation(node.right, sink);
            return;
          }
          break;
        default:
      }
      if (!safeLeaf(node)) context.report({ node, messageId: 'unescaped', data: { sink } });
    }

    /**
     * Check the interpolations of each template the sink value can be.
     * @param {ASTNode} node - The value written to the sink
     * @param {string} sink - The sink, for the message
     */
    function checkSinkValue(node, sink) {
      switch (node.type) {
        case 'TemplateLiteral':
          for (const expr of node.expressions) checkInterpolation(expr, sink);
          return;
        case 'ConditionalExpression':
          checkSinkValue(node.consequent, sink);
          checkSinkValue(node.alternate, sink);
          return;
        case 'LogicalExpression':
          checkSinkValue(node.left, sink);
          checkSinkValue(node.right, sink);
          return;
        case 'BinaryExpression':
          if (node.operator === '+') {
            checkSinkValue(node.left, sink);
            checkSinkValue(node.right, sink);
          }
          return;
        default:
      }
    }

    return {
      AssignmentExpression(node) {
        if (node.operator !== '=' && node.operator !== '+=') return;
        const name = node.left.type === 'MemberExpression' && !node.left.computed ? trailingName(node.left) : null;
        if (name === 'innerHTML' || name === 'outerHTML') checkSinkValue(node.right, name);
      },
      CallExpression(node) {
        if (trailingName(node.callee) !== 'insertAdjacentHTML' || node.callee.type === 'Identifier') return;
        if (node.arguments.length >= 2) checkSinkValue(node.arguments[1], 'insertAdjacentHTML');
      },
    };
  },
};
