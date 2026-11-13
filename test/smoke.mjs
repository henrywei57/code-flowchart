// Smoke test for the analysis pipeline (no browser needed): `npm test`.
// Parses every built-in example plus a few edge cases, builds flowcharts and
// explanations, and checks for the expected shapes and sentences.

import assert from 'node:assert/strict';
import { parseSource, CodeParseError } from '../js/parser.js';
import { buildFlowcharts, chartDefinition } from '../js/flowchart.js';
import { buildExplanation, explanationToMarkdown } from '../js/explanation.js';
import { EXAMPLES } from '../js/examples.js';

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`  ✓ ${name}`);
}

function run(code) {
  const outline = parseSource(code);
  const charts = buildFlowcharts(outline);
  const explanation = buildExplanation(outline);
  return { outline, charts, defs: charts.map((c) => chartDefinition(c)), md: explanationToMarkdown(explanation), explanation };
}

console.log('Examples');
for (const ex of EXAMPLES) {
  check(ex.label, () => {
    const { charts, defs, md } = run(ex.code);
    assert.ok(charts.length > 0);
    for (const d of defs) assert.match(d, /^flowchart TD\n/);
    assert.match(md, /complexity: \d+ decision point/);
  });
}

console.log('Shapes and templates');
check('function start, loop, decision, call, return', () => {
  const { defs, md } = run(EXAMPLES[0].code);
  const d = defs[0];
  assert.match(d, /\(\["function sumPositive\(numbers\)"\]\):::fcStart/);
  assert.match(d, /\{\{"for each n of numbers"\}\}:::fcLoop/);
  assert.match(d, /\{"n #gt; 0\?"\}:::fcDecision/);
  assert.match(d, /\[\["console\.log\(#quot;skipping#quot;, n\)"\]\]:::fcCall/);
  assert.match(d, /\(\["return total"\]\):::fcRet/);
  assert.match(d, /-->\|"Yes"\|/);
  assert.match(d, /-->\|"No"\|/);
  assert.match(md, /Defines a function `sumPositive` that takes `numbers` as input\./);
  assert.match(md, /Loops over `numbers`, repeating the block below for each item \(`n`\)\./);
  assert.match(md, /If `n > 0`, then adds `n` to `total`; otherwise logs `"skipping"` and `n` to the console\./);
  assert.match(md, /Returns `total`\./);
});

check('leading comments are kept verbatim', () => {
  const { outline } = run(EXAMPLES[0].code);
  assert.deepEqual(outline.units[0].comments, ['Adds up the positive numbers in a list.\nNegative numbers and zero are skipped.']);
});

check('complexity counts branches + loops', () => {
  const { explanation } = run(EXAMPLES[1].code);
  // tally: for + if + else-if = 3; describeDay: 3 cases; stepsToShrink: while = 1
  assert.equal(explanation.complexity.total, 7);
  assert.equal(explanation.complexity.loops, 2);
});

check('loop-back edges return to the loop node', () => {
  const { defs } = run('function f(n) { while (n > 0) { n--; } return n; }');
  const loopId = /(\w+)\{\{"n #gt; 0\?"\}\}/.exec(defs[0])[1];
  assert.match(defs[0], new RegExp(`--> ${loopId}\\b`));
});

check('try/catch, switch fall-through, unreachable code', () => {
  const { defs, md } = run(`function g(x) {
    try { risky(); } catch (e) { return null; }
    switch (x) { case 1: x++; case 2: return x; default: return 0; }
    cleanup();
  }`);
  assert.match(defs[0], /-\.->\|"on error"\|/);
  assert.match(defs[0], /:::fcDead/);
  assert.match(md, /continues into the next case/);
});

check('mermaid-sensitive characters are escaped', () => {
  const { defs } = run('function h(a) { if (a.x < 1 && b["#k"] > `t${a}`) { log("<b>"); } }');
  for (const line of defs[0].split('\n').filter((l) => l.includes('"'))) {
    const label = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
    assert.doesNotMatch(label, /["<>`]/, line);
  }
});

console.log('Errors');
check('syntax errors report line and column', () => {
  assert.throws(
    () => parseSource('function broken(a) {\n  if (a > 1 {\n    return a;\n  }\n}'),
    (err) => err instanceof CodeParseError && err.line === 2 && err.column === 13,
  );
});

check('JSX gets a helpful hint', () => {
  assert.throws(
    () => parseSource('const el = <div>hi</div>;'),
    (err) => err instanceof CodeParseError && /JSX/.test(err.hint),
  );
});

console.log(`\n${checks} checks passed`);
