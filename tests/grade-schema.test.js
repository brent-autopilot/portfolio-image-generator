import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tierFromScore, verdictFromScore, validateGradeResponse } from '../lib/grade-schema.js';
import { buildGradeSystemPrompt, loadClogRubricSections } from '../lib/load-clog-rubric.js';

describe('tierFromScore', () => {
  it('maps Clog score bands', () => {
    assert.equal(tierFromScore(9.4), 'Exceptional');
    assert.equal(tierFromScore(7.4), 'Good');
    assert.equal(tierFromScore(5.0), 'Acceptable');
    assert.equal(tierFromScore(4.9), 'Poor');
    assert.equal(tierFromScore(1.2), 'Unacceptable');
  });
});

describe('verdictFromScore', () => {
  it('passes at 5.0 and fails below', () => {
    assert.equal(verdictFromScore(5), 'PASS');
    assert.equal(verdictFromScore(4.9), 'FAIL');
  });
});

describe('validateGradeResponse', () => {
  const base = {
    score: 7.4,
    category: 'aesthetic',
    summary: 'Editorial framing with a clear subject.',
    strengths: ['Controlled palette', 'Clear focal point'],
    weaknesses: ['Slightly generic background'],
    redFlags: [],
    capsApplied: [],
    elementScores: [{ name: 'composition', score: 8 }],
  };

  it('derives PASS and Good from the score even if the model disagrees', () => {
    const result = validateGradeResponse({ ...base, verdict: 'FAIL', tier: 'Poor' });
    assert.equal(result.ok, true);
    assert.equal(result.grade.verdict, 'PASS');
    assert.equal(result.grade.tier, 'Good');
    assert.equal(result.grade.category, 'AESTHETIC');
    assert.equal(result.grade.score, 7.4);
  });

  it('rejects a FAIL with no reasons', () => {
    const result = validateGradeResponse({
      score: 3.2,
      category: 'AESTHETIC',
      summary: 'Generic stock scene.',
      strengths: [],
      weaknesses: [],
      redFlags: [],
    });
    assert.equal(result.ok, false);
  });

  it('accepts a FAIL that names a red flag', () => {
    const result = validateGradeResponse({
      score: 3.1,
      category: 'AESTHETIC',
      summary: 'The subject is visibly broken.',
      strengths: [],
      weaknesses: [],
      redFlags: ['Focal subject has mangled geometry'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.grade.verdict, 'FAIL');
    assert.equal(result.grade.tier, 'Poor');
  });
});

describe('buildGradeSystemPrompt', () => {
  it('includes scoring sections and omits the binary-only output contract', () => {
    const rubric = loadClogRubricSections();
    assert.match(rubric, /## SECTION 3/);
    assert.match(rubric, /## SECTION 10/);
    assert.doesNotMatch(rubric, /## SECTION 11/);

    const prompt = buildGradeSystemPrompt();
    assert.match(prompt, /Return ONLY one JSON object/);
    assert.match(prompt, /score ≥ 5\.0/);
    assert.doesNotMatch(prompt, /Is my draft response exactly `PASS` or `FAIL`/);
  });
});
