#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lintBankLine } from '../lib/anchor-validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadBankLines(filename) {
  const raw = readFileSync(join(root, 'prompts', filename), 'utf-8');
  const afterSep = raw.split('\n---\n').pop() || raw;
  return afterSep
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('<!--'));
}

let failed = false;

for (const [file, type] of [
  ['interpretation-bank.md', 'interpretation'],
  ['style-bank.md', 'style'],
]) {
  const lines = loadBankLines(file);
  console.log(`\nLinting ${file} (${lines.length} entries)...`);
  for (const line of lines) {
    const issues = lintBankLine(line, type);
    if (issues.length) {
      failed = true;
      console.error(`  FAIL: ${line.slice(0, 80)}`);
      for (const issue of issues) console.error(`        - ${issue}`);
    }
  }
}

if (failed) {
  console.error('\nBank lint failed.');
  process.exit(1);
}

console.log('\nBank lint passed.');
