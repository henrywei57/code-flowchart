// Explanation generation: turns an outline (js/outline.js) into plain-English
// text using fixed sentence templates keyed to statement kind. No AI/LLM —
// every sentence comes from a template below filled with code snippets.
//
// Output is structured data (sentences made of "parts") so the UI can render
// it safely as HTML and export it as Markdown.
//
// A part is either a plain string, { code } for a code snippet, or
// { code, ref } / { text, ref } for a link to another unit's section.

import { addMetrics, complexityOf, describeUnit, isDeclarationOnly, newMetrics, walkStatements } from './outline.js';

// ---------------------------------------------------------------------------
// Sentence helpers
// ---------------------------------------------------------------------------

const code = (text, ref = null) => (ref ? { code: String(text), ref } : { code: String(text) });
const link = (text, ref) => ({ text, ref });

/** Tagged template: t`Loops over ${code(x)}.` → ['Loops over ', {code: x}, '.'] */
function t(strings, ...values) {
  const parts = [];
  strings.forEach((s, i) => {
    if (s) parts.push(s);
    if (i < values.length) {
      const v = values[i];
      if (Array.isArray(v)) parts.push(...v);
      else if (v != null && v !== '' && v !== false) parts.push(v);
    }
  });
  return parts;
}

function sentence(parts) {
  const out = parts.slice();
  if (typeof out[0] === 'string') out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
  const last = out[out.length - 1];
  if (typeof last === 'string') {
    if (!/[.:!?]$/.test(last)) out[out.length - 1] = last + '.';
  } else {
    out.push('.');
  }
  return out;
}

function plural(n, word, pluralWord = word + 's') {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** [a, b, c] → `a`, `b`, and `c` (long lists are shortened). */
function codeList(items, { max = 4, conj = 'and', refs = [] } = {}) {
  const shown = items.length > max ? items.slice(0, max - 1) : items;
  const parts = [];
  shown.forEach((item, i) => {
    if (i > 0) parts.push(shown.length === 2 && items.length === 2 ? ` ${conj} ` : i === shown.length - 1 && items.length === shown.length ? `, ${conj} ` : ', ');
    parts.push(code(item, refs[i] || null));
  });
  if (items.length > shown.length) parts.push(`, ${conj} ${items.length - shown.length} more`);
  return parts;
}

function paramPhrase(params) {
  return params.length ? t`takes ${codeList(params)} as input` : 'takes no input';
}

function article(word) {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

// ---------------------------------------------------------------------------
// Calls: friendly templates for common APIs, generic fallback otherwise
// ---------------------------------------------------------------------------

const arg = (c, i) => c.args[i];

const CALL_TEMPLATES = [
  [(c) => /^console\.(log|info|debug)$/.test(c.callee), (c) => (c.args.length ? t`logs ${codeList(c.args)} to the console` : 'logs an empty line to the console')],
  [(c) => /^console\.(error|warn)$/.test(c.callee), (c) => t`logs ${c.name === 'error' ? 'an error' : 'a warning'}${c.args.length ? t` (${codeList(c.args)})` : ''} to the console`],
  [(c) => c.object && c.name === 'push', (c) => t`adds ${codeList(c.args)} to the end of ${code(c.object)}`],
  [(c) => c.object && c.name === 'unshift', (c) => t`adds ${codeList(c.args)} to the start of ${code(c.object)}`],
  [(c) => c.object && c.name === 'pop' && !c.args.length, (c) => t`removes the last item from ${code(c.object)}`],
  [(c) => c.object && c.name === 'shift' && !c.args.length, (c) => t`removes the first item from ${code(c.object)}`],
  [(c) => c.object && c.name === 'forEach', (c) => t`runs a callback for each item in ${code(c.object)}`],
  [(c) => c.object && c.name === 'map' && c.args.length, (c) => t`builds a new array by transforming each item of ${code(c.object)}`],
  [(c) => c.object && c.name === 'filter' && c.args.length, (c) => t`keeps only the items of ${code(c.object)} that pass a test`],
  [(c) => c.object && c.name === 'find' && c.args.length, (c) => t`looks for the first item in ${code(c.object)} that passes a test`],
  [(c) => c.object && c.name === 'reduce', (c) => t`combines the items of ${code(c.object)} into a single value`],
  [(c) => c.object && (c.name === 'some' || c.name === 'every'), (c) => t`checks whether ${c.name === 'some' ? 'any item' : 'every item'} of ${code(c.object)} passes a test`],
  [(c) => c.object && c.name === 'includes' && c.args.length === 1, (c) => t`checks whether ${code(c.object)} contains ${code(arg(c, 0))}`],
  [(c) => c.object && c.name === 'join', (c) => t`joins the items of ${code(c.object)} into one string`],
  [(c) => c.object && c.name === 'split' && c.args.length, (c) => t`splits ${code(c.object)} into pieces at each ${code(arg(c, 0))}`],
  [(c) => c.object && c.name === 'sort', (c) => t`sorts ${code(c.object)} in place`],
  [(c) => c.callee === 'fetch' && c.args.length, (c) => t`requests ${code(arg(c, 0))} over the network`],
  [(c) => c.callee === 'setTimeout', (c) => (c.args[1] ? t`schedules a callback to run after ${code(arg(c, 1))} ms` : 'schedules a callback to run as soon as possible')],
  [(c) => c.callee === 'setInterval', (c) => t`schedules a callback to run every ${code(arg(c, 1) || '?')} ms`],
  [(c) => /^clear(Timeout|Interval)$/.test(c.callee), (c) => t`cancels the timer ${code(arg(c, 0) || '')}`],
  [(c) => c.name === 'addEventListener' && c.args.length, (c) => t`listens for ${code(arg(c, 0))} events${c.object ? t` on ${code(c.object)}` : ''}`],
  [(c) => c.name === 'removeEventListener' && c.args.length, (c) => t`stops listening for ${code(arg(c, 0))} events${c.object ? t` on ${code(c.object)}` : ''}`],
  [(c) => c.callee === 'require' && c.args.length, (c) => t`loads the module ${code(arg(c, 0))}`],
  [(c) => c.callee === 'import', (c) => t`loads the module ${code(arg(c, 0))} on demand`],
  [(c) => c.callee === 'JSON.parse', (c) => t`parses ${code(arg(c, 0))} as JSON`],
  [(c) => c.callee === 'JSON.stringify', (c) => t`converts ${code(arg(c, 0))} to a JSON string`],
  [(c) => /^document\.querySelectorAll$/.test(c.callee), (c) => t`finds every element matching ${code(arg(c, 0))} in the page`],
  [(c) => /^document\.(querySelector|getElementById)$/.test(c.callee), (c) => t`finds the element ${code(arg(c, 0))} in the page`],
  [(c) => c.object && c.name === 'then', (c) => t`waits for ${code(c.object)} to finish, then runs a callback with the result`],
  [(c) => c.object && c.name === 'catch' && !/^(this|console)$/.test(c.object), (c) => t`handles any error from ${code(c.object)}`],
  [(c) => /^Promise\.(all|allSettled)$/.test(c.callee), (c) => t`runs ${code(arg(c, 0))} at the same time and waits for all of them`],
  [(c) => c.callee === 'Promise.race', (c) => t`waits for whichever of ${code(arg(c, 0))} finishes first`],
  [(c) => /^Object\.(keys|values|entries)$/.test(c.callee), (c) => t`gets the ${c.name} of ${code(arg(c, 0))}`],
  [(c) => /^Math\.(max|min)$/.test(c.callee) && c.args.length, (c) => t`finds the ${c.name === 'max' ? 'largest' : 'smallest'} of ${codeList(c.args)}`],
  [(c) => /^(app|router|server)$/.test(c.object || '') && /^(get|post|put|patch|delete)$/.test(c.name) && c.args.length > 1, (c) => t`registers a handler for ${c.name.toUpperCase()} requests to ${code(arg(c, 0))}`],
  [(c) => /^(app|router)$/.test(c.object || '') && c.name === 'use', (c) => t`adds middleware to ${code(c.object)}`],
  [(c) => c.object && c.name === 'listen' && c.args.length, (c) => t`starts ${code(c.object)} listening on port ${code(arg(c, 0))}`],
  [(c) => /^res$/.test(c.object || '') && /^(send|json)$/.test(c.name), (c) => t`sends ${code(arg(c, 0) || 'nothing')} back as the response`],
  [(c) => c.isNew && c.callee === 'Promise', () => 'creates a new Promise'],
  [(c) => c.isNew && /Error$/.test(c.callee), (c) => t`creates a new ${code(c.callee)}${c.args.length ? t` with the message ${code(arg(c, 0))}` : ''}`],
  [(c) => c.isNew, (c) => t`creates a new ${code(c.callee)}${c.args.length ? t` from ${codeList(c.args)}` : ''}`],
];

function callPhrase(call) {
  if (call.callee === 'immediately-invoked function') {
    return t`runs a function immediately (${link('explained below', call.callbackUnitIds[0])})`;
  }
  let parts = null;
  for (const [test, render] of CALL_TEMPLATES) {
    if (test(call)) {
      const out = render(call);
      parts = typeof out === 'string' ? [out] : out;
      break;
    }
  }
  if (!parts) {
    parts = t`calls ${code(call.callee, call.definedHere)}${call.args.length ? t` with ${codeList(call.args)}` : ''}`;
    if (call.definedHere) parts.push(' (defined in this file)');
  }
  if (call.callbackUnitIds.length) {
    parts.push(' (', link(call.callbackUnitIds.length > 1 ? 'callbacks explained below' : 'callback explained below', call.callbackUnitIds[0]), ')');
  }
  return parts;
}

/** The value is exactly one call (optionally awaited), not a larger expression. */
function directCall(value, calls) {
  if (!value || !calls || !calls.length) return null;
  const bare = value.replace(/^await\s+/, '');
  return bare === calls[0].text ? calls[0] : null;
}

function withResult(call, target) {
  const parts = callPhrase(call);
  if (call.awaited) return t`${parts}, waits for it to finish, and stores the result in ${code(target)}`;
  if (call.isNew) return t`${parts} and stores it in ${code(target)}`;
  return t`${parts} and stores the result in ${code(target)}`;
}

// ---------------------------------------------------------------------------
// Statement phrases (lower-case verb phrases, no final period)
// ---------------------------------------------------------------------------

const ASSIGN_TEMPLATES = {
  '+=': (s) => t`adds ${code(s.value)} to ${code(s.target)}`,
  '-=': (s) => t`subtracts ${code(s.value)} from ${code(s.target)}`,
  '*=': (s) => t`multiplies ${code(s.target)} by ${code(s.value)}`,
  '/=': (s) => t`divides ${code(s.target)} by ${code(s.value)}`,
  '%=': (s) => t`sets ${code(s.target)} to the remainder after dividing by ${code(s.value)}`,
  '||=': (s) => t`sets ${code(s.target)} to ${code(s.value)} if it is empty or false`,
  '&&=': (s) => t`sets ${code(s.target)} to ${code(s.value)} if it is truthy`,
  '??=': (s) => t`sets ${code(s.target)} to ${code(s.value)} if it is null or undefined`,
};

const asParts = (x) => (Array.isArray(x) ? x : [x]);

function phrase(s, ctx) {
  return asParts(phraseRaw(s, ctx));
}

function phraseRaw(s, ctx) {
  switch (s.kind) {
    case 'declare': {
      if (s.value == null) return t`declares ${code(s.target)} (with no value yet)`;
      const call = directCall(s.value, s.calls);
      if (call) return withResult(call, s.target);
      if (/^[[{]/.test(s.target)) return t`unpacks ${code(s.target)} from ${code(s.value)}`;
      if (s.declKind === 'const') return t`creates a constant ${code(s.target)} set to ${code(s.value)}`;
      return t`creates ${code(s.target)} and sets it to ${code(s.value)}`;
    }
    case 'assign': {
      if (s.target === 'module.exports') return t`exports ${code(s.value)} as this module's public interface`;
      const exp = /^(?:module\.)?exports\.(.+)$/.exec(s.target);
      if (exp && s.operator === '=') return t`exports ${code(s.value)} under the name ${code(exp[1])}`;
      if (s.operator === '=') {
        if (s.targets && s.targets.length > 1) return t`sets ${codeList(s.targets)} to ${code(s.value)}`;
        const call = directCall(s.value, s.calls);
        if (call) return withResult(call, s.target);
        return t`sets ${code(s.target)} to ${code(s.value)}`;
      }
      const template = ASSIGN_TEMPLATES[s.operator];
      return template ? template(s) : t`updates ${code(s.target)} with ${code(`${s.operator} ${s.value}`)}`;
    }
    case 'update':
      return t`${s.operator === '++' ? 'increases' : 'decreases'} ${code(s.target)} by 1`;
    case 'call': {
      const call = s.calls[0];
      if (!call) return t`runs ${code(s.text)}`;
      const parts = callPhrase(call);
      return call.awaited ? t`${parts} and waits for it to finish` : parts;
    }
    case 'expression':
      return t`evaluates ${code(s.text)}`;
    case 'return':
      return s.value != null ? t`returns ${code(s.value)}` : 'returns without a value';
    case 'throw':
      return t`throws ${code(s.value)}, which stops the function`;
    case 'break':
      if (s.label) return t`exits the ${code(s.label)} loop`;
      return ctx.breakable === 'switch' ? 'stops checking further cases' : 'exits the loop early';
    case 'continue':
      return 'skips the rest of this pass and moves on to the next one';
    case 'define': {
      const also = s.aliases && s.aliases.length ? t`, also available as ${codeList(s.aliases, { conj: 'and' })}` : '';
      return s.what === 'class'
        ? t`defines the class ${code(s.name)}${also} (${link('explained below', `class:${s.name}`)})`
        : t`defines the function ${code(s.name, s.unitIds[0])}${also} (${link('explained below', s.unitIds[0])})`;
    }
    case 'import':
      return s.names.length
        ? t`imports ${codeList(s.names)} from ${code(s.source)}`
        : t`loads the module ${code(s.source)} for its side effects`;
    case 'export':
      if (s.value) return t`exports ${code(s.value)} as the default export`;
      if (s.source) return t`re-exports ${codeList(s.names)} from ${code(s.source)}`;
      return t`exports ${codeList(s.names)}`;
    case 'directive':
      return s.text === 'use strict' ? 'turns on strict mode' : t`declares the directive ${code(s.text)}`;
    case 'if':
      return t`checks whether ${code(s.test)}`;
    case 'loop':
      return loopSummary(s);
    case 'switch':
      return t`checks ${code(s.discriminant)} against ${plural(s.cases.length, 'case')}`;
    case 'try':
      return 'tries some steps and handles any error they throw';
    default:
      return t`runs ${code(s.text || s.kind)}`;
  }
}

const COMPOUND = new Set(['if', 'loop', 'switch', 'try']);

/** Short phrase for a branch body, used inside "If …, then {summary}". */
function summarize(body, ctx) {
  return asParts(summarizeRaw(body, ctx));
}

function summarizeRaw(body, ctx) {
  const real = body.filter((s) => s.kind !== 'directive');
  if (!real.length) return 'does nothing';
  if (real.length === 1 && !COMPOUND.has(real[0].kind)) {
    const s = real[0];
    if (s.kind === 'return') return s.value != null ? t`returns ${code(s.value)}` : 'returns early';
    if (s.kind === 'throw') return t`throws ${code(s.value)}`;
    return phrase(s, ctx);
  }
  return real.length === 1 ? 'runs the steps below' : `runs the ${real.length} steps below`;
}

function needsList(body) {
  const real = body.filter((s) => s.kind !== 'directive');
  return real.length > 1 || (real.length === 1 && COMPOUND.has(real[0].kind));
}

function loopSummary(s) {
  switch (s.loopKind) {
    case 'for-of':
      return t`loops over ${code(s.iterable)}`;
    case 'for-in':
      return t`loops over the keys of ${code(s.iterable)}`;
    case 'while':
    case 'do-while':
      return t`repeats while ${code(s.test)}`;
    default:
      return s.test ? t`repeats while ${code(s.test)}` : 'repeats forever';
  }
}

/** `for (let i = 0; i < items.length; i++)` → { index: 'i', list: 'items' } */
function indexLoop(s) {
  if (!s.test || !s.init || !s.update) return null;
  const m = /^(\w+)\s*<\s*(.+)\.length$/.exec(s.test);
  if (!m) return null;
  const [, index, list] = m;
  const initOk = new RegExp(`^(?:let |var )?${index}\\s*=\\s*0$`).test(s.init);
  const updateOk = [`${index}++`, `++${index}`, `${index} += 1`, `${index} = ${index} + 1`].includes(s.update);
  return initOk && updateOk ? { index, list } : null;
}

function loopSentence(s) {
  const forever = !s.test || /^(true|1|!0)$/.test(s.test);
  switch (s.loopKind) {
    case 'for-of':
      return s.awaited
        ? t`Waits for each item of ${code(s.iterable)} in turn (${code(s.variable)}), repeating the block below for each one.`
        : t`Loops over ${code(s.iterable)}, repeating the block below for each item (${code(s.variable)}).`;
    case 'for-in':
      return t`Loops over each key (${code(s.variable)}) of ${code(s.iterable)}, repeating the block below for each one.`;
    case 'while':
      return forever
        ? 'Repeats the block below forever, until something inside it exits the loop.'
        : t`Repeats the block below while ${code(s.test)}.`;
    case 'do-while':
      return t`Runs the block below once, then keeps repeating it while ${code(s.test)}.`;
    default: {
      const idx = indexLoop(s);
      if (idx) return t`Loops over ${code(idx.list)} by position (${code(idx.index)}), repeating the block below for each item.`;
      if (forever) return t`${s.init ? t`Starts with ${code(s.init)}, then repeats` : 'Repeats'} the block below forever, until something inside it exits the loop.`;
      return t`${s.init ? t`Starts with ${code(s.init)}, then repeats` : 'Repeats'} the block below while ${code(s.test)}${s.update ? t`, running ${code(s.update)} after each pass` : ''}.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Step
 * @property {Array} parts         The sentence
 * @property {string[]} comments   Code comments above this statement, verbatim
 * @property {string[]} trailing   Same-line code comments, verbatim
 * @property {Step[]} children
 * @property {boolean} [group]     A label such as "Otherwise:" heading its children
 */

function step(parts, s = null, children = [], extra = {}) {
  return {
    parts: asParts(parts),
    comments: (s && s.comments) || [],
    trailing: (s && s.trailingComments) || [],
    children,
    ...extra,
  };
}

/** `const x = require('x')` */
function requiredModule(s) {
  if (s.kind !== 'declare') return null;
  const call = directCall(s.value, s.calls);
  return call && call.callee === 'require' && call.args.length === 1 ? call.args[0] : null;
}

function stepsFor(stmts, ctx) {
  const out = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s.kind === 'directive' && s.text !== 'use strict') continue;

    if (requiredModule(s)) {
      let j = i;
      while (j + 1 < stmts.length && requiredModule(stmts[j + 1]) && !(stmts[j + 1].comments || []).length) j++;
      if (j - i >= 1) {
        const run = stmts.slice(i, j + 1);
        const shown = run.slice(0, 6);
        const parts = t`Loads ${plural(run.length, 'module')} with ${code('require')}: `;
        shown.forEach((r, k) => {
          if (k > 0) parts.push(k === shown.length - 1 && run.length === shown.length ? ', and ' : ', ');
          parts.push(code(requiredModule(r)), ' as ', code(r.target));
        });
        if (run.length > shown.length) parts.push(`, and ${run.length - shown.length} more`);
        parts.push('.');
        out.push(step(parts, s));
        i = j;
        continue;
      }
    }

    // Runs of definitions or imports read better as one step.
    if ((s.kind === 'define' && s.what === 'function') || s.kind === 'import') {
      let j = i;
      while (j + 1 < stmts.length && stmts[j + 1].kind === s.kind && (s.kind !== 'define' || stmts[j + 1].what === 'function') && !(stmts[j + 1].comments || []).length) j++;
      if (j > i) {
        const run = stmts.slice(i, j + 1);
        const parts =
          s.kind === 'define'
            ? t`Defines the functions ${codeList(run.map((r) => r.name), { max: 6, refs: run.map((r) => r.unitIds[0]) })} (each explained below).`
            : t`Imports from ${plural(run.length, 'module')}: ${codeList(run.map((r) => r.source), { max: 6 })}.`;
        out.push(step(parts, s));
        i = j;
        continue;
      }
    }
    out.push(stepFor(s, ctx));
  }
  return out;
}

function stepFor(s, ctx) {
  switch (s.kind) {
    case 'if':
      return ifStep(s, ctx);
    case 'loop':
      return step(loopSentence(s), s, stepsFor(s.body, { ...ctx, breakable: 'loop' }));
    case 'switch':
      return switchStep(s, ctx);
    case 'try':
      return tryStep(s, ctx);
    default:
      return step(sentence(phrase(s, ctx)), s);
  }
}

function ifStep(s, ctx) {
  // Flatten else-if chains: [{ test, body }], plus a final else body (or null).
  const branches = [{ test: s.test, body: s.consequent }];
  let elseBody = s.alternate;
  while (elseBody && elseBody.length === 1 && elseBody[0].kind === 'if' && !(elseBody[0].comments || []).length) {
    branches.push({ test: elseBody[0].test, body: elseBody[0].consequent });
    elseBody = elseBody[0].alternate;
  }

  const parts = [];
  branches.forEach((b, i) => {
    parts.push(...(i === 0 ? t`If ${code(b.test)}, then ` : t`; otherwise, if ${code(b.test)}, then `));
    parts.push(...summarize(b.body, ctx));
  });
  if (elseBody && elseBody.length) parts.push('; otherwise ', ...summarize(elseBody, ctx));
  parts.push('.');

  const listed = branches.filter((b) => needsList(b.body)).length + (elseBody && needsList(elseBody) ? 1 : 0);
  const children = [];
  if (listed === 1 && branches.length === 1 && !(elseBody && elseBody.length)) {
    children.push(...stepsFor(s.consequent, ctx));
  } else if (listed) {
    branches.forEach((b, i) => {
      if (!needsList(b.body)) return;
      const label = i === 0 ? t`If ${code(b.test)}:` : t`Otherwise, if ${code(b.test)}:`;
      children.push(step(label, null, stepsFor(b.body, ctx), { group: true }));
    });
    if (elseBody && needsList(elseBody)) children.push(step(['Otherwise:'], null, stepsFor(elseBody, ctx), { group: true }));
  }
  return step(parts, s, children);
}

const ENDS_CASE = new Set(['break', 'return', 'throw', 'continue']);

function switchStep(s, ctx) {
  const hasDefault = s.cases.some((c) => c.test == null);
  const caseCount = s.cases.filter((c) => c.test != null).length;
  const parts = t`Checks the value of ${code(s.discriminant)} against ${plural(caseCount, 'case')}${hasDefault ? ', plus a default' : ''}:`;
  const children = [];
  const inner = { ...ctx, breakable: 'switch' };
  let tests = [];
  s.cases.forEach((c, i) => {
    tests.push(c.test);
    if (!c.body.length && i < s.cases.length - 1) return; // empty case falls into the next
    const values = tests.filter((x) => x != null);
    const isDefault = tests.includes(null);
    tests = [];
    let label = values.length ? t`When it is ${codeList(values, { conj: 'or', max: 5 })}` : ['Otherwise'];
    if (values.length && isDefault) label = [...label, ' (or anything else)'];

    const last = c.body[c.body.length - 1];
    const fallsThrough = i < s.cases.length - 1 && !(last && ENDS_CASE.has(last.kind));
    const body = last && last.kind === 'break' && !last.label ? c.body.slice(0, -1) : c.body;
    const caseStep = { comments: c.comments || [] };
    const fallNote = t`Then it continues into the next case, because there is no ${code('break')}.`;
    if (!needsList(body)) {
      const parts = sentence([...label, ', it ', ...summarize(body, inner)]);
      if (fallsThrough) parts.push(' ', ...fallNote);
      children.push(step(parts, caseStep));
    } else {
      const caseSteps = stepsFor(body, inner);
      if (fallsThrough) caseSteps.push(step(fallNote));
      children.push(step([...label, ':'], caseStep, caseSteps, { group: true }));
    }
  });
  return step(parts, s, children);
}

function tryStep(s, ctx) {
  const parts = s.handler
    ? t`Tries the steps below; if any of them throws an error${s.param ? t` (caught as ${code(s.param)})` : ''}, it ${summarize(s.handler, ctx)} instead.`
    : ['Tries the steps below.'];
  const children = [step(['Try:'], null, stepsFor(s.block, ctx), { group: true })];
  if (s.handler && needsList(s.handler)) {
    children.push(step(s.param ? t`If an error is caught (${code(s.param)}):` : ['If an error is caught:'], null, stepsFor(s.handler, ctx), { group: true }));
  }
  if (s.finalizer) {
    children.push(step(['Finally, whether or not there was an error:'], null, stepsFor(s.finalizer, ctx), { group: true }));
  }
  return step(parts, s, children);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function unitIntro(unit, callers) {
  const { kindLabel } = describeUnit(unit);
  let parts;
  switch (unit.kind) {
    case 'callback':
      parts = t`Defines ${article(unit.async ? 'async callback' : 'callback')}, passed to ${code(unit.callText || 'a call')}, that ${paramPhrase(unit.params)}.`;
      break;
    case 'iife':
      parts = ['Defines a function that runs immediately, as soon as it is created (an immediately-invoked function expression).'];
      break;
    case 'method': {
      const owner = unit.className;
      const objectName = !owner && unit.name.includes('.') ? unit.name.slice(0, unit.name.lastIndexOf('.')) : null;
      if (unit.methodKind === 'constructor') {
        parts = t`Defines the constructor of the class ${code(owner)}, which runs whenever a new ${code(owner)} is created with ${code('new')}. It ${paramPhrase(unit.params)}.`;
      } else if (unit.methodKind === 'get') {
        parts = t`Defines a getter ${code(unit.shortName)}${owner ? t` on the class ${code(owner)}` : ''}; its value is computed each time ${code(unit.shortName)} is read.`;
      } else if (unit.methodKind === 'set') {
        parts = t`Defines a setter ${code(unit.shortName)}${owner ? t` on the class ${code(owner)}` : ''}, which runs whenever ${code(unit.shortName)} is assigned. It ${paramPhrase(unit.params)}.`;
      } else if (unit.methodKind === 'static block') {
        parts = t`Defines a static initialization block for the class ${code(owner)}, which runs once when the class is set up.`;
      } else {
        const kind = unit.methodKind === 'static method' ? 'static method' : 'method';
        const where = owner ? t` on the class ${code(owner)}` : objectName ? t` on the object ${code(objectName)}` : '';
        parts = t`Defines ${article(unit.async ? `async ${kind}` : kind)} ${code(unit.shortName)}${where} that ${paramPhrase(unit.params)}.`;
      }
      break;
    }
    default: {
      const noun = kindLabel.replace(/^arrow function$/, 'function').replace(/ arrow function$/, ' function');
      parts = t`Defines ${article(noun)} ${code(unit.name)} that ${paramPhrase(unit.params)}.`;
    }
  }
  if (unit.parentName) parts.push(' It lives inside ', code(unit.parentName, unit.parentId), '.');
  const users = callers.get(unit.id);
  if (users && users.size) {
    const list = [...users].slice(0, 5);
    parts.push(' It is called by ');
    list.forEach((u, i) => {
      if (i > 0) parts.push(i === list.length - 1 ? (list.length > 2 ? ', and ' : ' and ') : ', ');
      parts.push(u.id === 'u0' ? link('the top-level code', 'u0') : code(u.name, u.id));
    });
    if (users.size > list.length) parts.push(` and ${users.size - list.length} more`);
    parts.push('.');
  }
  return parts;
}

function unitSteps(unit, ctx) {
  if (unit.expressionBody != null) return [step(t`Returns ${code(unit.expressionBody)}.`)];
  return stepsFor(unit.body, ctx);
}

function lineRange(a, b) {
  return a === b ? `line ${a}` : `lines ${a}–${b}`;
}

/** Map of unit id → set of { id, name } units that call it. */
function findCallers(outline) {
  const callers = new Map();
  const add = (calls, from) => {
    for (const c of calls || []) {
      if (!c.definedHere || c.definedHere === from.id) continue;
      if (!callers.has(c.definedHere)) callers.set(c.definedHere, new Map());
      const label = from.kind === 'program' ? 'top-level code' : describeUnit(from).title;
      callers.get(c.definedHere).set(from.id, { id: from.kind === 'program' ? 'u0' : from.id, name: label });
    }
  };
  for (const unit of [outline.program, ...outline.units]) {
    add(unit.expressionCalls, unit);
    walkStatements(unit.body, (s) => {
      add(s.calls, unit);
      add(s.testCalls, unit);
      add(s.iterableCalls, unit);
    });
  }
  return new Map([...callers].map(([k, v]) => [k, new Set(v.values())]));
}

function overview(outline, totals, hasTopLevel) {
  const paras = [];
  const fns = outline.units.filter((u) => u.kind === 'function');
  const methods = outline.units.filter((u) => u.kind === 'method');
  const callbacks = outline.units.filter((u) => u.kind === 'callback' || u.kind === 'iife');

  const pieces = [];
  if (fns.length) pieces.push(t`${plural(fns.length, 'function')} (${codeList(fns.map((u) => u.name), { max: 6, refs: fns.map((u) => u.id) })})`);
  if (outline.classes.length) {
    pieces.push(t`${plural(outline.classes.length, 'class', 'classes')} (${codeList(outline.classes.map((c) => c.name), { max: 4, refs: outline.classes.map((c) => `class:${c.name}`) })})${methods.length ? ` with ${plural(methods.length, 'method')} in total` : ''}`);
  } else if (methods.length) {
    pieces.push(plural(methods.length, 'method'));
  }
  if (callbacks.length) pieces.push(plural(callbacks.length, 'callback function'));

  const first = t`This file is ${plural(outline.lineCount, 'line')} long`;
  if (pieces.length) {
    first.push(' and defines ');
    pieces.forEach((p, i) => {
      if (i > 0) first.push(i === pieces.length - 1 ? (pieces.length > 2 ? ', and ' : ' and ') : ', ');
      first.push(...p);
    });
  }
  paras.push(sentence(first));

  const required = [];
  walkStatements(outline.program.body, (s) => {
    for (const c of s.calls || []) if (c.callee === 'require' && c.args[0]) required.push(c.args[0]);
  });
  if (outline.imports.length) {
    paras.push(sentence(t`It imports from ${codeList(outline.imports.map((i) => i.source), { max: 6 })}`));
  }
  if (required.length) {
    paras.push(sentence(t`It loads ${codeList([...new Set(required)], { max: 6 })} with ${code('require')}`));
  }
  if (outline.exports.length) {
    paras.push(sentence(t`It exports ${codeList(outline.exports, { max: 6 })}`));
  }
  if (hasTopLevel) {
    paras.push(sentence(t`When the file is loaded, the ${link('top-level code', 'u0')} runs straight away; functions only run when something calls them`));
  } else if (outline.units.length || outline.classes.length) {
    paras.push(['Nothing runs on its own when this file is loaded; it only defines things for other code to use.']);
  }
  const { total, branches, loops } = totals;
  paras.push(
    sentence(
      total
        ? t`Across the whole file there are ${plural(total, 'decision point')}: ${plural(branches, 'branch', 'branches')} and ${plural(loops, 'loop')}`
        : t`The file has no branches or loops, so it always runs the same way`,
    ),
  );
  return paras;
}

/**
 * Build the explanation for an outline.
 * @param {import('./outline.js').Outline} outline
 */
export function buildExplanation(outline) {
  const totalMetrics = addMetrics(newMetrics(), outline.program.metrics);
  for (const u of outline.units) addMetrics(totalMetrics, u.metrics);
  const complexity = complexityOf(totalMetrics);
  const hasTopLevel = outline.program.body.some((s) => !isDeclarationOnly(s));
  const callers = findCallers(outline);
  const ctx = { breakable: null };

  const sections = [];
  if (hasTopLevel || (!outline.units.length && outline.program.body.length)) {
    sections.push({
      id: 'u0',
      chartUnitId: 'u0',
      title: 'Top-level code',
      kindLabel: 'runs when the file loads',
      lines: lineRange(1, outline.lineCount),
      line: 0,
      comments: [],
      intro: ['When the file runs, it does the following, in order:'],
      steps: stepsFor(outline.program.body, ctx),
      complexity: complexityOf(outline.program.metrics),
    });
  }
  for (const c of outline.classes) {
    const methodNames = c.methods.map((m) => (m === 'constructor' ? 'constructor' : m));
    sections.push({
      id: `class:${c.name}`,
      chartUnitId: null,
      title: `class ${c.name}`,
      kindLabel: 'class',
      lines: lineRange(c.line, c.endLine),
      line: c.line,
      comments: c.comments,
      intro: sentence(
        t`Defines a class ${code(c.name)}${c.superClass ? t` that extends ${code(c.superClass)}` : ''}${
          methodNames.length ? t` with ${plural(methodNames.length, 'method')}: ${codeList(methodNames, { max: 8, refs: c.unitIds })}` : ' with no methods'
        }`,
      ),
      steps: [],
      complexity: null,
    });
  }
  for (const unit of outline.units) {
    const { title, kindLabel } = describeUnit(unit);
    sections.push({
      id: unit.id,
      chartUnitId: unit.id,
      title,
      kindLabel,
      lines: lineRange(unit.line, unit.endLine),
      line: unit.line,
      comments: unit.comments,
      intro: unitIntro(unit, callers),
      steps: unitSteps(unit, ctx),
      complexity: complexityOf(unit.metrics),
    });
  }
  sections.sort((a, b) => a.line - b.line);

  return {
    complexity,
    headerComments: outline.headerComments,
    overview: overview(outline, complexity, hasTopLevel),
    sections,
  };
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

function mdCode(text) {
  const ticks = text.includes('`') ? '``' : '`';
  const pad = ticks.length > 1 ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

export function partsToMarkdown(parts) {
  return parts.map((p) => (typeof p === 'string' ? p : p.code != null ? mdCode(p.code) : p.text)).join('');
}

function quote(text, indent = '') {
  return text
    .split('\n')
    .map((l) => `${indent}> ${l}`.trimEnd())
    .join('\n');
}

function stepsToMarkdown(steps, depth = 0) {
  const indent = '   '.repeat(depth);
  const lines = [];
  steps.forEach((s, i) => {
    const bullet = s.group ? '-' : `${i + 1}.`;
    for (const c of s.comments) lines.push(quote(c, indent));
    const text = s.group ? `**${partsToMarkdown(s.parts)}**` : partsToMarkdown(s.parts);
    lines.push(`${indent}${bullet} ${text}`);
    for (const c of s.trailing) lines.push(`${indent}   *(comment: ${c})*`);
    if (s.children.length) lines.push(stepsToMarkdown(s.children, depth + 1));
  });
  return lines.join('\n');
}

/** The whole explanation as Markdown. */
export function explanationToMarkdown(expl, title = 'Code explanation') {
  const out = [`# ${title}`, '', `*complexity: ${plural(expl.complexity.total, 'decision point')}*`, ''];
  for (const p of expl.overview) out.push(partsToMarkdown(p), '');
  for (const c of expl.headerComments) out.push(quote(c), '');
  for (const s of expl.sections) {
    const tag = s.complexity ? ` · complexity: ${s.complexity.total}` : '';
    out.push(`## ${mdCode(s.title)} — ${s.kindLabel} (${s.lines})${tag}`, '');
    for (const c of s.comments) out.push(quote(c), '');
    out.push(partsToMarkdown(s.intro), '');
    if (s.steps.length) out.push(stepsToMarkdown(s.steps), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
