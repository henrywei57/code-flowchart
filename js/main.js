// UI wiring: connects the input panel to the parse → flowchart → explanation
// pipeline and renders the results. No analysis logic lives here.

import { parseSource, CodeParseError, languageForPath, supportedExtensions } from './parser.js';
import { GitHubError, fetchFileText, fileUrl, isLikelyGenerated, listRepoFiles, parseRepoInput, rateLimit } from './github.js';
import { buildFlowcharts, chartDefinition, combinedDefinition, PALETTES, LEGEND } from './flowchart.js';
import { buildExplanation, explanationToMarkdown } from './explanation.js';
import { EXAMPLES } from './examples.js';

const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs';
const DRAFT_KEY = 'code-flowchart:draft';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

const $ = (id) => document.getElementById(id);

const els = {
  tabs: [$('tab-paste'), $('tab-github')],
  panels: { paste: $('panel-paste'), github: $('panel-github') },
  code: $('code-input'),
  dropZone: $('drop-zone'),
  exampleSelect: $('example-select'),
  fileUpload: $('file-upload'),
  uploadBtn: $('upload-btn'),
  generate: $('generate-btn'),
  message: $('message'),
  analyzedLabel: $('analyzed-label'),
  unitSelect: $('unit-select'),
  zoomIn: $('zoom-in'),
  zoomOut: $('zoom-out'),
  zoomFit: $('zoom-fit'),
  copyMermaid: $('copy-mermaid'),
  legend: $('legend'),
  charts: $('charts'),
  explanation: $('explanation'),
  complexityTag: $('complexity-tag'),
  copyMarkdown: $('copy-markdown'),
  toast: $('toast'),
  repoForm: $('repo-form'),
  repoInput: $('repo-input'),
  repoLoad: $('repo-load'),
  repoStatus: $('repo-status'),
  filePicker: $('file-picker'),
  repoName: $('repo-name'),
  fileCount: $('file-count'),
  fileFilter: $('file-filter'),
  hideGenerated: $('hide-generated'),
  fileList: $('file-list'),
  fileMeta: $('file-meta'),
  rateLimit: $('rate-limit'),
};

const state = {
  mode: 'paste',
  outline: null,
  explanation: null,
  label: '',
  charts: [],
  view: 'all',
  zoom: 'fit',
  renderToken: 0,
  repo: null, // { owner, repo, ref, files, truncated }
  selectedPath: null,
  busy: false,
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 1800);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${what} copied`);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode, blocked) — drafts just aren't kept */
  }
}

// ---------------------------------------------------------------------------
// Theme + Mermaid
// ---------------------------------------------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function currentTheme() {
  return document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
}

let mermaidPromise = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import(MERMAID_URL)
      .then((mod) => {
        configureMermaid(mod.default);
        return mod.default;
      })
      .catch((err) => {
        mermaidPromise = null;
        throw new Error(`Could not load the Mermaid library from the CDN (${err.message}). Check your connection.`);
      });
  }
  return mermaidPromise;
}

function configureMermaid(mermaid) {
  const dark = currentTheme() === 'dark';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    maxTextSize: 500000,
    maxEdges: 5000,
    fontFamily: getComputedStyle(document.body).fontFamily,
    themeVariables: {
      darkMode: dark,
      fontSize: '13px',
      background: dark ? '#141920' : '#ffffff',
      lineColor: dark ? '#7d8796' : '#7a8394',
      textColor: dark ? '#e7eaef' : '#13161b',
      primaryColor: dark ? '#1a2029' : '#f0f2f5',
      primaryTextColor: dark ? '#e7eaef' : '#13161b',
      primaryBorderColor: dark ? '#4b5563' : '#94a3b8',
      edgeLabelBackground: dark ? '#141920' : '#ffffff',
      clusterBkg: dark ? '#141920' : '#fafbfc',
      clusterBorder: dark ? '#343d4b' : '#cdd2da',
    },
    flowchart: {
      htmlLabels: true,
      curve: 'basis',
      useMaxWidth: false,
      nodeSpacing: 34,
      rankSpacing: 42,
      padding: 10,
    },
  });
}

// mermaid.render is not safe to run concurrently, so renders are queued.
let renderChain = Promise.resolve();
let renderCounter = 0;

function renderDiagram(definition) {
  const job = renderChain.then(async () => {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`mmd-${++renderCounter}`, definition);
    return svg;
  });
  renderChain = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline on some source code and render the results.
 * @returns {boolean} whether parsing succeeded
 */
function analyze(source, { label, language = 'javascript' } = {}) {
  hideMessage();
  let outline;
  try {
    outline = parseSource(source, { language });
  } catch (err) {
    if (err instanceof CodeParseError) {
      showParseError(err, source);
      setStale(true);
      return false;
    }
    throw err;
  }
  setStale(false);
  state.outline = outline;
  state.label = label || '';
  state.charts = buildFlowcharts(outline);
  state.explanation = buildExplanation(outline);
  state.view = 'all';
  els.analyzedLabel.textContent = label ? `· ${label}` : '';
  populateUnitSelect();
  renderCharts();
  renderExplanation();
  return true;
}

function showParseError(err, source) {
  const box = els.message;
  box.className = 'message error';
  box.replaceChildren();
  const where = err.line ? ` (line ${err.line}${err.column ? `, column ${err.column}` : ''})` : '';
  const title = el('p');
  title.append(el('strong', null, "Couldn't parse this code"), `${where}: ${err.message}.`);
  box.append(title);
  if (err.hint) box.append(el('p', null, err.hint));
  if (err.line) {
    const lineText = source.split('\n')[err.line - 1] ?? '';
    const caret = err.column ? ' '.repeat(Math.max(0, err.column - 1)) + '^' : '';
    box.append(el('pre', null, `${String(err.line).padStart(4)} | ${lineText}\n${caret ? '     | ' + caret : ''}`));
  }
  box.hidden = false;

  if (state.mode === 'paste' && err.line) {
    const lines = els.code.value.split('\n');
    let offset = 0;
    for (let i = 0; i < err.line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    offset += Math.max(0, (err.column || 1) - 1);
    els.code.focus();
    els.code.setSelectionRange(offset, Math.min(offset + 1, els.code.value.length));
  }
}

/** Dim old results while the latest input failed to parse. */
function setStale(stale) {
  for (const id of ['flow-card', 'explain-card']) $(id).classList.toggle('stale', stale && !!state.outline);
}

function showMessage(kind, parts) {
  els.message.className = `message ${kind}`;
  els.message.replaceChildren(...parts);
  els.message.hidden = false;
}

function hideMessage() {
  els.message.hidden = true;
  els.message.replaceChildren();
}

// ---------------------------------------------------------------------------
// Flowchart rendering
// ---------------------------------------------------------------------------

function renderLegend() {
  els.legend.replaceChildren(
    ...LEGEND.map(({ cls, label }) => {
      const li = el('li');
      li.append(el('span', `swatch ${cls}`), label);
      return li;
    }),
  );
}

function populateUnitSelect() {
  const sel = els.unitSelect;
  sel.replaceChildren();
  const all = el('option', null, `All charts (${state.charts.length})`);
  all.value = 'all';
  sel.append(all);
  for (const c of state.charts) {
    const opt = el('option', null, `${c.title} — ${c.kindLabel}`);
    opt.value = c.unitId;
    sel.append(opt);
  }
  sel.value = state.view;
  sel.disabled = state.charts.length < 2;
}

let chartObserver = null;

function visibleCharts() {
  return state.view === 'all' ? state.charts : state.charts.filter((c) => c.unitId === state.view);
}

function renderCharts() {
  const token = ++state.renderToken;
  if (chartObserver) chartObserver.disconnect();
  els.charts.replaceChildren();

  const charts = visibleCharts();
  if (!charts.length) {
    els.charts.append(el('p', 'empty', 'Nothing to chart in this file.'));
    return;
  }

  // The first few charts draw right away; the rest wait until scrolled near.
  const EAGER = 3;
  chartObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        chartObserver.unobserve(entry.target);
        const chart = state.charts.find((c) => c.unitId === entry.target.dataset.unit);
        if (chart) drawChart(entry.target, chart, token);
      }
    },
    { rootMargin: '800px 0px' },
  );

  for (const chart of charts) {
    const card = el('section', 'chart');
    card.id = `chart-${chart.unitId}`;

    const head = el('header', 'chart-head');
    head.append(el('span', 'chart-title', chart.title), el('span', 'tag quiet', chart.kindLabel));
    if (chart.unitId !== 'u0' || chart.complexity.total) {
      const tag = el('span', 'tag', `complexity: ${chart.complexity.total}`);
      tag.title = complexityText(chart.complexity.total);
      head.append(tag);
    }
    const meta = el('span', 'chart-meta');
    meta.append(el('span', 'muted', chart.line === chart.endLine ? `line ${chart.line}` : `lines ${chart.line}–${chart.endLine}`));
    head.append(meta);
    const explainLink = el('a', null, 'Explanation ↓');
    explainLink.href = `#${sectionDomId(chart.unitId)}`;
    explainLink.addEventListener('click', (e) => {
      e.preventDefault();
      scrollToSection(chart.unitId);
    });
    meta.append(explainLink);
    const svgBtn = el('button', 'button ghost small', 'SVG');
    svgBtn.type = 'button';
    svgBtn.title = 'Download this chart as an SVG file';
    svgBtn.addEventListener('click', () => downloadSvg(card, chart));
    meta.append(svgBtn);
    card.append(head);

    const canvas = el('div', 'chart-canvas');
    canvas.dataset.unit = chart.unitId;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Flowchart of ${chart.title}`);
    canvas.append(el('p', 'chart-loading', 'Waiting to draw…'));
    enablePan(canvas);
    card.append(canvas);
    if (chart.truncated) {
      card.append(el('p', 'chart-note', 'This function is very long, so the chart stops partway. The explanation below covers all of it.'));
    }
    els.charts.append(card);
    if (els.charts.children.length <= EAGER) drawChart(canvas, chart, token);
    else chartObserver.observe(canvas);
  }
  updateZoomButtons();
}

async function drawChart(canvas, chart, token) {
  const loading = el('p', 'chart-loading');
  loading.append(el('span', 'spinner'), 'Drawing…');
  canvas.replaceChildren(loading);
  try {
    const svg = await renderDiagram(chartDefinition(chart, PALETTES[currentTheme()]));
    if (token !== state.renderToken) return;
    canvas.innerHTML = svg;
    applyZoom(canvas);
  } catch (err) {
    if (token !== state.renderToken) return;
    const msg = el('p', 'chart-error', `Couldn't draw this chart: ${err.message || err}`);
    canvas.replaceChildren(msg);
  }
}

// ----- zoom & pan ----------------------------------------------------------

function naturalWidth(svg) {
  const vb = svg.viewBox && svg.viewBox.baseVal;
  return vb && vb.width ? vb.width : svg.getBoundingClientRect().width;
}

function applyZoom(canvas) {
  const svg = canvas.querySelector('svg');
  if (!svg) return;
  const width = naturalWidth(svg);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.maxWidth = '';
  if (state.zoom === 'fit') {
    canvas.classList.add('fit');
    svg.style.width = `${width}px`;
  } else {
    canvas.classList.remove('fit');
    svg.style.width = `${width * state.zoom}px`;
    svg.style.maxWidth = 'none';
  }
}

function currentScale() {
  if (state.zoom !== 'fit') return state.zoom;
  const svg = els.charts.querySelector('.chart-canvas svg');
  if (!svg) return 1;
  return svg.getBoundingClientRect().width / naturalWidth(svg) || 1;
}

function setZoom(zoom) {
  state.zoom = zoom;
  els.charts.querySelectorAll('.chart-canvas').forEach(applyZoom);
  updateZoomButtons();
}

function stepZoom(direction) {
  const scale = currentScale();
  const next =
    direction > 0
      ? ZOOM_STEPS.find((z) => z > scale + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
      : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.01) ?? ZOOM_STEPS[0];
  setZoom(next);
}

function updateZoomButtons() {
  els.zoomFit.setAttribute('aria-pressed', String(state.zoom === 'fit'));
  els.zoomFit.textContent = state.zoom === 'fit' ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
  els.zoomFit.title = state.zoom === 'fit' ? 'Fitting charts to the width' : 'Fit charts to the width';
}

function enablePan(canvas) {
  let start = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (canvas.classList.contains('fit') || e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('panning');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!start) return;
    canvas.scrollLeft = start.left - (e.clientX - start.x);
    canvas.scrollTop = start.top - (e.clientY - start.y);
  });
  const end = () => {
    start = null;
    canvas.classList.remove('panning');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function downloadSvg(card, chart) {
  const svg = card.querySelector('.chart-canvas svg');
  if (!svg) {
    toast('Chart is still drawing');
    return;
  }
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.maxWidth = '';
  clone.setAttribute('width', String(naturalWidth(svg)));
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = `${chart.title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'flowchart'}.svg`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Explanation rendering
// ---------------------------------------------------------------------------

function sectionDomId(ref) {
  return `explain-${String(ref).replace(/[^\w-]+/g, '-')}`;
}

function scrollToSection(ref) {
  const target = document.getElementById(sectionDomId(ref));
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
}

function showChart(unitId) {
  if (!state.charts.some((c) => c.unitId === unitId)) return;
  state.view = unitId;
  els.unitSelect.value = unitId;
  renderCharts();
  $('flow-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refLink(ref) {
  const a = el('a');
  a.href = `#${sectionDomId(ref)}`;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    scrollToSection(ref);
  });
  return a;
}

function renderParts(parts, container) {
  for (const p of parts) {
    if (typeof p === 'string') {
      container.append(p);
    } else if (p.code != null) {
      const c = el('code', null, p.code);
      if (p.ref) {
        const a = refLink(p.ref);
        a.append(c);
        container.append(a);
      } else {
        container.append(c);
      }
    } else if (p.ref) {
      const a = refLink(p.ref);
      a.textContent = p.text;
      container.append(a);
    }
  }
  return container;
}

function commentBlock(text, label) {
  const block = el('div', 'comment-block');
  if (label) block.append(el('span', 'comment-label', label));
  block.append(text);
  return block;
}

function renderSteps(steps) {
  const ol = el('ol', 'steps');
  for (const s of steps) {
    const li = el('li', s.group ? 'group' : null);
    for (const c of s.comments) li.append(commentBlock(c, 'Comment in code'));
    const line = el('div', s.group ? 'group-label' : 'step-text');
    renderParts(s.parts, line);
    li.append(line);
    for (const c of s.trailing) li.append(commentBlock(c, 'Comment in code'));
    if (s.children.length) li.append(renderSteps(s.children));
    ol.append(li);
  }
  return ol;
}

function complexityText(n) {
  return `complexity: ${n} decision ${n === 1 ? 'point' : 'points'}`;
}

function renderExplanation() {
  const expl = state.explanation;
  const root = els.explanation;
  root.replaceChildren();
  if (!expl) return;

  els.complexityTag.textContent = complexityText(expl.complexity.total);
  els.complexityTag.title = `${expl.complexity.branches} branches (if / else-if, switch cases, ternaries) + ${expl.complexity.loops} loops`;
  els.complexityTag.hidden = false;

  const overview = el('div', 'overview');
  for (const p of expl.overview) overview.append(renderParts(p, el('p')));
  root.append(overview);

  for (const text of expl.headerComments) {
    if (text.split('\n').length > 8) {
      const details = el('details', 'header-comment');
      details.append(el('summary', null, 'File header comment'), commentBlock(text));
      root.append(details);
    } else {
      root.append(commentBlock(text, 'File header comment'));
    }
  }

  for (const section of expl.sections) {
    const sec = el('section', 'section');
    sec.id = sectionDomId(section.id);
    const head = el('div', 'section-head');
    head.append(el('h3', null, section.title), el('span', 'tag quiet', section.kindLabel));
    if (section.complexity) head.append(el('span', 'tag', complexityText(section.complexity.total)));
    head.append(el('span', 'lines', section.lines), el('span', 'spacer'));
    if (section.chartUnitId && state.charts.some((c) => c.unitId === section.chartUnitId)) {
      const view = el('a', null, 'View chart ↑');
      view.href = `#chart-${section.chartUnitId}`;
      view.addEventListener('click', (e) => {
        e.preventDefault();
        showChart(section.chartUnitId);
      });
      head.append(view);
    }
    sec.append(head);
    for (const c of section.comments) sec.append(commentBlock(c, 'Comment in code'));
    sec.append(renderParts(section.intro, el('p', 'intro')));
    if (section.steps.length) sec.append(renderSteps(section.steps));
    root.append(sec);
  }
}

// ---------------------------------------------------------------------------
// Input: tabs, paste mode
// ---------------------------------------------------------------------------

function selectTab(mode, { focus = false } = {}) {
  state.mode = mode;
  for (const tab of els.tabs) {
    const selected = tab.id === `tab-${mode}`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  els.panels.paste.hidden = mode !== 'paste';
  els.panels.github.hidden = mode !== 'github';
  updateRateLimitLabel();
  updateGenerateButton();
}

function setupTabs() {
  els.tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = els.tabs[(i + (e.key === 'ArrowRight' ? 1 : els.tabs.length - 1)) % els.tabs.length];
      selectTab(next.id.replace('tab-', ''), { focus: true });
    });
  });
}

function setupPasteMode() {
  for (const ex of EXAMPLES) {
    const opt = el('option', null, ex.label);
    opt.value = ex.id;
    els.exampleSelect.append(opt);
  }
  els.exampleSelect.addEventListener('change', () => {
    const ex = EXAMPLES.find((x) => x.id === els.exampleSelect.value);
    els.exampleSelect.value = '';
    if (!ex) return;
    els.code.value = ex.code;
    storageSet(DRAFT_KEY, ex.code);
    analyze(ex.code, { label: `example: ${ex.label}` });
  });

  let draftTimer;
  els.code.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => storageSet(DRAFT_KEY, els.code.value), 400);
  });

  els.uploadBtn.addEventListener('click', () => els.fileUpload.click());
  els.fileUpload.addEventListener('change', () => {
    const file = els.fileUpload.files && els.fileUpload.files[0];
    if (file) loadLocalFile(file);
    els.fileUpload.value = '';
  });

  const zone = els.dropZone;
  zone.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragging');
  });
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('dragging');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    loadLocalFile(file);
  });
}

const MAX_FILE_BYTES = 1_000_000;

async function loadLocalFile(file) {
  if (!/\.(m|c)?js$/i.test(file.name)) {
    showMessage('warn', [el('p', null, `“${file.name}” isn't a .js file. Only JavaScript is supported for now.`)]);
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showMessage('warn', [el('p', null, `“${file.name}” is ${Math.round(file.size / 1024)} KB, which is too large to chart. Try a file under 1 MB.`)]);
    return;
  }
  const text = await file.text();
  els.code.value = text;
  storageSet(DRAFT_KEY, text);
  selectTab('paste');
  analyze(text, { label: file.name });
}

// ---------------------------------------------------------------------------
// Input: GitHub mode
// ---------------------------------------------------------------------------

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function setRepoStatus(kind, ...parts) {
  const box = els.repoStatus;
  box.className = `status${kind ? ' ' + kind : ''}`;
  box.replaceChildren();
  if (!parts.length) return;
  if (kind === 'loading') box.append(el('span', 'spinner'));
  const body = el('div');
  body.append(...parts);
  box.append(body);
}

function setBusy(busy) {
  state.busy = busy;
  els.repoLoad.disabled = busy;
  els.repoInput.disabled = busy;
  updateGenerateButton();
}

function updateGenerateButton() {
  els.generate.disabled = state.busy;
  els.generate.textContent = state.mode === 'github' && !state.repo ? 'Load files' : 'Generate';
}

function updateRateLimitLabel() {
  if (state.mode !== 'github' || rateLimit.remaining == null) {
    els.rateLimit.textContent = '';
    return;
  }
  els.rateLimit.textContent = `GitHub API: ${rateLimit.remaining} of ${rateLimit.limit} requests left this hour`;
}

function errorText(err) {
  return err instanceof GitHubError ? err.message : `Something went wrong: ${err.message || err}`;
}

/** Load a repository's file list. Optionally pre-select (and analyze) a file. */
async function loadRepo(input, { selectPath = null, autoAnalyze = false } = {}) {
  let target;
  try {
    target = parseRepoInput(input);
  } catch (err) {
    setRepoStatus('error', errorText(err));
    els.repoInput.focus();
    return;
  }
  selectPath = selectPath || target.path;

  state.repo = null;
  state.selectedPath = null;
  els.filePicker.hidden = true;
  setBusy(true);
  const name = `${target.owner}/${target.repo}`;
  setRepoStatus('loading', `Loading the file list for `, el('strong', null, name), '…');
  try {
    const result = await listRepoFiles(target, { extensions: supportedExtensions() });
    state.repo = result;
    els.repoName.textContent = `${result.owner}/${result.repo}${result.ref !== 'HEAD' ? ` @ ${result.ref}` : ''}`;
    els.repoName.title = els.repoName.textContent;

    if (!result.files.length) {
      setRepoStatus('warn', 'No JavaScript (.js) files were found in ', el('strong', null, name), '.');
    } else if (result.truncated) {
      setRepoStatus('warn', 'This repository is very large, so GitHub only returned part of its file list. Some files may be missing.');
    } else {
      setRepoStatus('');
    }

    if (selectPath && result.files.some((f) => f.path === selectPath)) {
      state.selectedPath = selectPath;
      if (isLikelyGenerated(selectPath)) els.hideGenerated.checked = false;
    } else if (selectPath) {
      setRepoStatus('warn', `“${selectPath}” isn't a JavaScript file in this repository. Pick one from the list.`);
    }
    els.fileFilter.value = '';
    els.filePicker.hidden = !result.files.length;
    renderFileList();
    if (state.selectedPath && autoAnalyze) await analyzeSelectedFile();
    else if (result.files.length && !state.selectedPath) els.fileFilter.focus();
  } catch (err) {
    setRepoStatus('error', errorText(err));
  } finally {
    setBusy(false);
    updateRateLimitLabel();
  }
}

function filteredFiles() {
  if (!state.repo) return [];
  const terms = els.fileFilter.value.toLowerCase().split(/\s+/).filter(Boolean);
  const hide = els.hideGenerated.checked;
  return state.repo.files.filter((f) => {
    if (hide && isLikelyGenerated(f.path) && f.path !== state.selectedPath) return false;
    const lower = f.path.toLowerCase();
    return terms.every((term) => lower.includes(term));
  });
}

function renderFileList() {
  if (!state.repo) return;
  const files = filteredFiles();
  const list = els.fileList;
  list.replaceChildren();
  for (const f of files) {
    const opt = el('option', null, f.size != null ? `${f.path}  (${formatSize(f.size)})` : f.path);
    opt.value = f.path;
    list.append(opt);
  }
  const total = state.repo.files.length;
  els.fileCount.textContent =
    files.length === total ? `${total} JavaScript ${total === 1 ? 'file' : 'files'}` : `${files.length} of ${total} files`;
  if (state.selectedPath && files.some((f) => f.path === state.selectedPath)) {
    list.value = state.selectedPath;
  }
  if (!files.length) {
    const opt = el('option', null, total ? 'No files match the filter' : 'No JavaScript files');
    opt.disabled = true;
    list.append(opt);
  }
  renderFileMeta();
}

function renderFileMeta() {
  const meta = els.fileMeta;
  meta.replaceChildren();
  const file = state.repo && state.repo.files.find((f) => f.path === state.selectedPath);
  if (!file) {
    meta.textContent = 'Pick a file, then press Generate (or double-click it).';
    return;
  }
  const a = el('a', null, 'View on GitHub');
  a.href = fileUrl(state.repo, file.path);
  a.target = '_blank';
  a.rel = 'noopener';
  meta.append(`${file.path.split('/').pop()}${file.size != null ? ` · ${formatSize(file.size)}` : ''} · `, a);
}

async function analyzeSelectedFile() {
  const repo = state.repo;
  const file = repo && repo.files.find((f) => f.path === state.selectedPath);
  if (!file) {
    setRepoStatus('warn', 'Pick a file from the list first.');
    els.fileList.focus();
    return;
  }
  if (file.size != null && file.size > MAX_FILE_BYTES) {
    setRepoStatus('error', `“${file.path}” is ${formatSize(file.size)}, which is too large to chart. Try a file under 1 MB.`);
    return;
  }
  setBusy(true);
  setRepoStatus('loading', 'Downloading ', el('strong', null, file.path), '…');
  try {
    const text = await fetchFileText(repo, file);
    setRepoStatus('');
    const ok = analyze(text, {
      label: `${repo.owner}/${repo.repo}/${file.path}`,
      language: languageForPath(file.path) || 'javascript',
    });
    if (ok) {
      writeHash({ repo: `${repo.owner}/${repo.repo}`, ref: repo.ref !== 'HEAD' ? repo.ref : null, file: file.path });
    }
  } catch (err) {
    setRepoStatus('error', errorText(err));
  } finally {
    setBusy(false);
    updateRateLimitLabel();
  }
}

function setupGitHubMode() {
  els.repoForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.busy) loadRepo(els.repoInput.value);
  });
  els.fileFilter.addEventListener('input', renderFileList);
  els.fileFilter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && els.fileList.options.length) {
      e.preventDefault();
      els.fileList.focus();
      if (!els.fileList.value && !els.fileList.options[0].disabled) {
        els.fileList.selectedIndex = 0;
        state.selectedPath = els.fileList.value;
        renderFileMeta();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const files = filteredFiles();
      if (files.length === 1) {
        state.selectedPath = files[0].path;
        renderFileList();
        analyzeSelectedFile();
      }
    }
  });
  els.hideGenerated.addEventListener('change', renderFileList);
  els.fileList.addEventListener('change', () => {
    state.selectedPath = els.fileList.value || null;
    renderFileMeta();
  });
  els.fileList.addEventListener('dblclick', () => {
    if (els.fileList.value && !state.busy) {
      state.selectedPath = els.fileList.value;
      analyzeSelectedFile();
    }
  });
  els.fileList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && els.fileList.value && !state.busy) {
      e.preventDefault();
      state.selectedPath = els.fileList.value;
      analyzeSelectedFile();
    }
  });
}

// ----- shareable links: #repo=owner/name&ref=branch&file=path ---------------

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const repo = params.get('repo');
  return repo ? { repo, ref: params.get('ref'), file: params.get('file') } : null;
}

function writeHash(info) {
  const params = new URLSearchParams();
  if (info) {
    params.set('repo', info.repo);
    if (info.ref) params.set('ref', info.ref);
    if (info.file) params.set('file', info.file);
  }
  const hash = info ? `#${params.toString().replace(/%2F/g, '/')}` : '';
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

function generate() {
  if (state.busy) return;
  if (state.mode === 'paste') {
    if (analyze(els.code.value, { label: 'pasted code' })) writeHash(null);
    return;
  }
  const typed = els.repoInput.value.trim();
  const loaded = state.repo ? `${state.repo.owner}/${state.repo.repo}`.toLowerCase() : null;
  let typedRepo = null;
  try {
    const t = parseRepoInput(typed);
    typedRepo = `${t.owner}/${t.repo}`.toLowerCase();
  } catch {
    /* handled by loadRepo */
  }
  if (!state.repo || (typed && typedRepo !== loaded)) {
    loadRepo(typed);
  } else {
    analyzeSelectedFile();
  }
}

// ---------------------------------------------------------------------------
// Toolbar + startup
// ---------------------------------------------------------------------------

function setupToolbar() {
  els.unitSelect.addEventListener('change', () => {
    state.view = els.unitSelect.value;
    renderCharts();
  });
  els.zoomIn.addEventListener('click', () => stepZoom(1));
  els.zoomOut.addEventListener('click', () => stepZoom(-1));
  els.zoomFit.addEventListener('click', () => setZoom('fit'));
  els.copyMarkdown.addEventListener('click', () => {
    if (!state.explanation) return;
    const title = state.label ? `Explanation of ${state.label}` : 'Code explanation';
    copyText(explanationToMarkdown(state.explanation, title), 'Markdown');
  });
  els.copyMermaid.addEventListener('click', () => {
    if (!state.charts.length) return;
    const palette = PALETTES[currentTheme()];
    const charts = visibleCharts();
    const text = charts.length === 1 ? chartDefinition(charts[0], palette) : combinedDefinition(charts, palette);
    copyText(text, 'Mermaid definition');
  });
}

function init() {
  renderLegend();
  setupTabs();
  setupPasteMode();
  setupGitHubMode();
  setupToolbar();

  els.generate.addEventListener('click', generate);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      generate();
    }
  });

  darkQuery.addEventListener('change', () => {
    if (mermaidPromise) mermaidPromise.then((m) => configureMermaid(m));
    if (state.charts.length) renderCharts();
  });

  const draft = storageGet(DRAFT_KEY);
  els.code.value = draft && draft.trim() ? draft : EXAMPLES[0].code;
  loadMermaid().catch((err) => showMessage('error', [el('p', null, err.message)]));

  const linked = readHash();
  if (linked) {
    selectTab('github');
    els.repoInput.value = linked.ref ? `${linked.repo}/tree/${linked.ref}` : linked.repo;
    loadRepo(els.repoInput.value, { selectPath: linked.file, autoAnalyze: !!linked.file });
  } else {
    analyze(els.code.value, { label: draft && draft.trim() ? 'pasted code' : `example: ${EXAMPLES[0].label}` });
  }
  updateGenerateButton();
}

init();
