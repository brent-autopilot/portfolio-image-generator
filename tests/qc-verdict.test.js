import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClogVerdict, normalizeLiteralVerdict } from '../lib/qc-verdict.js';

describe('normalizeClogVerdict', () => {
  it('accepts exact PASS', () => {
    assert.equal(normalizeClogVerdict('PASS'), 'PASS');
  });

  it('normalizes noisy PASS responses', () => {
    assert.equal(normalizeClogVerdict('Pass.'), 'PASS');
    assert.equal(normalizeClogVerdict(' PASS! '), 'PASS');
  });

  it('defaults non-PASS to FAIL', () => {
    assert.equal(normalizeClogVerdict('FAIL'), 'FAIL');
    assert.equal(normalizeClogVerdict('maybe pass'), 'FAIL');
  });
});

describe('normalizeLiteralVerdict', () => {
  it('accepts YES variants', () => {
    assert.equal(normalizeLiteralVerdict('YES'), true);
    assert.equal(normalizeLiteralVerdict('Yes.'), true);
  });

  it('rejects NO variants', () => {
    assert.equal(normalizeLiteralVerdict('NO'), false);
    assert.equal(normalizeLiteralVerdict('No.'), false);
  });
});
