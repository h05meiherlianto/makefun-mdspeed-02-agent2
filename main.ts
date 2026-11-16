// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node main.ts` (Node 22, type stripping). It reads every
// case from the input directory and writes one HTML string per case, in
// order, to the output directory. Each case is rendered alone by parse().

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

function inputDir(): string {
  return process.env.MAKEFUN_INPUT_DIR ?? '/input';
}

function outputDir(): string {
  return process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
}

function main(): void {
  const cases: Case[] = JSON.parse(
    readFileSync(join(inputDir(), 'cases.json'), 'utf8'),
  ) as Case[];
  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  mkdirSync(outputDir(), { recursive: true });
  writeFileSync(join(outputDir(), 'html.json'), JSON.stringify(html));
}

main();
