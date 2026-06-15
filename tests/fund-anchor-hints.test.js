import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLockedAnchor } from '../lib/fund-anchor-hints.js';

describe('sanitizeLockedAnchor', () => {
  it('corrects Rain Check Capital ticket wordplay to umbrella rain', () => {
    const result = sanitizeLockedAnchor('Rain Check Capital', {
      noun: 'rain check ticket',
      keywords: ['rain', 'check', 'ticket'],
    });
    assert.equal(result.corrected, true);
    assert.equal(result.noun, 'umbrella rain');
    assert.ok(result.keywords.includes('umbrella'));
    assert.ok(result.keywords.includes('rain'));
  });

  it('leaves valid anchors unchanged', () => {
    const result = sanitizeLockedAnchor('Rain Check Capital', {
      noun: 'umbrella rain',
      keywords: ['umbrella', 'rain'],
    });
    assert.equal(result.corrected, false);
    assert.equal(result.noun, 'umbrella rain');
  });
});
