import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Sections 3–10 of clog-qc.md — scoring rules without the binary-only output contract. */
export function loadClogRubricSections() {
  const raw = readFileSync(join(__dirname, '..', 'prompts', 'clog-qc.md'), 'utf-8');
  const start = raw.indexOf('## SECTION 3');
  const end = raw.indexOf('## SECTION 11');
  if (start < 0 || end <= start) {
    throw new Error('Clog rubric sections 3–10 not found');
  }
  return raw.slice(start, end).trim();
}

export function buildGradeSystemPrompt() {
  const header = readFileSync(join(__dirname, '..', 'prompts', 'clog-grade.md'), 'utf-8').trim();
  return `${header}\n\n---\n\n# Scoring rubric\n\n${loadClogRubricSections()}`;
}
