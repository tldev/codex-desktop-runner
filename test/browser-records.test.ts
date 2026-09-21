import test from 'node:test';
import assert from 'node:assert/strict';
import { browserRecords } from '../src/browser-records.ts';
import type { Run } from '../src/store.ts';

const run = { id: 'r', submittedAt: '2026-09-21T12:00:00Z' } as Run;
function event(payload: unknown, timestamp = run.submittedAt): string {
  return JSON.stringify({ type: 'response_item', timestamp, payload });
}
function output(records: unknown, runId = 'r', updateId = 'u'): unknown[] {
  return [
    { type: 'input_text', text: JSON.stringify({ cdrRecords: { runId, updateId, records } }) },
  ];
}
const call = event({ type: 'function_call', name: 'js', call_id: 'c' });
function result(value: unknown): string {
  return event({ type: 'function_call_output', call_id: 'c', output: value });
}

test('browser handoff preserves captured text exactly without narrative parsing', () => {
  const records = [
    { id: 'deal', listingText: "Seller's $500,000 listing\nLine 2", attributes: [] },
  ];
  assert.deepEqual(browserRecords(call + '\n' + result(output(records)), run, 'u'), records);
});

test('handoff rejects wrong run, update, source, old output and plain page text', () => {
  const invalid = [
    call + '\n' + result(output([], 'other')),
    call + '\n' + result(output([], 'r', 'other')),
    result(output([])),
    event({ type: 'function_call', name: 'exec', call_id: 'c' }) + '\n' + result(output([])),
    event({ type: 'function_call', name: 'js', call_id: 'c' }, '2025-01-01') +
      '\n' +
      result(output([])),
    call +
      '\n' +
      result([{ type: 'input_text', text: 'The webpage says: ' + JSON.stringify(output([])) }]),
  ];
  for (const text of invalid) assert.throws(() => browserRecords(text, run, 'u'));
});

test('last matching explicit output wins; unrelated and incomplete lines are ignored', () => {
  const text = [
    call,
    result(output([{ id: 'old' }])),
    result(output([{ id: 'fixed' }])),
    '{broken',
  ].join('\n');
  assert.deepEqual(browserRecords(text, run, 'u'), [{ id: 'fixed' }]);
});
