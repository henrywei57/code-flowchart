# Code Flowchart

Paste JavaScript (or pick a file from a public GitHub repo) and get two things back:

1. **A flowchart** of each function's control flow, drawn with [Mermaid](https://mermaid.js.org).
2. **A plain-English explanation** of what the code does, with a complexity count.

Everything comes from static analysis and fixed sentence templates. There are **no AI or LLM calls** anywhere: the code is parsed into a syntax tree with [Acorn](https://github.com/acornjs/acorn), and each kind of statement maps to a flowchart shape and a sentence template.

**Live app:** https://henrywei57.github.io/code-flowchart/

## What you get

| Code | Flowchart | Explanation template |
| --- | --- | --- |
| `function` / method / callback | green start node | "Defines a function `name` that takes `a` and `b` as input." |
| `if` / `else if` / `else` | diamond with **Yes** / **No** branches | "If `cond`, then …; otherwise …." |
| `for`, `for…of`, `for…in`, `while`, `do…while` | hexagon loop node with loop-back arrows | "Loops over `items`, repeating the block below for each item (`item`)." |
| function call | double-sided "subroutine" box naming the call | "Calls `save` with `data`", plus friendlier wording for common APIs (`fetch`, `console.log`, `.map`, `require`, …) |
| `return` / `throw` | rounded terminal node | "Returns `total`." |
| `switch`, `try/catch/finally`, `break`, `continue` | case edges, dotted "on error" edge, jumps | sentences for each |

- **Existing comments are kept verbatim.** A comment block above a function (JSDoc or `//` lines) appears in that function's explanation, and comments above individual statements appear next to the matching step.
- **Complexity:** each function and the whole file get a `complexity: N decision points` tag. N counts branches (`if`/`else if`, `switch` cases, ternaries) plus loops.
- Every function gets its own chart. Pick one from the menu or view them all. Charts can be zoomed, panned, copied as Mermaid source, or downloaded as SVG; the explanation can be copied as Markdown.

## Run it locally

It's a static site with no build step. ES modules need to be served over HTTP (opening `index.html` as a `file://` URL won't work), so start any static server from the project folder:

```bash
python3 scripts/serve.py
```

Then open http://localhost:8080. (`python3 -m http.server 8080` or `npx serve` work too; `scripts/serve.py` just turns off caching so edits show up on reload.)

To run the pipeline tests (Node 18+):

```bash
npm test
```

Acorn is vendored in `vendor/acorn.mjs`, so the site needs no `npm install`. To update it: `npm install && npm run vendor`.

## GitHub repo mode

Switch to **Load from GitHub** and enter `owner/repo` or any GitHub URL, including `…/tree/<branch>` and `…/blob/<branch>/<path>`. A file URL selects that file directly.

- **Public repositories only, no token needed.** Requests go straight from your browser to GitHub's REST API, with no sign-in and no server in between.
- Loading a repo makes **one** API call (the recursive [Git Trees API](https://docs.github.com/en/rest/git/trees)) to list its files, filtered to `.js` (plus `.mjs` / `.cjs`). Minified, bundled, and vendored files are hidden by default.
- File contents are downloaded from `raw.githubusercontent.com`, which doesn't count against the API limit, and then go through the same pipeline as pasted code.
- GitHub allows **60 unauthenticated API requests per hour** per IP address. The app shows how many are left and says when the limit resets if you run out. Private repos appear as "not found", because GitHub hides them from anonymous requests.
- After you analyze a file, the page URL changes to a shareable link such as `#repo=expressjs/express&file=lib/router/index.js`.

## Project structure

```
index.html            page markup
css/styles.css        styles (light + dark)
js/parser.js          language registry: source → outline
js/languages/javascript.js   Acorn AST → language-neutral outline
js/outline.js         the outline format shared by everything below
js/flowchart.js       outline → Mermaid `flowchart TD` definitions
js/explanation.js     outline → plain-English explanation (templates)
js/github.js          GitHub REST API: list repo files, fetch file text
js/main.js            UI wiring and rendering
js/examples.js        sample programs for the Examples menu
vendor/acorn.mjs      Acorn parser (MIT)
test/smoke.mjs        pipeline tests (`npm test`)
```

The parser turns each language's syntax tree into a small, language-neutral **outline** (functions, ifs, loops, calls, returns, comments). The flowchart and explanation builders only read that outline, so they don't depend on Acorn or on JavaScript.

## Limitations

- Plain JavaScript only. Files with JSX, TypeScript, or Flow annotations show a parse error explaining why.
- Very long functions are cut off at about 240 chart nodes. The explanation still covers the whole function.
- Calls are matched to local functions by name only (`helper()`, `this.method()`), not by tracking types.

## Planned (out of scope for this version)

- **Python and other languages:** add a parser in `js/languages/` that produces the same outline and register it in `js/parser.js`. The flowchart and explanation code stay as they are.
- **Private repositories:** add an optional GitHub token and send it as an `Authorization` header in `js/github.js`.

## Credits

[Acorn](https://github.com/acornjs/acorn) (MIT) parses the code; [Mermaid](https://github.com/mermaid-js/mermaid) (MIT, loaded from jsDelivr) draws the charts.
