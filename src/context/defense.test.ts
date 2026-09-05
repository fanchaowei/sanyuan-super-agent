import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelMessage } from 'ai';
import { estimateMessageTokens, TokenTracker } from './defense.js';

test('uses the same character-to-token estimate for messages and tracker deltas', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: '中'.repeat(400) },
  ];
  const tracker = new TokenTracker();

  tracker.addMessages(messages);

  assert.equal(tracker.estimatedTokens, estimateMessageTokens(messages));
});

test('keeps an API count exact while estimating only the pending delta', () => {
  const tracker = new TokenTracker();
  tracker.updateFromAPI(1_000);

  tracker.addMessage({ role: 'user', content: '中'.repeat(400) });

  assert.equal(tracker.estimatedTokens, 1_120);
});
