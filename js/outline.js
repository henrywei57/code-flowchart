/**
 * The "outline" is the language-neutral form that every language parser
 * produces and that the flowchart and explanation builders consume.
 *
 * Only files in js/languages/ know about a specific language's AST. To add a
 * new language (e.g. Python), write a parser that returns this same shape and
 * register it in js/parser.js; nothing else needs to change.
 *
 * All "code" fields (test, value, target, text, ...) are short, display-ready
 * source snippets (strings), already compacted by the language parser.
 *
 * @typedef {{ ifs: number, cases: number, ternaries: number, loops: number }} Metrics
 *
 * @typedef {Object} Call
 * @property {string} callee        Callee as written, e.g. "console.log"
 * @property {string} name          Last segment of the callee, e.g. "log"
 * @property {string|null} object   Receiver for member calls, e.g. "console"
 * @property {string[]} args        Argument snippets
 * @property {string} text          Whole call snippet
 * @property {boolean} awaited
 * @property {boolean} isNew        `new Foo()` rather than `Foo()`
 * @property {string[]} callbackUnitIds  Units created for function arguments
 * @property {string|null} definedHere   Unit id when the callee is defined in this file
 *
 * @typedef {Object} Stmt
 * @property {string} kind  One of:
 *   declare  { declKind, target, value, calls }
 *   assign   { target, operator, value, calls }
 *   update   { target, operator }
 *   call     { text, calls }                       expression statement that is a call
 *   expression { text, calls }
 *   if       { test, consequent: Stmt[], alternate: Stmt[]|null }
 *   loop     { loopKind: 'for'|'for-of'|'for-in'|'while'|'do-while',
 *              init, test, update, variable, iterable, label, awaited, body: Stmt[] }
 *   switch   { discriminant, cases: { test: string|null, body: Stmt[], comments }[] }
 *   try      { block: Stmt[], param, handler: Stmt[]|null, finalizer: Stmt[]|null }
 *   return   { value, calls }
 *   throw    { value, calls }
 *   break    { label }
 *   continue { label }
 *   define   { what: 'function'|'class', name, unitIds, exported }
 *   import   { source, names }
 *   export   { names, source, value }
 *   directive{ text }
 *   other    { text }
 * @property {number} line
 * @property {string[]} [comments]          Leading comments, verbatim (delimiters stripped)
 * @property {string[]} [trailingComments]  Same-line comments after the statement
 *
 * @typedef {Object} Unit  A function-like piece of code (or the file's top level)
 * @property {string} id
 * @property {'program'|'function'|'method'|'callback'|'iife'} kind
 * @property {string} name
 * @property {string} [shortName]      Method name without the class prefix
 * @property {string} [methodKind]     constructor | method | get | set | static block
 * @property {string[]} params
 * @property {boolean} async
 * @property {boolean} generator
 * @property {string|null} className
 * @property {string|null} parentId
 * @property {string|null} callText     For callbacks: the call they are passed to
 * @property {string[]} comments        Leading comment blocks, verbatim
 * @property {Stmt[]} body
 * @property {string|null} expressionBody  Arrow functions like `x => x * 2`
 * @property {Call[]} [expressionCalls]
 * @property {number} line
 * @property {number} endLine
 * @property {Metrics} metrics
 *
 * @typedef {Object} Outline
 * @property {string} language
 * @property {number} lineCount
 * @property {string[]} headerComments   Comment blocks at the top of the file
 * @property {Unit} program              Top-level code, as a unit of kind 'program'
 * @property {Unit[]} units              Every function-like unit, in source order
 * @property {{ name, superClass, methods, line, endLine, comments, unitIds }[]} classes
 * @property {{ source: string, names: string[] }[]} imports
 * @property {string[]} exports
 */

export class CodeParseError extends Error {
  /**
   * @param {string} message
   * @param {{ line?: number, column?: number, hint?: string }} [details]
   */
  constructor(message, { line = null, column = null, hint = null } = {}) {
    super(message);
    this.name = 'CodeParseError';
    this.line = line;
    this.column = column;
    this.hint = hint;
  }
}

export function newMetrics() {
  return { ifs: 0, cases: 0, ternaries: 0, loops: 0 };
}

/** Branches (if / else-if, switch cases, ternaries) plus loops. */
export function complexityOf(metrics) {
  const branches = metrics.ifs + metrics.cases + metrics.ternaries;
  return { branches, loops: metrics.loops, total: branches + metrics.loops };
}

export function addMetrics(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
  return target;
}

/** Nested statement lists of a statement, for generic traversal. */
export function childLists(stmt) {
  switch (stmt.kind) {
    case 'if':
      return [stmt.consequent, stmt.alternate || []];
    case 'loop':
      return [stmt.body];
    case 'switch':
      return stmt.cases.map((c) => c.body);
    case 'try':
      return [stmt.block, stmt.handler || [], stmt.finalizer || []];
    default:
      return [];
  }
}

/** Depth-first visit of every statement in a list, including nested ones. */
export function walkStatements(stmts, visit) {
  for (const stmt of stmts) {
    visit(stmt);
    for (const list of childLists(stmt)) walkStatements(list, visit);
  }
}

/**
 * Human-readable naming for a unit, shared by the flowchart and explanation.
 * @returns {{ title: string, signature: string, kindLabel: string }}
 */
export function describeUnit(unit) {
  const signature = `${unit.name}(${unit.params.join(', ')})`;
  let kindLabel;
  switch (unit.kind) {
    case 'program':
      return { title: 'Top-level code', signature: 'Top-level code', kindLabel: 'file' };
    case 'callback':
      kindLabel = 'callback';
      break;
    case 'iife':
      kindLabel = 'IIFE';
      break;
    case 'method':
      kindLabel =
        unit.methodKind === 'get' ? 'getter' : unit.methodKind === 'set' ? 'setter' : unit.methodKind || 'method';
      break;
    default:
      kindLabel = unit.arrow ? 'arrow function' : 'function';
  }
  if (unit.generator) kindLabel = `generator ${kindLabel}`;
  if (unit.async) kindLabel = `async ${kindLabel}`;
  let title = signature;
  if (unit.kind === 'callback') title = `Callback for ${unit.callText || 'a call'}`;
  else if (unit.kind === 'iife') title = 'Immediately-invoked function';
  else if (unit.methodKind === 'constructor') title = `${unit.className} constructor(${unit.params.join(', ')})`;
  else if (unit.methodKind === 'static block') title = `${unit.className} static block`;
  return { title, signature, kindLabel };
}

/** Statements that only declare things (no visible run-time behavior). */
export function isDeclarationOnly(stmt) {
  return (
    stmt.kind === 'define' ||
    stmt.kind === 'import' ||
    stmt.kind === 'directive' ||
    (stmt.kind === 'export' && !stmt.value)
  );
}
