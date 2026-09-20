import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Decoder, encode, IPC, turnPayload } from '../src/ipc.ts';
import { reserve, type Run } from '../src/store.ts';
import { inspect } from '../src/observe.ts';

test('decodes split and coalesced IPC frames and rejects oversized frames', () => {
  const decoder = new Decoder();
  const bytes = Buffer.concat([encode({ a: '💡' }), encode({ b: 2 })]);
  assert.deepEqual(decoder.push(bytes.subarray(0, 7)), []);
  assert.deepEqual(decoder.push(bytes.subarray(7)), [{ a: '💡' }, { b: 2 }]);
  const invalid = Buffer.alloc(4);
  invalid.writeUInt32LE(0xffffffff);
  assert.throws(() => new Decoder().push(invalid), /frame size/);
});
test('payload includes context arrays required by desktop rendering', () => {
  const payload = turnPayload('thread', 'prompt');
  assert.deepEqual(payload.turnStart.request.input[0].text_elements, []);
  assert.equal(payload.turnStart.context.useAppServerPermissionDefault, true);
  for (const key of [
    'attachments',
    'commentAttachments',
    'responseItems',
    'mcpAppModelContextAttachments',
  ])
    assert.deepEqual(payload.turnStart.context[key], []);
});
test('concurrent identical submissions reserve one run; changed input rejected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cdr-test-'));
  try {
    const results = await Promise.all([
      reserve(dir, 'job', 'prompt', '/tmp', 'title'),
      reserve(dir, 'job', 'prompt', '/tmp', 'title'),
    ]);
    assert.equal(results.filter((r) => r.fresh).length, 1);
    assert.equal(results[0].run.id, results[1].run.id);
    await assert.rejects(reserve(dir, 'job', 'changed', '/tmp', 'title'), /different input/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const run: Run = {
  id: 'x',
  requestId: 'job',
  fingerprint: 'x',
  createdAt: '2026-09-19T00:00:00Z',
  submittedAt: '2026-09-19T01:00:00Z',
  state: 'unknown',
  cwd: '/tmp',
  title: 'test',
  prompt: 'hello',
};
const event = (type: string, payload: object, timestamp = '2026-09-19T02:00:00Z') =>
  JSON.stringify({ type, payload, timestamp });
test('reconciles lost acknowledgement and excludes bootstrap and later turns', () => {
  const text = [
    event('event_msg', { type: 'task_started', turn_id: 'bootstrap' }, '2026-09-19T00:01:00Z'),
    event('event_msg', {
      type: 'task_complete',
      turn_id: 'bootstrap',
      last_agent_message: 'bootstrap',
    }),
    event('event_msg', { type: 'task_started', turn_id: 'real' }),
    event('response_item', { type: 'function_call', name: 'js' }),
    event('event_msg', {
      type: 'task_complete',
      turn_id: 'real',
      last_agent_message: 'real answer',
    }),
    event('event_msg', { type: 'task_started', turn_id: 'other' }),
    event('event_msg', {
      type: 'task_complete',
      turn_id: 'other',
      last_agent_message: 'wrong answer',
    }),
    '{partial',
  ].join('\n');
  const result = inspect(run, text);
  assert.equal(result.turnId, 'real');
  assert.equal(result.state, 'completed');
  assert.equal(result.finalText, 'real answer');
  assert.equal(result.toolCalls, 1);
});
test('IPC handles discovery, routes to exact owner, and rejects disconnects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cdr-ipc-'));
  const socket = path.join(dir, 'ipc.sock');
  const server = net.createServer((connection) => {
    const decoder = new Decoder();
    connection.on('data', (chunk) => {
      for (const m of decoder.push(chunk)) {
        if (m.type === 'client-discovery-response') continue;
        if (m.method === 'disconnect') {
          connection.destroy();
          continue;
        }
        if (m.method === 'turn') assert.equal(m.targetClientId, 'owner');
        connection.write(encode({ type: 'client-discovery-request', requestId: 'discovery' }));
        connection.write(
          encode({
            type: 'response',
            requestId: m.requestId,
            resultType: 'success',
            result: { clientId: 'test' },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o600);
  try {
    const client = await IPC.connect(socket);
    await client.request('turn', {}, 2, 'owner');
    await assert.rejects(client.request('disconnect', {}, 0), /disconnected/);
    client.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('reporting handoff selects its configured profile instead of desktop defaults', () => {
  const payload = turnPayload('thread', 'prompt', true);
  assert.equal(payload.turnStart.request.permissions, 'cdr-report');
  assert.equal(payload.turnStart.request.approvalPolicy, 'on-request');
  assert.equal(payload.turnStart.context.useAppServerPermissionDefault, false);
  assert.equal(turnPayload('thread', 'prompt').turnStart.request.permissions, undefined);
});
