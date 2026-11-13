// JavaScript support: parses source with Acorn and converts the ESTree AST
// into the language-neutral outline described in js/outline.js.

import { Parser } from '../../vendor/acorn.mjs';
import { CodeParseError, newMetrics, walkStatements } from '../outline.js';

const BASE_OPTIONS = {
  ecmaVersion: 'latest',
  locations: true,
  allowHashBang: true,
  allowReturnOutsideFunction: true,
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
};

/** Comments that are tool directives rather than human explanations. */
const DIRECTIVE_COMMENT =
  /^\s*(?:[#@]__PURE__|eslint[- ]|eslint$|global\s|jshint|jslint|istanbul\s|c8\s|prettier-ignore|@ts-|@flow|tslint:|webpackChunkName|sourceMappingURL=|#\s*sourceMappingURL)/;

const BRIEF_LIMITS = [80, 44, 26, 18];

/**
 * Parse JavaScript source into an outline.
 * @param {string} source
 * @returns {import('../outline.js').Outline}
 */
export function parseJavaScript(source) {
  const { ast, comments } = parseWithFallback(source);
  return new OutlineBuilder(source, comments).build(ast);
}

function parseWithFallback(source) {
  const attempt = (sourceType) => {
    const comments = [];
    const ast = Parser.parse(source, { ...BASE_OPTIONS, sourceType, onComment: comments });
    return { ast, comments };
  };
  let moduleError;
  try {
    return attempt('module');
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    moduleError = err;
  }
  try {
    // Sloppy-mode scripts (e.g. `with`, legacy octal literals) only parse as scripts.
    return attempt('script');
  } catch (scriptError) {
    if (!(scriptError instanceof SyntaxError)) throw scriptError;
    const err = (scriptError.pos ?? 0) > (moduleError.pos ?? 0) ? scriptError : moduleError;
    throw toParseError(err, source);
  }
}

function toParseError(err, source) {
  const line = err.loc?.line ?? null;
  const column = err.loc?.column ?? null;
  const message = String(err.message).replace(/\s*\(\d+:\d+\)\s*$/, '');
  const ch = source[err.pos] ?? '';
  let hint = null;
  if (/@flow\b/.test(source.slice(0, 2000)) || /^\s*(import|export)\s+type\b/m.test(lineText(source, line))) {
    hint = 'This file uses Flow or TypeScript type annotations. Only plain JavaScript is supported in this version.';
  } else if (ch === '<') {
    hint = 'This looks like JSX. Only plain JavaScript is supported in this version.';
  } else if (ch === ':' || /^\s*(interface|type|enum|declare|namespace)\b/m.test(lineText(source, line))) {
    hint = 'This may be TypeScript syntax. Only plain JavaScript is supported in this version.';
  } else if (ch === '@') {
    hint = 'Decorators are not supported yet.';
  }
  return new CodeParseError(message, { line, column: column != null ? column + 1 : null, hint });
}

function lineText(source, line) {
  if (!line) return '';
  return source.split('\n')[line - 1] || '';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

export function clip(s, max) {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : s;
}

const isFunctionNode = (n) =>
  !!n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

function unwrap(n) {
  while (n && (n.type === 'ChainExpression' || n.type === 'ParenthesizedExpression')) n = n.expression;
  return n;
}

function isCallLike(n) {
  n = unwrap(n);
  if (!n) return false;
  if (n.type === 'AwaitExpression' || n.type === 'YieldExpression') return isCallLike(n.argument);
  return n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'ImportExpression';
}

function propertyKey(prop, brief) {
  if (!prop.key) return '';
  if (prop.computed) return `[${brief(prop.key, 2)}]`;
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'PrivateIdentifier') return '#' + prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return brief(prop.key, 2);
}

function cleanComment(c) {
  if (c.type === 'Line') return c.value.replace(/^ /, '').replace(/\s+$/, '');
  let lines = c.value.split('\n');
  // Strip the "*" gutter used by JSDoc-style blocks.
  const starred = lines.slice(1).every((l) => /^\s*\*/.test(l) || l.trim() === '');
  lines = lines.map((l, i) => {
    if (i === 0) return l.replace(/^[*!]+/, '');
    return starred ? l.replace(/^\s*\*(?!\/) ?/, '') : l;
  });
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length),
  );
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, '')).join('\n');
}

/**
 * Turn raw comment tokens into readable blocks: consecutive `//` lines are
 * merged, tool directives are dropped. Returns [{ text, line, endLine }].
 */
function groupComments(comments) {
  const blocks = [];
  for (const c of comments) {
    const text = cleanComment(c);
    if (!text.trim() || DIRECTIVE_COMMENT.test(text)) continue;
    const prev = blocks[blocks.length - 1];
    if (prev && prev.type === 'Line' && c.type === 'Line' && c.loc.start.line === prev.endLine + 1) {
      prev.text += '\n' + text;
      prev.endLine = c.loc.end.line;
    } else {
      blocks.push({ type: c.type, text, line: c.loc.start.line, endLine: c.loc.end.line });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Outline builder
// ---------------------------------------------------------------------------

class OutlineBuilder {
  constructor(source, comments) {
    this.source = source;
    this.comments = comments.slice().sort((a, b) => a.start - b.start);
    this.usedComments = new Set();
    this.units = [];
    this.classes = [];
    this.imports = [];
    this.exports = [];
    this.unitCount = 0;
  }

  build(ast) {
    const program = {
      id: 'u0',
      kind: 'program',
      name: 'Top-level code',
      params: [],
      async: false,
      generator: false,
      className: null,
      parentId: null,
      callText: null,
      comments: [],
      body: [],
      expressionBody: null,
      line: 1,
      endLine: ast.loc.end.line,
      metrics: newMetrics(),
    };

    // File header: comment blocks before the first statement that are not
    // directly attached to it (separated by a blank line).
    const firstStart = ast.body.length ? ast.body[0].start : ast.end;
    const firstLine = ast.body.length ? ast.body[0].loc.start.line : Infinity;
    const leadingRaw = this.comments.filter((c) => c.end <= firstStart);
    const leadingBlocks = groupComments(leadingRaw);
    let attachedFrom = leadingBlocks.length;
    if (leadingBlocks.length && leadingBlocks[leadingBlocks.length - 1].endLine >= firstLine - 1) {
      attachedFrom = leadingBlocks.length - 1;
    }
    const headerBlocks = leadingBlocks.slice(0, attachedFrom);
    const headerEndLine = headerBlocks.length ? headerBlocks[headerBlocks.length - 1].endLine : 0;
    for (const c of leadingRaw) if (c.loc.end.line <= headerEndLine) this.usedComments.add(c);
    this.headerComments = headerBlocks.map((b) => b.text);

    program.body = this.block(ast.body, { unit: program }, 0, ast.end);

    this.units.sort((a, b) => a.start - b.start);
    this.resolveLocalCalls(program);

    const lineCount = this.source.length ? this.source.split('\n').length : 0;
    return {
      language: 'javascript',
      lineCount,
      headerComments: this.headerComments,
      program,
      units: this.units,
      classes: this.classes.sort((a, b) => a.line - b.line),
      imports: this.imports,
      exports: [...new Set(this.exports)],
    };
  }

  // ----- comments ---------------------------------------------------------

  takeComments(start, end) {
    let lo = 0;
    let hi = this.comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.comments[mid].start < start) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < this.comments.length; i++) {
      const c = this.comments[i];
      if (c.start >= end) break;
      if (c.end <= end && !this.usedComments.has(c)) {
        this.usedComments.add(c);
        out.push(c);
      }
    }
    return out;
  }

  // ----- source snippets --------------------------------------------------

  src(node) {
    return this.source.slice(node.start, node.end);
  }

  hadParens(node) {
    let i = node.start - 1;
    while (i >= 0 && /\s/.test(this.source[i])) i--;
    let j = node.end;
    while (j < this.source.length && /\s/.test(this.source[j])) j++;
    return this.source[i] === '(' && this.source[j] === ')';
  }

  /**
   * A short, single-line rendering of an expression: the original source when
   * it is short enough, otherwise a structural summary with nested functions,
   * objects and arrays collapsed to `{…}` / `[…]`.
   */
  brief(node, depth = 0) {
    if (!node) return '';
    const limit = BRIEF_LIMITS[Math.min(depth, BRIEF_LIMITS.length - 1)];
    if (node.end - node.start <= limit * 3) {
      const raw = collapse(this.src(node));
      if (raw.length <= limit) return raw;
    }
    return clip(this.structural(node, depth), limit + 20);
  }

  structural(node, depth) {
    const b = (n, d = depth + 1) => this.brief(n, d);
    // Operands keep the grouping parentheses they had in the source.
    const op = (n, d = depth + 1) => {
      const text = this.brief(n, d);
      return n && this.hadParens(n) && /Expression$/.test(n.type) && !/^(Call|Member|New)/.test(n.type)
        ? `(${text})`
        : text;
    };
    switch (node.type) {
      case 'Identifier':
        return node.name;
      case 'PrivateIdentifier':
        return '#' + node.name;
      case 'ThisExpression':
        return 'this';
      case 'Super':
        return 'super';
      case 'Literal':
        if (typeof node.value === 'string') return clip(node.raw, 24);
        return node.raw ?? String(node.value);
      case 'TemplateLiteral': {
        const parts = node.quasis.map((q, i) =>
          collapse(q.value.raw) + (i < node.expressions.length ? '${' + b(node.expressions[i], depth + 2) + '}' : ''),
        );
        return clip('`' + parts.join('') + '`', 40);
      }
      case 'TaggedTemplateExpression':
        return `${b(node.tag)}\`…\``;
      case 'MemberExpression': {
        const obj = op(node.object, depth);
        const prop = node.computed ? `[${b(node.property)}]` : (node.optional ? '?.' : '.') + b(node.property);
        return obj + (node.computed && node.optional ? '?.' : '') + prop;
      }
      case 'ChainExpression':
      case 'ParenthesizedExpression':
        return this.structural(node.expression, depth);
      case 'CallExpression': {
        let callee = b(node.callee, depth);
        if (isFunctionNode(unwrap(node.callee))) callee = `(${callee})`;
        const args = node.arguments.map((a) => b(a)).join(', ');
        return `${callee}${node.optional ? '?.' : ''}(${args})`;
      }
      case 'NewExpression':
        return `new ${b(node.callee, depth)}(${node.arguments.map((a) => b(a)).join(', ')})`;
      case 'ImportExpression':
        return `import(${b(node.source)})`;
      case 'ArrowFunctionExpression': {
        const params = node.params.map((p) => this.paramText(p));
        const head =
          (node.async ? 'async ' : '') +
          (params.length === 1 && node.params[0].type === 'Identifier' ? params[0] : `(${params.join(', ')})`);
        if (node.body.type !== 'BlockStatement') {
          const body = this.brief(node.body, depth + 1);
          return body.length <= 28 ? `${head} => ${body}` : `${head} => …`;
        }
        return `${head} => {…}`;
      }
      case 'FunctionExpression':
        return `${node.async ? 'async ' : ''}function${node.generator ? '*' : ''}${
          node.id ? ' ' + node.id.name : ''
        }(${node.params.map((p) => this.paramText(p)).join(', ')}) {…}`;
      case 'ClassExpression':
        return `class${node.id ? ' ' + node.id.name : ''} {…}`;
      case 'ObjectExpression': {
        if (!node.properties.length) return '{}';
        const inner = node.properties
          .map((p) => {
            if (p.type === 'SpreadElement') return '...' + b(p.argument, depth + 2);
            const key = propertyKey(p, (n, d) => this.brief(n, d));
            if (p.shorthand) return key;
            if (p.method || isFunctionNode(p.value)) return `${key}()`;
            return `${key}: ${this.brief(p.value, depth + 2)}`;
          })
          .join(', ');
        const text = `{ ${inner} }`;
        return text.length <= 44 ? text : '{…}';
      }
      case 'ArrayExpression': {
        const text = `[${node.elements.map((e) => (e ? b(e, depth + 2) : '')).join(', ')}]`;
        return text.length <= 36 ? text : '[…]';
      }
      case 'SpreadElement':
      case 'RestElement':
        return '...' + b(node.argument);
      case 'UnaryExpression': {
        const arg = op(node.argument, depth);
        return /^[a-z]/.test(node.operator) ? `${node.operator} ${arg}` : `${node.operator}${arg}`;
      }
      case 'UpdateExpression':
        return node.prefix ? node.operator + b(node.argument) : b(node.argument) + node.operator;
      case 'BinaryExpression':
      case 'LogicalExpression':
        return `${op(node.left, depth)} ${node.operator} ${op(node.right, depth)}`;
      case 'ConditionalExpression':
        return `${op(node.test)} ? ${op(node.consequent)} : ${op(node.alternate)}`;
      case 'AssignmentExpression':
        return `${b(node.left, depth)} ${node.operator} ${b(node.right, depth)}`;
      case 'SequenceExpression':
        return node.expressions.map((e) => b(e)).join(', ');
      case 'AwaitExpression':
        return `await ${op(node.argument, depth)}`;
      case 'YieldExpression':
        return `yield${node.delegate ? '*' : ''}${node.argument ? ' ' + b(node.argument, depth) : ''}`;
      case 'AssignmentPattern':
        return `${b(node.left)} = ${b(node.right)}`;
      case 'MetaProperty':
        return `${node.meta.name}.${node.property.name}`;
      case 'VariableDeclaration':
        return `${node.kind} ${node.declarations
          .map((d) => (d.init ? `${b(d.id)} = ${b(d.init)}` : b(d.id)))
          .join(', ')}`;
      case 'ObjectPattern':
      case 'ArrayPattern':
      default:
        return collapse(this.src(node));
    }
  }

  paramText(p) {
    if (p.type === 'Identifier') return p.name;
    if (p.type === 'AssignmentPattern') return `${this.paramText(p.left)} = ${this.brief(p.right, 2)}`;
    if (p.type === 'RestElement') return '...' + this.paramText(p.argument);
    return clip(collapse(this.src(p)), 28);
  }

  // ----- units -------------------------------------------------------------

  makeUnit(fn, ctx, { kind, name, shortName = null, methodKind = null, className = null, comments = [], callText = null }) {
    const unit = {
      id: `u${++this.unitCount}`,
      kind,
      name,
      shortName: shortName ?? name,
      methodKind,
      params: (fn.params || []).map((p) => this.paramText(p)),
      async: !!fn.async,
      generator: !!fn.generator,
      arrow: fn.type === 'ArrowFunctionExpression',
      className: className ?? ctx.unit.className ?? null,
      parentId: ctx.unit.id,
      parentName: ctx.unit.kind === 'program' ? null : ctx.unit.name,
      callText,
      comments: [...comments],
      body: [],
      expressionBody: null,
      line: fn.loc.start.line,
      endLine: fn.loc.end.line,
      start: fn.start,
      metrics: newMetrics(),
    };
    this.units.push(unit);
    const uctx = { unit };
    if (fn.body.type === 'BlockStatement') {
      unit.body = this.block(fn.body.body, uctx, fn.body.start + 1, fn.body.end - 1);
    } else {
      unit.expressionBody = this.brief(fn.body);
      unit.expressionCalls = this.scan(fn.body, uctx);
    }
    return unit;
  }

  /** A function expression found inside an expression. */
  functionValue(fn, ctx, hint) {
    const blockBody = fn.body.type === 'BlockStatement';
    if (hint.name) {
      return this.makeUnit(fn, ctx, {
        kind: hint.kind || 'function',
        name: hint.name,
        shortName: hint.shortName,
        methodKind: hint.methodKind,
        comments: hint.comments,
      });
    }
    if (!blockBody) {
      // Short anonymous arrows (`x => x * 2`) stay inline in their parent.
      this.scan(fn.body, ctx);
      return null;
    }
    if (hint.callbackOf) {
      const unit = this.makeUnit(fn, ctx, {
        kind: 'callback',
        name: fn.id ? fn.id.name : `callback for ${hint.callbackOf.shortText}`,
        callText: hint.callbackOf.shortText,
        comments: hint.comments,
      });
      hint.callbackOf.callbackUnitIds.push(unit.id);
      return unit;
    }
    return this.makeUnit(fn, ctx, {
      kind: 'function',
      name: fn.id ? fn.id.name : 'anonymous function',
      comments: hint.comments,
    });
  }

  classInfo(node, ctx, name, comments = []) {
    const className = name || (node.id && node.id.name) || 'anonymous class';
    const info = {
      name: className,
      superClass: node.superClass ? this.brief(node.superClass, 1) : null,
      methods: [],
      unitIds: [],
      comments,
      line: node.loc.start.line,
      endLine: node.loc.end.line,
    };
    const classCtx = { unit: { ...ctx.unit, className } };
    if (node.superClass) this.scan(node.superClass, ctx);
    let prevEnd = node.body.start + 1;
    for (const el of node.body.body) {
      const elComments = groupComments(this.takeComments(prevEnd, el.start)).map((b) => b.text);
      prevEnd = el.end;
      if (el.type === 'StaticBlock') {
        const fake = { params: [], body: { type: 'BlockStatement', body: el.body, start: el.start, end: el.end }, loc: el.loc, start: el.start };
        const unit = this.makeUnit(fake, classCtx, {
          kind: 'method',
          methodKind: 'static block',
          name: `${className} static block`,
          shortName: 'static block',
          className,
          comments: elComments,
        });
        info.unitIds.push(unit.id);
        continue;
      }
      const key = propertyKey(el, (n, d) => this.brief(n, d));
      if (el.type === 'MethodDefinition') {
        const methodKind = el.kind === 'constructor' ? 'constructor' : el.kind; // method | get | set
        const label = el.kind === 'constructor' ? `${className} constructor` : `${className}.${key}`;
        const unit = this.makeUnit(el.value, classCtx, {
          kind: 'method',
          methodKind: el.static && el.kind === 'method' ? 'static method' : methodKind,
          name: label,
          shortName: key,
          className,
          comments: elComments,
        });
        info.methods.push(el.kind === 'get' ? `get ${key}` : el.kind === 'set' ? `set ${key}` : key);
        info.unitIds.push(unit.id);
      } else if (el.type === 'PropertyDefinition') {
        if (isFunctionNode(el.value)) {
          const unit = this.makeUnit(el.value, classCtx, {
            kind: 'method',
            methodKind: el.static ? 'static method' : 'method',
            name: `${className}.${key}`,
            shortName: key,
            className,
            comments: elComments,
          });
          info.methods.push(key);
          info.unitIds.push(unit.id);
        } else if (el.value) {
          this.scan(el.value, classCtx);
        }
      }
    }
    this.classes.push(info);
    return info;
  }

  // ----- expressions -------------------------------------------------------

  callInfo(node) {
    const callee = node.type === 'ImportExpression' ? 'import' : this.brief(node.callee, 1);
    const target = unwrap(node.callee);
    let name = callee;
    let object = null;
    if (target && target.type === 'MemberExpression') {
      name = this.brief(target.property, 2);
      object = this.brief(target.object, 1);
    } else if (target && target.type === 'Identifier') {
      name = target.name;
    }
    const args = node.type === 'ImportExpression' ? [node.source] : node.arguments;
    return {
      callee,
      name,
      object,
      args: args.map((a) => this.brief(a, 2)),
      text: this.brief(node),
      awaited: false,
      isNew: node.type === 'NewExpression',
      callbackUnitIds: [],
      definedHere: null,
      start: node.start,
      shortText: '',
    };
  }

  /**
   * Walk an expression: collect calls (outermost first), count ternaries, and
   * turn nested functions / classes into their own units.
   */
  scan(node, ctx, hint = {}) {
    const calls = [];
    const visit = (n, h = {}) => {
      if (!n || typeof n.type !== 'string') return;
      switch (n.type) {
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          this.functionValue(n, ctx, h);
          return;
        case 'ClassExpression':
          this.classInfo(n, ctx, h.name || (n.id && n.id.name), h.comments);
          return;
        case 'ConditionalExpression':
          ctx.unit.metrics.ternaries++;
          break;
        case 'CallExpression':
        case 'NewExpression':
        case 'ImportExpression': {
          const call = this.callInfo(n);
          calls.push(call);
          const callee = unwrap(n.callee);
          if (n.type === 'CallExpression' && isFunctionNode(callee)) {
            const unit = this.makeUnit(callee, ctx, { kind: 'iife', name: 'immediately-invoked function' });
            call.callee = 'immediately-invoked function';
            call.name = call.callee;
            call.callbackUnitIds.push(unit.id);
            n.arguments.forEach((a) => visit(a));
            return;
          }
          if (n.type === 'ImportExpression') {
            visit(n.source);
            return;
          }
          visit(n.callee);
          n.arguments.forEach((arg, i) => {
            if (isFunctionNode(arg)) {
              call.shortText = clip(
                `${call.callee}(${n.arguments.map((a, j) => (j === i ? '…' : this.brief(a, 3))).join(', ')})`,
                60,
              );
            }
            visit(arg, { callbackOf: call });
          });
          return;
        }
        case 'AwaitExpression': {
          const before = calls.length;
          visit(n.argument, h);
          const inner = unwrap(n.argument);
          if (calls[before] && inner && calls[before].start === inner.start) calls[before].awaited = true;
          return;
        }
        case 'AssignmentExpression':
          visit(n.left);
          visit(n.right, { name: this.brief(n.left, 1), kind: 'function' });
          return;
        case 'ObjectExpression': {
          let prevEnd = n.start + 1;
          for (const p of n.properties) {
            const pComments = groupComments(this.takeComments(prevEnd, p.start)).map((b) => b.text);
            prevEnd = p.end;
            if (p.type !== 'Property') {
              visit(p);
              continue;
            }
            if (p.computed) visit(p.key);
            if (isFunctionNode(p.value)) {
              const key = propertyKey(p, (x, d) => this.brief(x, d));
              visit(p.value, {
                name: h.name ? `${h.name}.${key}` : key,
                shortName: key,
                kind: 'method',
                methodKind: p.kind === 'get' || p.kind === 'set' ? p.kind : 'method',
                comments: pComments,
              });
            } else {
              const key = propertyKey(p, (x, d) => this.brief(x, d));
              visit(p.value, { name: h.name ? `${h.name}.${key}` : key });
            }
          }
          return;
        }
        default:
          break;
      }
      for (const key in n) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
        const v = n[key];
        if (Array.isArray(v)) {
          for (const c of v) if (c && typeof c.type === 'string') visit(c);
        } else if (v && typeof v.type === 'string') {
          visit(v);
        }
      }
    };
    visit(node, hint);
    for (const c of calls) if (!c.shortText) c.shortText = clip(c.text, 60);
    return calls;
  }

  // ----- statements --------------------------------------------------------

  /** Convert a list of sibling statements, attaching comments as we go. */
  block(stmts, ctx, rangeStart, rangeEnd) {
    const out = [];
    let prevEnd = rangeStart;
    let prevLine = null;
    let prevOut = null;
    for (const node of stmts) {
      const between = this.takeComments(prevEnd, node.start);
      const leading = [];
      for (const c of between) {
        if (prevOut && c.loc.start.line === prevLine) {
          const text = cleanComment(c);
          if (text.trim() && !DIRECTIVE_COMMENT.test(text)) (prevOut.trailingComments ||= []).push(text);
        } else {
          leading.push(c);
        }
      }
      const comments = groupComments(leading).map((b) => b.text);
      const produced = this.statement(node, ctx, comments);
      const list = produced == null ? [] : Array.isArray(produced) ? produced : [produced];
      for (const s of list) if (s.line == null) s.line = node.loc.start.line;
      if (list.length && comments.length) {
        const first = list[0];
        if (first.kind === 'define' && first.what === 'function' && first.unitIds.length) {
          const unit = this.units.find((u) => u.id === first.unitIds[0]);
          if (unit) unit.comments.unshift(...comments);
        } else if (first.kind === 'define' && first.what === 'class') {
          first.classInfo.comments.unshift(...comments);
        } else {
          first.comments = [...comments, ...(first.comments || [])];
        }
      } else if (!list.length && comments.length && out.length) {
        (out[out.length - 1].trailingComments ||= []).push(...comments);
      }
      out.push(...list);
      prevEnd = node.end;
      prevLine = node.loc.end.line;
      if (list.length) prevOut = list[list.length - 1];
    }
    if (rangeEnd != null && prevOut) {
      for (const c of this.takeComments(prevEnd, rangeEnd)) {
        if (c.loc.start.line === prevLine) {
          const text = cleanComment(c);
          if (text.trim() && !DIRECTIVE_COMMENT.test(text)) (prevOut.trailingComments ||= []).push(text);
        }
      }
    }
    return out;
  }

  body(node, ctx) {
    if (!node) return [];
    if (node.type === 'BlockStatement') return this.block(node.body, ctx, node.start + 1, node.end - 1);
    return this.block([node], ctx, node.start, node.end);
  }

  statement(node, ctx, comments) {
    const m = ctx.unit.metrics;
    switch (node.type) {
      case 'ExpressionStatement':
        if (node.directive) return { kind: 'directive', text: node.directive };
        return this.expressionStatement(node.expression, ctx);

      case 'VariableDeclaration':
        return this.declaration(node, ctx, false);

      case 'FunctionDeclaration': {
        const name = node.id ? node.id.name : 'default export';
        const unit = this.makeUnit(node, ctx, { kind: 'function', name });
        return { kind: 'define', what: 'function', name, unitIds: [unit.id], exported: false };
      }

      case 'ClassDeclaration': {
        const info = this.classInfo(node, ctx, node.id ? node.id.name : 'default export');
        return { kind: 'define', what: 'class', name: info.name, unitIds: info.unitIds, exported: false, classInfo: info };
      }

      case 'IfStatement': {
        m.ifs++;
        const testCalls = this.scan(node.test, ctx);
        return {
          kind: 'if',
          test: this.brief(node.test),
          testCalls,
          consequent: this.body(node.consequent, ctx),
          alternate: node.alternate ? this.body(node.alternate, ctx) : null,
        };
      }

      case 'ForStatement': {
        m.loops++;
        if (node.init) this.scan(node.init, ctx);
        if (node.test) this.scan(node.test, ctx);
        if (node.update) this.scan(node.update, ctx);
        return {
          kind: 'loop',
          loopKind: 'for',
          init: node.init ? this.brief(node.init) : null,
          test: node.test ? this.brief(node.test) : null,
          update: node.update ? this.brief(node.update) : null,
          body: this.body(node.body, ctx),
        };
      }

      case 'ForInStatement':
      case 'ForOfStatement': {
        m.loops++;
        const left =
          node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left;
        const iterableCalls = this.scan(node.right, ctx);
        return {
          kind: 'loop',
          loopKind: node.type === 'ForInStatement' ? 'for-in' : 'for-of',
          variable: this.brief(left, 1),
          declKind: node.left.type === 'VariableDeclaration' ? node.left.kind : null,
          iterable: this.brief(node.right),
          iterableCalls,
          awaited: !!node.await,
          body: this.body(node.body, ctx),
        };
      }

      case 'WhileStatement':
      case 'DoWhileStatement': {
        m.loops++;
        this.scan(node.test, ctx);
        return {
          kind: 'loop',
          loopKind: node.type === 'WhileStatement' ? 'while' : 'do-while',
          test: this.brief(node.test),
          body: this.body(node.body, ctx),
        };
      }

      case 'LabeledStatement': {
        const inner = this.statement(node.body, ctx, comments);
        const first = Array.isArray(inner) ? inner[0] : inner;
        if (first && first.kind === 'loop') first.label = node.label.name;
        return inner;
      }

      case 'SwitchStatement': {
        this.scan(node.discriminant, ctx);
        const cases = [];
        let prevEnd = node.discriminant.end;
        for (const c of node.cases) {
          if (c.test) m.cases++;
          const caseComments = groupComments(this.takeComments(prevEnd, c.start)).map((b) => b.text);
          prevEnd = c.end;
          if (c.test) this.scan(c.test, ctx);
          cases.push({
            test: c.test ? this.brief(c.test, 1) : null,
            comments: caseComments,
            body: this.block(c.consequent, ctx, c.test ? c.test.end : c.start, c.end),
          });
        }
        return { kind: 'switch', discriminant: this.brief(node.discriminant), cases };
      }

      case 'TryStatement':
        return {
          kind: 'try',
          block: this.body(node.block, ctx),
          param: node.handler && node.handler.param ? this.brief(node.handler.param, 1) : null,
          handler: node.handler ? this.body(node.handler.body, ctx) : null,
          finalizer: node.finalizer ? this.body(node.finalizer, ctx) : null,
        };

      case 'ReturnStatement':
        return {
          kind: 'return',
          value: node.argument ? this.brief(node.argument) : null,
          calls: node.argument ? this.scan(node.argument, ctx) : [],
        };

      case 'ThrowStatement':
        return { kind: 'throw', value: this.brief(node.argument), calls: this.scan(node.argument, ctx) };

      case 'BreakStatement':
        return { kind: 'break', label: node.label ? node.label.name : null };

      case 'ContinueStatement':
        return { kind: 'continue', label: node.label ? node.label.name : null };

      case 'BlockStatement':
        return this.block(node.body, ctx, node.start + 1, node.end - 1);

      case 'EmptyStatement':
        return null;

      case 'ImportDeclaration': {
        const names = node.specifiers.map((s) => {
          if (s.type === 'ImportDefaultSpecifier') return s.local.name;
          if (s.type === 'ImportNamespaceSpecifier') return `* as ${s.local.name}`;
          const imported = s.imported.type === 'Identifier' ? s.imported.name : String(s.imported.value);
          return imported === s.local.name ? imported : `${imported} as ${s.local.name}`;
        });
        const source = String(node.source.value);
        this.imports.push({ source, names });
        return { kind: 'import', source, names };
      }

      case 'ExportNamedDeclaration': {
        if (node.declaration) {
          const inner = this.statement(node.declaration, ctx, []);
          const list = Array.isArray(inner) ? inner : inner ? [inner] : [];
          for (const s of list) {
            s.exported = true;
            if (s.kind === 'define') this.exports.push(s.name);
            else if (s.kind === 'declare') this.exports.push(s.target);
          }
          return list;
        }
        const names = node.specifiers.map((s) => {
          const local = s.local.type === 'Identifier' ? s.local.name : String(s.local.value);
          const exported = s.exported.type === 'Identifier' ? s.exported.name : String(s.exported.value);
          return local === exported ? local : `${local} as ${exported}`;
        });
        this.exports.push(...names);
        return { kind: 'export', names, source: node.source ? String(node.source.value) : null, value: null };
      }

      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
          const inner = this.statement(d, ctx, []);
          inner.exported = 'default';
          this.exports.push(`default (${inner.name})`);
          return inner;
        }
        if (isFunctionNode(d)) {
          const unit = this.makeUnit(d, ctx, { kind: 'function', name: 'default export' });
          this.exports.push('default');
          return { kind: 'define', what: 'function', name: 'default export', unitIds: [unit.id], exported: 'default' };
        }
        const calls = this.scan(d, ctx, { name: 'default export' });
        this.exports.push('default');
        return { kind: 'export', names: ['default'], source: null, value: this.brief(d), calls };
      }

      case 'ExportAllDeclaration':
        this.exports.push(node.exported ? `* as ${this.brief(node.exported)}` : '*');
        return {
          kind: 'export',
          names: [node.exported ? `* as ${this.brief(node.exported)}` : '*'],
          source: String(node.source.value),
          value: null,
        };

      default: {
        // with, debugger, and anything newer than this tool knows about.
        return { kind: 'other', text: clip(collapse(this.src(node)), 80) };
      }
    }
  }

  declaration(node, ctx) {
    const out = [];
    for (const d of node.declarations) {
      const target = this.brief(d.id, 1);
      const init = d.init ? unwrap(d.init) : null;
      if (init && isFunctionNode(init)) {
        const unit = this.makeUnit(init, ctx, { kind: 'function', name: target });
        out.push({ kind: 'define', what: 'function', name: target, unitIds: [unit.id], exported: false, declKind: node.kind });
        continue;
      }
      if (init && init.type === 'ClassExpression') {
        const info = this.classInfo(init, ctx, target);
        out.push({ kind: 'define', what: 'class', name: target, unitIds: info.unitIds, exported: false, classInfo: info });
        continue;
      }
      const calls = d.init ? this.scan(d.init, ctx, { name: target }) : [];
      out.push({
        kind: 'declare',
        declKind: node.kind,
        target,
        value: d.init ? this.brief(d.init) : null,
        calls,
      });
    }
    return out;
  }

  expressionStatement(expr, ctx) {
    const e = unwrap(expr);
    switch (e.type) {
      case 'SequenceExpression':
        return e.expressions.flatMap((x) => {
          const r = this.expressionStatement(x, ctx);
          return Array.isArray(r) ? r : [r];
        });

      case 'AssignmentExpression': {
        // `a = b = value` assigns one value to several targets.
        const targets = [this.brief(e.left, 1)];
        let right = unwrap(e.right);
        while (e.operator === '=' && right.type === 'AssignmentExpression' && right.operator === '=') {
          targets.push(this.brief(right.left, 1));
          right = unwrap(right.right);
        }
        const target = targets[targets.length - 1];
        const aliases = targets.slice(0, -1);
        for (const t of targets) {
          if (/^(module\.)?exports\./.test(t)) this.exports.push(t.replace(/^module\./, ''));
        }
        if (e.operator === '=' && isFunctionNode(right)) {
          const unit = this.makeUnit(right, ctx, {
            kind: 'function',
            name: target,
            shortName: target.split('.').pop(),
          });
          return { kind: 'define', what: 'function', name: target, aliases, unitIds: [unit.id], exported: false };
        }
        if (e.operator === '=' && right.type === 'ClassExpression') {
          const info = this.classInfo(right, ctx, target);
          return { kind: 'define', what: 'class', name: target, aliases, unitIds: info.unitIds, exported: false, classInfo: info };
        }
        const calls = [...this.scan(e.left, ctx), ...this.scan(e.right, ctx, { name: target })];
        const value = this.brief(right);
        if (targets.includes('module.exports')) this.exports.push(`module.exports = ${clip(value, 32)}`);
        return { kind: 'assign', target: targets[0], targets, operator: e.operator, value, calls };
      }

      case 'UpdateExpression':
        return { kind: 'update', target: this.brief(e.argument, 1), operator: e.operator };

      case 'LogicalExpression': {
        // `ready && start()` is a compact if-statement; show it as one.
        const right = unwrap(e.right);
        const actionLike =
          isCallLike(right) || right.type === 'AssignmentExpression' || right.type === 'UpdateExpression';
        if (actionLike) {
          ctx.unit.metrics.ifs++;
          this.scan(e.left, ctx);
          const left = this.brief(e.left);
          const test =
            e.operator === '&&' ? left : e.operator === '||' ? `!(${left})` : `${left} == null`;
          const r = this.expressionStatement(right, ctx);
          return { kind: 'if', test, consequent: Array.isArray(r) ? r : [r], alternate: null, fromExpression: true };
        }
        break;
      }

      case 'ConditionalExpression': {
        const c = unwrap(e.consequent);
        const a = unwrap(e.alternate);
        if (isCallLike(c) || isCallLike(a) || c.type === 'AssignmentExpression' || a.type === 'AssignmentExpression') {
          ctx.unit.metrics.ternaries++;
          this.scan(e.test, ctx);
          const cr = this.expressionStatement(c, ctx);
          const ar = this.expressionStatement(a, ctx);
          return {
            kind: 'if',
            test: this.brief(e.test),
            consequent: Array.isArray(cr) ? cr : [cr],
            alternate: Array.isArray(ar) ? ar : [ar],
            fromExpression: true,
          };
        }
        break;
      }

      default:
        break;
    }

    const calls = this.scan(e, ctx);
    if (isCallLike(e)) return { kind: 'call', text: this.brief(e), calls };
    return { kind: 'expression', text: this.brief(e), calls };
  }

  // ----- post-processing ---------------------------------------------------

  /** Mark calls whose callee is a function defined in this same file. */
  resolveLocalCalls(program) {
    const byName = new Map();
    for (const u of this.units) {
      if (u.kind === 'callback' || u.kind === 'iife' || u.name === 'anonymous function') continue;
      if (!byName.has(u.name)) byName.set(u.name, u.id);
    }
    const resolve = (calls, unit) => {
      for (const c of calls || []) {
        let id = byName.get(c.callee);
        if (!id && unit.className && /^this\./.test(c.callee)) {
          const method = this.units.find((u) => u.className === unit.className && u.shortName === c.name);
          if (method) id = method.id;
        }
        if (!id && c.isNew) {
          const ctor = this.units.find((u) => u.className === c.callee && u.methodKind === 'constructor');
          if (ctor) id = ctor.id;
        }
        c.definedHere = id || null;
      }
    };
    for (const unit of [program, ...this.units]) {
      resolve(unit.expressionCalls, unit);
      walkStatements(unit.body, (s) => {
        resolve(s.calls, unit);
        resolve(s.testCalls, unit);
        resolve(s.iterableCalls, unit);
      });
    }
  }
}
