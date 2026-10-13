import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tierFromScore, verdictFromScore, validateGradeResponse, PILOT_CATEGORIES, pilotGradeError } from '../lib/grade-schema.js';
import { buildGradeSystemPrompt, loadClogRubricSections, loadPilotPhotoGradePrompt } from '../lib/load-clog-rubric.js';

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
      bindingCap: 4,
    });
    assert.equal(result.ok, true);
    assert.equal(result.grade.verdict, 'FAIL');
    assert.equal(result.grade.tier, 'Poor');
  });

  it('caps a high craft score when a red-flag ceiling is set', () => {
    const result = validateGradeResponse({
      score: 6.2,
      category: 'LOGO',
      summary: 'Polished fantasy lockup built on a growth-arrow cliché.',
      strengths: ['Legible type', 'Controlled palette'],
      weaknesses: ['Upward arrow is a finance-poster symbol'],
      redFlags: ['Upward arrow as growth metaphor'],
      bindingCap: 3.5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.grade.score, 3.5);
    assert.equal(result.grade.verdict, 'FAIL');
    assert.equal(result.grade.tier, 'Poor');
    assert.equal(result.grade.bindingCap, 3.5);
  });

  it('rejects HEADSHOT on the fund grader', () => {
    const result = validateGradeResponse({ ...base, category: 'HEADSHOT' });
    assert.equal(result.ok, false);
  });

  it('accepts HEADSHOT only for the pilot category set', () => {
    const result = validateGradeResponse({
      ...base,
      category: 'headshot',
      elementScores: [
        { name: 'face', score: 8 },
        { name: 'light', score: 7 },
        { name: 'crop', score: 7.5 },
        { name: 'background', score: 6 },
      ],
    }, { categories: PILOT_CATEGORIES });
    assert.equal(result.ok, true);
    assert.equal(result.grade.category, 'HEADSHOT');
    assert.equal(result.grade.verdict, 'PASS');
  });

  it('rejects a named red flag with no binding cap', () => {
    const result = validateGradeResponse({
      score: 6.2,
      category: 'LOGO',
      summary: 'Noted the arrow and still passed.',
      strengths: ['Legible type', 'Sharp rendering'],
      weaknesses: ['Arrow cliché'],
      redFlags: ['Upward arrow as growth metaphor'],
    });
    assert.equal(result.ok, false);
  });
});

describe('pilotGradeError', () => {
  const elements = [
    { name: 'face', score: 8 },
    { name: 'light', score: 7 },
    { name: 'crop', score: 7 },
    { name: 'background', score: 6 },
  ];

  it('accepts a portrait whose score stays under the face', () => {
    assert.equal(pilotGradeError({ score: 7.4, elementScores: elements }), null);
  });

  it('rejects a score the face cannot support', () => {
    assert.match(pilotGradeError({ score: 8.1, elementScores: elements }), /face element/);
  });

  it('requires every portrait element', () => {
    assert.match(pilotGradeError({ score: 7, elementScores: elements.slice(1) }), /face/);
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
    assert.match(prompt, /A red flag is a ceiling/);
    assert.match(prompt, /cap the image at 3\.5/);
    assert.doesNotMatch(prompt, /Is my draft response exactly `PASS` or `FAIL`/);
  });

  it('keeps the pilot prompt separate from the fund rubric', () => {
    const prompt = loadPilotPhotoGradePrompt();
    assert.match(prompt, /HEADSHOT/);
    assert.match(prompt, /cannot exceed the `face` score/);
    assert.match(prompt, /No identifiable face/);
    assert.match(prompt, /Not a photograph of a person/);
    assert.match(prompt, /3\.5/);
    assert.match(prompt, /4\.0/);
    assert.doesNotMatch(prompt, /LOGO-GRID/);
    assert.doesNotMatch(prompt, /## SECTION 11/);
    assert.doesNotMatch(prompt, /finance-metaphor/);
    const onDisk = readFileSync(new URL('../prompts/pilot-photo-grade.md', import.meta.url), 'utf8');
    assert.equal(prompt, onDisk.trim());
  });
});
