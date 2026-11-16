// Entry point for the fast markdown renderer (make.fun
// markdown-render-speed-02). Reads the cases from the input directory,
// renders each case on its own with parse() from parse.js, and writes the
// resulting HTML strings, in input order, as a JSON array to the output
// directory. Run under Node 22 as `node /bot/main.ts`; outside the
// container the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment
// variables stand in for /input and /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
