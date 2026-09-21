import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contract, validate, type Schema } from '../src/schema.ts';
import { threadParameters, verifyReportingPermissions } from '../src/bootstrap.ts';
import { reserve } from '../src/store.ts';
import { report, snapshot, prepareReporting } from '../src/reporting.ts';
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
    prepareReporting(root, run.id);
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

test('reporting profile keeps the project read-only and refuses broader runtime grants', () => {
  const directory = '/private/tmp/report';
  const params = threadParameters('/project', directory);
  assert.equal(params.sandbox, undefined);
  assert.equal(threadParameters('/project').sandbox, 'read-only');
  assert.deepEqual(params.config, { default_permissions: 'cdr-report' });
  const response = {
    approvalPolicy: 'on-request',
    activePermissionProfile: { id: 'cdr-report', extends: ':read-only' },
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [directory],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
  verifyReportingPermissions(response, directory);
  for (const override of [
    { networkAccess: true },
    { writableRoots: [directory, '/project'] },
    { excludeSlashTmp: false },
  ]) {
    assert.throws(
      () =>
        verifyReportingPermissions(
          { ...response, sandbox: { ...response.sandbox, ...override } },
          directory,
        ),
      /scoped reporting/,
    );
  }
});

test('new run reports have separate private directories and preserve legacy snapshots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cdr-isolation-'));
  try {
    const { run: legacy } = await reserve(root, 'legacy', 'prompt', '/tmp', 'test', spec);
    legacy.submittedAt = new Date().toISOString();
    report(root, legacy, 'report', 'p1', { id: 'legacy', count: 1 });
    const { run } = await reserve(root, 'isolated', 'prompt', '/tmp', 'test', spec);
    const directory = prepareReporting(root, run.id);
    run.submittedAt = legacy.submittedAt;
    report(root, run, 'report', 'p1', { id: 'isolated', count: 2 });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'reporting.sqlite'))).mode & 0o777, 0o600);
    assert.deepEqual(snapshot(root, legacy.id).progress, { id: 'legacy', count: 1 });
    assert.deepEqual(snapshot(root, run.id).progress, { id: 'isolated', count: 2 });
    assert.throws(() => prepareReporting(root, '../escape'), /Invalid run id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('live lookup is an explicit fingerprinted capability with a network proxy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cdr-lookup-'));
  try {
    const { run } = await reserve(root, 'lookup', 'prompt', '/tmp', 'test', spec, {}, true);
    assert.equal(run.lookup, true);
    await assert.rejects(
      reserve(root, 'lookup', 'prompt', '/tmp', 'test', spec),
      /different input/,
    );
    const params = threadParameters('/project', '/reports', {}, true);
    assert.deepEqual(params.config, {
      default_permissions: 'cdr-lookup',
      'features.network_proxy': true,
    });
    const response = {
      approvalPolicy: 'on-request',
      activePermissionProfile: { id: 'cdr-lookup', extends: ':read-only' },
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: ['/reports'],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    };
    verifyReportingPermissions(response, '/reports', true);
    assert.throws(() => verifyReportingPermissions(response, '/reports'), /scoped reporting/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compact acknowledgment does not return sensitive or bulky listing text', async () => {
  const { acknowledgment } = await import('../src/reporting.ts');
  assert.deepEqual(
    acknowledgment({
      version: 8,
      records: [{ id: 'listing', text: 'large private payload' }],
      finished: false,
    }),
    { version: 8, recordCount: 1, finished: false },
  );
});

test('cancellation seals reports while allowing a researcher to acknowledge stopping', async () => {
  const { researcherLifecycle } = await import('../src/reporting.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'cdr-lifecycle-'));
  try {
    const { run } = await reserve(root, 'lifecycle', 'test', root, 'test', spec);
    run.submittedAt = new Date().toISOString();
    prepareReporting(root, run.id);
    researcherLifecycle(root, run, 'researcher-start');
    assert.throws(
      () => report(root, run, 'finish', 'finish-early', { id: 'result', count: 1 }),
      /Researcher must stop/,
    );
    assert.throws(() => researcherLifecycle(root, run, 'researcher-start'), /another researcher/);
    researcherLifecycle(root, run, 'stop');
    assert.throws(
      () => report(root, run, 'append-records', 'late', [{ id: 'listing', count: 1 }]),
      /late reports/,
    );
    assert.equal(snapshot(root, run.id).researcherActive, true);
    researcherLifecycle(root, run, 'researcher-stop');
    assert.equal(snapshot(root, run.id).researcherActive, false);
    assert.equal(snapshot(root, run.id).stopped, true);
    assert.throws(() => researcherLifecycle(root, run, 'researcher-start'), /another researcher/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
