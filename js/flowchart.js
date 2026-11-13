// Flowchart generation: turns an outline (js/outline.js) into Mermaid
// `flowchart TD` definitions, one per function-like unit.
//
// Shape mapping:
//   function start      ([stadium])          return / end   ([stadium])
//   if / switch         {diamond}            loop condition {{hexagon}}
//   function call       [[subroutine]]       other steps    [rectangle]

import { complexityOf, describeUnit, isDeclarationOnly } from './outline.js';

const MAX_NODES = 240; // per chart; larger units are cut off with a note
const WRAP_WIDTH = 34; // characters per label line
const MAX_LABEL = 96; // characters per statement before clipping
const MAX_GROUP = 5; // consecutive simple steps merged into one box

const SHAPES = {
  start: ['([', '])'],
  end: ['([', '])'],
  ret: ['([', '])'],
  throw: ['([', '])'],
  process: ['[', ']'],
  define: ['[', ']'],
  tryc: ['[', ']'],
  catch: ['[', ']'],
  call: ['[[', ']]'],
  decision: ['{', '}'],
  loop: ['{{', '}}'],
  junction: ['((', '))'],
};

export const PALETTES = {
  light: {
    start: 'fill:#dcfce7,stroke:#16a34a,color:#14532d',
    end: 'fill:#f1f5f9,stroke:#64748b,color:#334155',
    ret: 'fill:#ccfbf1,stroke:#0d9488,color:#134e4a',
    throw: 'fill:#fee2e2,stroke:#dc2626,color:#7f1d1d',
    process: 'fill:#ffffff,stroke:#94a3b8,color:#0f172a',
    define: 'fill:#f8fafc,stroke:#94a3b8,color:#475569,stroke-dasharray:4',
    call: 'fill:#ede9fe,stroke:#7c3aed,color:#3b0764',
    decision: 'fill:#fef3c7,stroke:#d97706,color:#78350f',
    loop: 'fill:#dbeafe,stroke:#2563eb,color:#1e3a8a',
    tryc: 'fill:#f1f5f9,stroke:#475569,color:#1e293b',
    catch: 'fill:#ffedd5,stroke:#ea580c,color:#7c2d12',
    junction: 'fill:#e2e8f0,stroke:#64748b,color:#334155',
    dead: 'fill:#f8fafc,stroke:#cbd5e1,color:#94a3b8,stroke-dasharray:4',
  },
  dark: {
    start: 'fill:#14532d,stroke:#4ade80,color:#dcfce7',
    end: 'fill:#1e293b,stroke:#94a3b8,color:#e2e8f0',
    ret: 'fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1',
    throw: 'fill:#7f1d1d,stroke:#f87171,color:#fee2e2',
    process: 'fill:#0f172a,stroke:#64748b,color:#e2e8f0',
    define: 'fill:#0f172a,stroke:#475569,color:#94a3b8,stroke-dasharray:4',
    call: 'fill:#2e1065,stroke:#a78bfa,color:#ede9fe',
    decision: 'fill:#451a03,stroke:#f59e0b,color:#fef3c7',
    loop: 'fill:#172554,stroke:#60a5fa,color:#dbeafe',
    tryc: 'fill:#1e293b,stroke:#94a3b8,color:#e2e8f0',
    catch: 'fill:#431407,stroke:#fb923c,color:#ffedd5',
    junction: 'fill:#334155,stroke:#94a3b8,color:#e2e8f0',
    dead: 'fill:#0f172a,stroke:#334155,color:#64748b,stroke-dasharray:4',
  },
};

/** Node kinds shown in the UI legend. */
export const LEGEND = [
  { cls: 'start', label: 'Start' },
  { cls: 'decision', label: 'Decision' },
  { cls: 'loop', label: 'Loop' },
  { cls: 'call', label: 'Call' },
  { cls: 'process', label: 'Step' },
  { cls: 'ret', label: 'Return' },
  { cls: 'throw', label: 'Throw' },
];

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

const ENTITIES = { '"': '#quot;', '#': '#35;', '<': '#lt;', '>': '#gt;', '&': '#amp;', '`': '#96;' };

/** Escape user text so Mermaid treats it as plain text inside a quoted label. */
export function escapeText(text) {
  return String(text).replace(/["#<>&`]/g, (ch) => ENTITIES[ch]);
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function wrapLine(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  // Hard-break words that are far too long for one line.
  return lines.flatMap((line) => {
    if (line.length <= width + 10) return [line];
    const parts = [];
    for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width));
    return parts;
  });
}

function labelFor(text) {
  const lines = wrapLine(clip(String(text).replace(/\s+/g, ' ').trim(), MAX_LABEL), WRAP_WIDTH);
  return lines.map(escapeText).join('<br>');
}

function labelForGroup(lines) {
  return lines.map((l) => escapeText(clip(l.replace(/\s+/g, ' ').trim(), 44))).join('<br>');
}

function edgeLabel(text) {
  return escapeText(clip(text, 32));
}

// ---------------------------------------------------------------------------
// Chart builder
// ---------------------------------------------------------------------------

/**
 * Builds one chart. Control flow is tracked as "dangling edges": every builder
 * method receives the edges that lead into it (`preds`) and returns the edges
 * that leave it, so branches, loops and early exits compose naturally.
 */
class ChartBuilder {
  constructor(unit) {
    this.unit = unit;
    this.prefix = `${unit.id}_`;
    this.lines = [];
    this.count = 0;
    this.truncated = false;
    this.breakables = [];
  }

  node(shapeCls, cls, text, group = null) {
    const id = this.prefix + this.count++;
    const [open, close] = SHAPES[shapeCls];
    const label = group ? labelForGroup(group) : labelFor(text);
    this.lines.push(`  ${id}${open}"${label}"${close}:::${className(cls)}`);
    return id;
  }

  link(preds, to) {
    for (const p of preds) {
      const arrow = p.dotted ? '-.->' : '-->';
      const label = p.label ? `|"${edgeLabel(p.label)}"|` : '';
      this.lines.push(`  ${p.from} ${arrow}${label} ${to}`);
    }
  }

  /** Add a node reached from `preds`. With no incoming edges it is unreachable. */
  place(preds, cls, text, group = null) {
    const id = this.node(cls, preds.length ? cls : 'dead', text, group);
    this.link(preds, id);
    return id;
  }

  seq(stmts, preds) {
    let group = [];
    let groupCls = null;
    const flush = () => {
      if (!group.length) return;
      const id = this.place(preds, groupCls, null, group);
      preds = [{ from: id }];
      group = [];
      groupCls = null;
    };

    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      if (this.count >= MAX_NODES) {
        flush();
        if (!this.truncated) {
          this.truncated = true;
          this.node('process', 'dead', '… more steps not shown (chart too large)');
        }
        return [];
      }
      if (s.kind === 'directive') continue;
      const simple = this.simple(s);
      if (simple) {
        const limit = simple.cls === 'define' ? MAX_GROUP + 3 : MAX_GROUP;
        if (group.length && (groupCls !== simple.cls || group.length >= limit)) flush();
        group.push(simple.text);
        groupCls = simple.cls;
        continue;
      }
      flush();
      preds = this.stmt(s, preds);
    }
    flush();
    return preds;
  }

  /** Statements without calls or control flow can share one box. */
  simple(s) {
    switch (s.kind) {
      case 'declare':
        if (isRequire(s)) return { cls: 'define', text: `${s.declKind} ${s.target} = ${s.value}` };
        if (s.calls.length) return null;
        return {
          cls: 'process',
          text: s.value != null ? `${s.declKind} ${s.target} = ${s.value}` : `${s.declKind} ${s.target}`,
        };
      case 'assign':
        return s.calls.length ? null : { cls: 'process', text: `${s.target} ${s.operator} ${s.value}` };
      case 'update':
        return { cls: 'process', text: `${s.target}${s.operator}` };
      case 'expression':
        return s.calls.length ? null : { cls: 'process', text: s.text };
      case 'other':
        return { cls: 'process', text: s.text };
      case 'define':
        return { cls: 'define', text: s.what === 'class' ? `define class ${s.name}` : `define ${s.name}()` };
      case 'import':
        return {
          cls: 'define',
          text: s.names.length ? `import ${s.names.join(', ')} from '${s.source}'` : `import '${s.source}'`,
        };
      case 'export':
        if (s.value) return s.calls && s.calls.length ? null : { cls: 'define', text: `export default ${s.value}` };
        return { cls: 'define', text: `export ${s.names.join(', ')}${s.source ? ` from '${s.source}'` : ''}` };
      default:
        return null;
    }
  }

  stmt(s, preds) {
    switch (s.kind) {
      case 'declare':
        return [{ from: this.place(preds, 'call', `${s.declKind} ${s.target} = ${s.value}`) }];
      case 'assign':
        return [{ from: this.place(preds, 'call', `${s.target} ${s.operator} ${s.value}`) }];
      case 'export':
        return [{ from: this.place(preds, 'call', `export default ${s.value}`) }];
      case 'call':
      case 'expression':
        return [{ from: this.place(preds, 'call', s.text) }];
      case 'if': {
        const id = this.place(preds, 'decision', question(s.test));
        const yes = this.seq(s.consequent, [{ from: id, label: 'Yes' }]);
        const no = s.alternate ? this.seq(s.alternate, [{ from: id, label: 'No' }]) : [{ from: id, label: 'No' }];
        return [...yes, ...no];
      }
      case 'loop':
        return this.loop(s, preds);
      case 'switch':
        return this.switchStmt(s, preds);
      case 'try':
        return this.tryStmt(s, preds);
      case 'return':
        this.place(preds, 'ret', s.value != null ? `return ${s.value}` : 'return');
        return [];
      case 'throw':
        this.place(preds, 'throw', `throw ${s.value}`);
        return [];
      case 'break': {
        const target = this.findTarget(s.label, false);
        if (target) target.breaks.push(...preds);
        return [];
      }
      case 'continue': {
        const target = this.findTarget(s.label, true);
        if (target) target.continues.push(...preds);
        return [];
      }
      default:
        return [{ from: this.place(preds, 'process', s.text || s.kind) }];
    }
  }

  findTarget(label, isContinue) {
    for (let i = this.breakables.length - 1; i >= 0; i--) {
      const b = this.breakables[i];
      if (label ? b.label === label : !isContinue || b.type === 'loop') return b;
    }
    return null;
  }

  loop(s, preds) {
    const ctx = { type: 'loop', label: s.label || null, breaks: [], continues: [] };
    this.breakables.push(ctx);
    let exits;
    const forever = !s.test || /^(true|1|!0)$/.test(s.test);
    switch (s.loopKind) {
      case 'for': {
        if (s.init) preds = [{ from: this.place(preds, 'process', s.init) }];
        const cond = this.place(preds, 'loop', forever ? 'repeat forever' : question(s.test));
        const back = [...this.seq(s.body, [{ from: cond, label: forever ? null : 'Yes' }]), ...ctx.continues];
        if (s.update && back.length) this.link([{ from: this.place(back, 'process', s.update) }], cond);
        else this.link(back, cond);
        exits = forever ? [] : [{ from: cond, label: 'No' }];
        break;
      }
      case 'while': {
        const cond = this.place(preds, 'loop', forever ? 'repeat forever' : question(s.test));
        const back = [...this.seq(s.body, [{ from: cond, label: forever ? null : 'Yes' }]), ...ctx.continues];
        this.link(back, cond);
        exits = forever ? [] : [{ from: cond, label: 'No' }];
        break;
      }
      case 'do-while': {
        const entry = this.place(preds, 'junction', 'do');
        const back = [...this.seq(s.body, [{ from: entry }]), ...ctx.continues];
        const cond = this.place(back, 'loop', forever ? 'repeat forever' : question(s.test));
        this.link([{ from: cond, label: forever ? null : 'Yes' }], entry);
        exits = forever ? [] : [{ from: cond, label: 'No' }];
        break;
      }
      default: {
        const each = s.awaited ? 'for await each' : 'for each';
        const text =
          s.loopKind === 'for-in'
            ? `${each} key ${s.variable} in ${s.iterable}`
            : `${each} ${s.variable} of ${s.iterable}`;
        const cond = this.place(preds, 'loop', text);
        this.link([...this.seq(s.body, [{ from: cond, label: 'next' }]), ...ctx.continues], cond);
        exits = [{ from: cond, label: 'done' }];
      }
    }
    this.breakables.pop();
    return [...exits, ...ctx.breaks];
  }

  switchStmt(s, preds) {
    const sw = this.place(preds, 'decision', `switch ${s.discriminant}`);
    const ctx = { type: 'switch', label: null, breaks: [], continues: [] };
    this.breakables.push(ctx);
    let fall = [];
    let labels = [];
    let hasDefault = false;
    s.cases.forEach((c, i) => {
      if (c.test == null) hasDefault = true;
      labels.push(c.test == null ? 'default' : `case ${c.test}`);
      if (!c.body.length && i < s.cases.length - 1) return; // empty case falls into the next
      fall = this.seq(c.body, [{ from: sw, label: labels.join(', ') }, ...fall]);
      labels = [];
    });
    this.breakables.pop();
    const exits = [...fall, ...ctx.breaks];
    if (!hasDefault) exits.push({ from: sw, label: 'no match' });
    return exits;
  }

  tryStmt(s, preds) {
    const t = this.place(preds, 'tryc', 'try');
    let exits = this.seq(s.block, [{ from: t }]);
    if (s.handler) {
      const c = this.place([{ from: t, label: 'on error', dotted: true }], 'catch', s.param ? `catch (${s.param})` : 'catch');
      exits = [...exits, ...this.seq(s.handler, [{ from: c }])];
    }
    if (s.finalizer) {
      const f = this.place(exits.length ? exits : [{ from: t, label: 'always', dotted: true }], 'tryc', 'finally');
      exits = this.seq(s.finalizer, [{ from: f }]);
    }
    return exits;
  }
}

/** `const x = require('x')` and similar module loads. */
function isRequire(s) {
  return (
    s.calls.length >= 1 &&
    s.calls[0].callee === 'require' &&
    s.value.replace(/^await\s+/, '') === s.calls[0].text
  );
}

function question(test) {
  return /\?$/.test(test) ? test : `${test}?`;
}

function startLabel(unit) {
  if (unit.kind === 'program') return 'Start';
  if (unit.kind === 'iife') return 'immediately-invoked function';
  const params = `(${unit.params.join(', ')})`;
  if (unit.kind === 'callback') return `${unit.async ? 'async ' : ''}callback ${params}`;
  if (unit.kind === 'method') {
    if (unit.methodKind === 'constructor') return `${unit.className} constructor${params}`;
    const prefix = unit.methodKind === 'get' ? 'get ' : unit.methodKind === 'set' ? 'set ' : '';
    return `${unit.async ? 'async ' : ''}${prefix}${unit.name}${params}`;
  }
  return `${unit.async ? 'async ' : ''}function ${unit.name}${params}`;
}

function buildUnitChart(unit) {
  const b = new ChartBuilder(unit);
  const start = b.node('start', 'start', startLabel(unit));
  let exits;
  if (unit.expressionBody != null) {
    b.place([{ from: start }], 'ret', `return ${unit.expressionBody}`);
    exits = [];
  } else {
    exits = b.seq(unit.body, [{ from: start }]);
  }
  if (exits.length && !b.truncated) b.place(exits, 'end', unit.kind === 'program' ? 'End' : 'end');
  const { title, kindLabel } = describeUnit(unit);
  return {
    unitId: unit.id,
    title,
    kindLabel,
    line: unit.line,
    endLine: unit.endLine,
    body: b.lines,
    nodeCount: b.count,
    truncated: b.truncated,
    complexity: complexityOf(unit.metrics),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True when the top level does more than declare functions/classes/imports. */
export function hasTopLevelCode(outline) {
  return outline.program.body.some((s) => !isDeclarationOnly(s));
}

/**
 * Build one chart per unit (plus top-level code when the file has any).
 * @param {import('./outline.js').Outline} outline
 */
export function buildFlowcharts(outline) {
  const charts = [];
  if (hasTopLevelCode(outline) || !outline.units.length) charts.push(buildUnitChart(outline.program));
  for (const unit of outline.units) charts.push(buildUnitChart(unit));
  return charts;
}

// Mermaid reserves words like `call` and `end`, so node classes get a prefix.
function className(cls) {
  return `fc${cls[0].toUpperCase()}${cls.slice(1)}`;
}

function classDefs(palette) {
  return Object.entries(palette).map(([cls, style]) => `  classDef ${className(cls)} ${style}`);
}

/** Mermaid definition for a single chart. */
export function chartDefinition(chart, palette = PALETTES.light) {
  return ['flowchart TD', ...chart.body, ...classDefs(palette)].join('\n');
}

/** One Mermaid definition containing every chart as a subgraph. */
export function combinedDefinition(charts, palette = PALETTES.light) {
  const lines = ['flowchart TD'];
  for (const c of charts) {
    lines.push(`  subgraph ${c.unitId}["${escapeText(clip(c.title, 60))}"]`, '    direction TB');
    lines.push(...c.body.map((l) => '  ' + l));
    lines.push('  end');
  }
  lines.push(...classDefs(palette));
  return lines.join('\n');
}
