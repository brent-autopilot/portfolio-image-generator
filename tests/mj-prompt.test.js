import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withMidjourneyVersion } from '../lib/mj-prompt.js';

describe('withMidjourneyVersion', () => {
  it('pins v8.2 when the prompt has no version', () => {
    const prompt = 'open umbrella in rain --profile ptxxc2l --sref https://example.com/a.jpg --sw 100';
    assert.equal(
      withMidjourneyVersion(prompt),
      'open umbrella in rain --profile ptxxc2l --sref https://example.com/a.jpg --sw 100 --v 8.2',
    );
  });

  it('does not add a second version flag', () => {
    const prompt = 'umbrella --v 7 --sref https://example.com/a.jpg';
    assert.equal(withMidjourneyVersion(prompt), prompt);
  });
});
