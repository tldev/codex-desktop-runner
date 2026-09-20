import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contract, validate, type Schema } from '../src/schema.ts';
import { reserve } from '../src/store.ts';
import { report, snapshot } from '../src/reporting.ts';
const schema: Schema = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 0 } },
  required: ['id', 'count'],
  additionalProperties: false,
};
const spec = contract({ version: 1, progress: schema, record: schema, result: schema });

test('contract refuses unsupported schemas and validates nested inputs', () => {
  assert.throws(() => contract({ ...spec, version: 2 }));
  assert.throws(() => contract({ ...spec, progress: { ...schema, pattern: '.*' } }));
  assert.throws(() => validate(schema, { id: 'x', count: -1 }));
  assert.throws(() => validate(schema, { id: 'x', count: 1.5 }));
  assert.throws(() => validate(schema, { id: 'x', count: 1, extra: true }));
  assert.throws(() => validate(schema, { id: 'x' }));
  validate({ type: 'array', items: schema, maxItems: 1 }, [{ id: 'x', count: 2 }]);
  assert.throws(() =>
    validate({ type: 'array', items: schema, maxItems: 1 }, [
      { id: 'x', count: 2 },
      { id: 'y', count: 2 },
    ]),
  );
});

test('reports are durable, idempotent, atomic and final', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cdr-report-'));
  try {
    const { run } = await reserve(root, 'example', 'prompt', '/tmp', 'test', spec);
    run.submittedAt = new Date().toISOString();
    report(root, run, 'report', 'p1', { id: 'phase', count: 1 });
    assert.equal(report(root, run, 'report', 'p1', { id: 'phase', count: 1 }).version, 1);
    assert.throws(() => report(root, run, 'report', 'p1', { id: 'phase', count: 2 }));
    assert.throws(() =>
      report(root, run, 'append-records', 'r1', [
        { id: 'ok', count: 1 },
        { id: 'bad', count: -2 },
      ]),
    );
    assert.equal(snapshot(root, run.id).records.length, 0);
    report(root, run, 'append-records', 'r2', [{ id: 'ok', count: 1 }]);
    report(root, run, 'append-records', 'r3', [{ id: 'ok', count: 2 }]);
    assert.deepEqual(snapshot(root, run.id).records, [{ id: 'ok', count: 2 }]);
    report(root, run, 'finish', 'done', { id: 'result', count: 2 });
    assert.equal(snapshot(root, run.id).finished, true);
    assert.throws(() => report(root, run, 'report', 'late', { id: 'phase', count: 3 }));
    assert.equal(report(root, run, 'finish', 'done', { id: 'result', count: 2 }).version, 4);
    await assert.rejects(
      reserve(root, 'example', 'prompt', '/tmp', 'test', {
        ...spec,
        progress: { type: 'boolean' },
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
