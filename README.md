# Fast Markdown Renderer

A dependency-free, hand-written drop-in replacement for marked 18.1.3
with its default options (GFM on). `parse(markdown)` returns exactly the
HTML that `marked.parse(markdown)` returns, byte for byte, for every
input — including the 720-case practice set (CommonMark 0.31.2, GFM 0.29,
and 40 long generated READMEs) — while running noticeably faster than
marked on the same inputs.

## How it works

- A line-based block parser renders HTML strings directly (no token
  tree): blockquotes, lists, tables, fenced and indented code, ATX and
  setext headings, HTML blocks, link reference definitions, and
  paragraphs, with marked's exact tab-expansion, lazy-continuation, and
  trailing-newline rules.
- A scanner-based inline parser with a CommonMark delimiter stack for
  emphasis, strong, and strikethrough, plus links, images, autolinks
  (angle-bracket and GFM extended), code spans, entities, and escapes.
- Link reference definitions are collected document-wide in a first
  pass, so a link may use a definition that appears later in the file.

## Usage

```js
import { parse } from './parse.js';
const html = parse('# Hello\n\nSome *markdown*.');
```

## Files

- `parse.js` — the parser (dependency-free ES module, exports `parse`).
- `main.ts` — the harness driver: reads `cases.json` from the input
  directory (`$MAKEFUN_INPUT_DIR` or `/input`) and writes `html.json`
  to the output directory (`$MAKEFUN_OUTPUT_DIR` or `/output`).

## License

MIT — see `LICENSE`.
