import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonObjectFromClaude,
  parseJsonArrayFromClaude,
  extractBalancedJson,
} from '../lib/parse-claude-json.js';

describe('parseJsonObjectFromClaude', () => {
  it('parses fenced anchor JSON without matching the keywords array', () => {
    const raw = '```json\n{ "noun": "rain check ticket", "keywords": ["rain", "check", "ticket", "raincheck"] }\n```';
    const parsed = parseJsonObjectFromClaude(raw);
    assert.equal(parsed?.noun, 'rain check ticket');
    assert.deepEqual(parsed?.keywords, ['rain', 'check', 'ticket', 'raincheck']);
  });

  it('parses object with preamble text', () => {
    const raw = 'Here is the anchor:\n{ "noun": "umbrella", "keywords": ["rain"] }';
    const parsed = parseJsonObjectFromClaude(raw);
    assert.equal(parsed?.noun, 'umbrella');
  });
});

describe('parseJsonArrayFromClaude', () => {
  it('parses fenced concept arrays', () => {
    const raw = '```json\n[{ "label": "A", "prompt": "umbrella in rain" }]\n```';
    const parsed = parseJsonArrayFromClaude(raw);
    assert.equal(parsed?.length, 1);
    assert.equal(parsed?.[0]?.label, 'A');
  });

  it('parses array when object appears earlier in text', () => {
    const raw = 'metadata: { "ignored": true }\n[{ "concept": "shot", "prompt": "umbrella in rain" }]';
    const parsed = parseJsonArrayFromClaude(raw);
    assert.equal(parsed?.length, 1);
    assert.equal(parsed?.[0]?.concept, 'shot');
  });
});

describe('extractBalancedJson', () => {
  it('handles nested braces inside strings', () => {
    const raw = '{ "noun": "brace { test }", "keywords": [] }';
    const jsonText = extractBalancedJson(raw, '{', '}');
    const parsed = JSON.parse(jsonText);
    assert.equal(parsed.noun, 'brace { test }');
  });
});
