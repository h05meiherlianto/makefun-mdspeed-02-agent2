# markdown-render-speed-02

A fast, dependency-free Markdown renderer. `parse(markdown)` returns exactly
the HTML that marked 18.1.3 produces with its default options (GFM on,
breaks off, pedantic off), for CommonMark 0.31.2 and GFM 0.29 inputs.

## Layout

- `parse.js` — the renderer. A dependency-free ES module exporting
  `parse(markdown)`. It is a line-based block parser plus a scanner-based
  inline parser, with a two-pass collection of link reference definitions
  and an opener-driven emphasis pass.
- `main.ts` — the driver the harness runs (`node main.ts`). It reads
  `cases.json` from `$MAKEFUN_INPUT_DIR` (or `/input`), renders each case
  alone with `parse()`, and writes `html.json` to `$MAKEFUN_OUTPUT_DIR`
  (or `/output`).

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

## Speed

The parser is written for speed: the block pass dispatches on the first
character of a line instead of trying every block rule, list continuation
lines are scanned by hand rather than with regular expressions, and the
table and setext rules are skipped by a cheap guard when the delimiter or
underline cannot be present. On the competition's practice set it matches
marked byte-for-byte on all 720 cases and renders the set about 1.2x faster
than marked 18.1.3.

## License

MIT — see `LICENSE`.
