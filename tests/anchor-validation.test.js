import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKeywordList,
  promptContainsAnchor,
  validateConcepts,
  lintBankLine,
} from '../lib/anchor-validation.js';

describe('buildKeywordList', () => {
  it('includes noun, extra keywords, and significant words', () => {
    const kw = buildKeywordList('umbrella rain', ['parasol']);
    assert.ok(kw.includes('umbrella rain'));
    assert.ok(kw.includes('umbrella'));
    assert.ok(kw.includes('rain'));
    assert.ok(kw.includes('parasol'));
    assert.ok(!kw.includes('fund'));
  });
});

describe('promptContainsAnchor', () => {
  it('matches whole-word keywords', () => {
    assert.equal(
      promptContainsAnchor('open umbrella in heavy rain, editorial photo', ['umbrella', 'rain']),
      true
    );
  });

  it('matches plural keyword variants', () => {
    assert.equal(
      promptContainsAnchor('open umbrellas in heavy rain', ['umbrella', 'rain']),
      true
    );
  });

  it('rejects prompts without anchor keywords', () => {
    assert.equal(
      promptContainsAnchor('particle explosion, abstract network', ['umbrella']),
      false
    );
  });
});

describe('validateConcepts', () => {
  const locked = { noun: 'umbrella', keywords: ['rain'] };

  it('passes when all concepts share anchor and keywords appear in prompts', () => {
    const concepts = [
      { anchor: 'umbrella', concept: 'rain close-up', prompt: 'open umbrella in rain, studio lit' },
      { anchor: 'umbrella', concept: 'wet street', prompt: 'umbrella on wet sidewalk, rain falling' },
      { anchor: 'umbrella', concept: 'sky view', prompt: 'umbrella from below, stormy rain sky' },
    ];
    const result = validateConcepts(locked, concepts);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('fails when anchor drifts', () => {
    const concepts = [
      { anchor: 'explosion', concept: 'burst', prompt: 'abstract particle explosion' },
    ];
    const result = validateConcepts(locked, concepts);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('does not match locked anchor')));
  });

  it('fails when prompt omits anchor keywords', () => {
    const concepts = [
      { anchor: 'umbrella', concept: 'abstract', prompt: 'Obey propaganda poster, red halftone' },
    ];
    const result = validateConcepts(locked, concepts);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('missing anchor keywords')));
  });
});

describe('fund golden cases', () => {
  it('Rain Check Capital — rejects abstract drift prompts', () => {
    const locked = { noun: 'umbrella rain', keywords: ['umbrella', 'rain'] };
    const bad = [
      { anchor: 'umbrella rain', concept: 'emergence moment', prompt: 'Shepard Fairey propaganda, red halftone explosion, breakthrough moment' },
    ];
    const result = validateConcepts(locked, bad);
    assert.equal(result.valid, false);
  });

  it('Rain Check Capital — accepts literal umbrella/rain prompts', () => {
    const locked = { noun: 'umbrella rain', keywords: ['umbrella', 'rain'] };
    const good = [
      { anchor: 'umbrella rain', concept: 'umbrella close-up', prompt: 'open umbrella in heavy rain, Shepard Fairey screen print style, red halftone' },
      { anchor: 'umbrella rain', concept: 'rain street', prompt: 'umbrella on wet sidewalk, rain falling, stippled halftone texture' },
      { anchor: 'umbrella rain', concept: 'storm sky', prompt: 'umbrella from below against stormy rain sky, editorial photography' },
    ];
    const result = validateConcepts(locked, good);
    assert.equal(result.valid, true);
  });

  it('Umbrella Trading — requires umbrella in every prompt', () => {
    const locked = { noun: 'umbrella', keywords: ['umbrella'] };
    const good = [
      { anchor: 'umbrella', concept: 'studio shot', prompt: 'black umbrella isolated on studio backdrop, chrome reflection style' },
      { anchor: 'umbrella', concept: 'wind open', prompt: 'umbrella opening in wind, outdoor cinematic light' },
      { anchor: 'umbrella', concept: 'wet pavement', prompt: 'umbrella on rain-slick pavement, noir cinema still' },
    ];
    assert.equal(validateConcepts(locked, good).valid, true);

    const bad = [
      { anchor: 'umbrella', concept: 'particles', prompt: 'particle field dispersion, abstract luminous dots on dark ground' },
    ];
    assert.equal(validateConcepts(locked, bad).valid, false);
  });
});

describe('lintBankLine', () => {
  it('flags abstract interpretation entries', () => {
    const issues = lintBankLine("show the fund's thesis as a network", 'interpretation');
    assert.ok(issues.length > 0);
  });

  it('allows literal interpretation entries', () => {
    const issues = lintBankLine('anchor subject filling the frame, close-up, large and dominant', 'interpretation');
    assert.equal(issues.length, 0);
  });

  it('flags subject-defining style entries', () => {
    const issues = lintBankLine('particle field forming or dissolving a recognizable shape', 'style');
    assert.ok(issues.length > 0);
  });
});
