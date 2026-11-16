# Fast Markdown Renderer

A fast, dependency-free drop-in replacement for marked 18.1.3 (default
options, GFM on). `parse(markdown)` returns exactly the HTML that
`marked.parse(markdown)` returns, for every input.

## Usage

```js
import { parse } from './parse.js';
const html = parse('# Hello\n\nSome *markdown*.');
```

## Files

- `parse.js` — the parser (dependency-free ES module, exports `parse`).
- `main.ts` — the harness driver: reads `/input/cases.json` (or
  `$MAKEFUN_INPUT_DIR/cases.json`) and writes `/output/html.json`
  (or `$MAKEFUN_OUTPUT_DIR/html.json`).

## License

MIT — see `LICENSE`.
