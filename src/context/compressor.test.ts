import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remapTimestampsAfterCompaction } from './compressor.js';

test('keeps timestamps unchanged when no messages were summarized', () => {
  const timestamps = new Map([
    [0, 100],
    [1, 200],
  ]);

  const result = remapTimestampsAfterCompaction(timestamps, 0, 2, 999);

  assert.deepEqual([...result], [[0, 100], [1, 200]]);
  assert.notEqual(result, timestamps);
});

test('assigns a fresh timestamp to the summary and remaps retained messages', () => {
  const timestamps = new Map([
    [0, 100],
    [1, 200],
    [2, 300],
    [3, 400],
    [4, 500],
  ]);

  // 前 3 条被摘要，新列表为：[摘要, 原消息 3, 原消息 4]。
  const result = remapTimestampsAfterCompaction(timestamps, 3, 3, 999);

  assert.deepEqual([...result], [[0, 999], [1, 400], [2, 500]]);
});

test('does not invent timestamps for retained messages that had no timestamp', () => {
  const timestamps = new Map([[2, 300]]);

  const result = remapTimestampsAfterCompaction(timestamps, 2, 3, 999);

  assert.deepEqual([...result], [[0, 999], [1, 300]]);
});
