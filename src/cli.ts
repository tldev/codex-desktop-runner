#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { IPC, turnPayload, object, stringField } from './ipc.ts';
import { bootstrap } from './bootstrap.ts';
import { reserve, save, load, list, type Run } from './store.ts';
import { observe } from './observe.ts';
const exec = promisify(execFile);
const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
const root = process.env.CDR_HOME ?? path.join(homedir(), '.local/state/codex-desktop-runner');
const socket = process.env.CDR_SOCKET ?? path.join(codexHome, 'ipc/ipc.sock');
const app = process.env.CDR_APP ?? '/Applications/ChatGPT.app';
const binary = process.env.CDR_CODEX ?? path.join(app, 'Contents/Resources/codex');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: 'string' },
    title: { type: 'string' },
    'prompt-file': { type: 'string' },
    'request-id': { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
function publicRun(run: Run): Partial<Run> {
  const result: Partial<Run> = { ...run };
  delete result.prompt;
  delete result.fingerprint;
  return result;
}
async function refresh(run: Run): Promise<Run> {
  return observe(run, codexHome);
}
async function owner(ipc: IPC, threadId: string): Promise<string> {
  const response = await ipc.request(
    'thread-owner-discovery',
    { hostId: 'local', conversationId: threadId },
    1,
  );
  if (!response.handledByClientId) throw new Error('Desktop returned no thread owner');
  return stringField(response, 'handledByClientId');
}
async function start(): Promise<void> {
  if (!values['prompt-file']) throw new Error('start requires --prompt-file (use - for stdin)');
  const prompt = await readPrompt(values['prompt-file']);
  if (!prompt.trim()) throw new Error('Prompt must not be empty');
  const cwd = await realpath(values.cwd ?? process.cwd());
  const title = values.title ?? 'Desktop runner task';
  const { run, fresh } = await reserve(
    root,
    values['request-id'] ?? randomUUID(),
    prompt,
    cwd,
    title,
  );
  if (!fresh) {
    output(publicRun(await refresh(run)));
    return;
  }
  try {
    const probe = await IPC.connect(socket);
    probe.close();
    await bootstrap(binary, cwd, title, async (thread) => {
      run.threadId = stringField(thread, 'id');
      if (typeof thread.path === 'string') run.transcript = thread.path;
      await save(root, run);
    });
    await exec('open', ['-a', app, `codex://threads/${run.threadId}`]);
    const ipc = await IPC.connect(socket);
    try {
      const target = await attach(ipc, run.threadId!);
      run.state = 'submitting';
      run.submittedAt = new Date().toISOString();
      await save(root, run); // Persist before sending. Never automatically resend after this point.
      const response = await ipc.request(
        'thread-follower-start-turn',
        turnPayload(run.threadId!, prompt),
        2,
        target,
      );
      const result = object(response.result);
      run.turnId = stringField(object(object(result.result ?? result).turn), 'id');
      if (!run.turnId)
        throw new Error('Desktop response missing turn ID; submission outcome unknown');
      run.state = 'running';
      await save(root, run);
    } finally {
      ipc.close();
    }
  } catch (error) {
    run.state = run.submittedAt ? 'unknown' : 'failed';
    run.error = String(error);
    await save(root, run);
    output(publicRun(run));
    process.exitCode = 1;
    return;
  }
  output(publicRun(run));
}

async function readPrompt(file: string): Promise<string> {
  if (file !== '-') return readFile(file, 'utf8');
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
async function attach(ipc: IPC, threadId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await owner(ipc, threadId);
    } catch {
      if (attempt === 7) throw new Error('Desktop attachment failed. Check project trust prompt.');
      await sleep(2000);
    }
  }
  throw new Error('Desktop attachment failed');
}
async function waitForRun(initial: Run): Promise<Run> {
  let run = initial;
  const seconds = Number(values.timeout ?? 900);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('Timeout must be positive seconds');
  const deadline = Date.now() + seconds * 1000;
  while (!['completed', 'failed', 'cancelled'].includes(run.state) && Date.now() < deadline) {
    await sleep(2000);
    run = await refresh(run);
  }
  if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
    output({ ...publicRun(run), waitTimedOut: true });
    process.exitCode = 2;
  }
  return run;
}

async function doctor(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Only macOS is supported');
  const version = (await exec(binary, ['--version'])).stdout.trim();
  const ipc = await IPC.connect(socket);
  ipc.close();
  output({
    ok: true,
    version,
    socket,
    app,
    protocol: 'desktop IPC start-turn v2',
    browser: 'Requires a live task to verify',
  });
}

async function cancel(run: Run): Promise<void> {
  if (['completed', 'cancelled', 'failed'].includes(run.state)) {
    output(publicRun(run));
    return;
  }
  if (!run.threadId || !run.turnId)
    throw new Error('Cannot safely cancel without a known thread and turn');
  const ipc = await IPC.connect(socket);
  try {
    const target = await owner(ipc, run.threadId);
    await ipc.request(
      'thread-follower-interrupt-turn',
      { conversationId: run.threadId },
      2,
      target,
    );
  } finally {
    ipc.close();
  }
  output({ ...publicRun(run), cancellationRequested: true });
}

async function main(): Promise<void> {
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`codex-desktop-runner: control the existing macOS Codex desktop app

Commands (JSON output by default):
  doctor
  start --prompt-file FILE --cwd DIR --title TITLE --request-id KEY
  list
  status RUN_ID
  wait RUN_ID [--timeout SECONDS]
  result RUN_ID
  cancel RUN_ID

Environment: CDR_HOME, CDR_APP, CDR_CODEX, CDR_SOCKET, CODEX_HOME
start accepts --prompt-file - for stdin. A timeout does not cancel a task.
Repeating start with the same request ID never submits another turn.`);
    return;
  }
  if (command === 'doctor') return doctor();
  if (command === 'start') return start();
  if (command === 'list') {
    output(await Promise.all((await list(root)).map(async (r) => publicRun(await refresh(r)))));
    return;
  }
  if (!['status', 'wait', 'result', 'cancel'].includes(command))
    throw new Error(`Unknown command: ${command}`);
  if (!positionals[1]) throw new Error('Run ID required');
  let run = await refresh(await load(root, positionals[1]));
  if (command === 'cancel') return cancel(run);
  if (command === 'wait') {
    run = await waitForRun(run);
    if (process.exitCode === 2) return;
  }
  if (command === 'result' && run.state !== 'completed') process.exitCode = 2;
  output(publicRun(run));
}
main().catch((error) => {
  output({ error: String(error) });
  process.exitCode = 1;
});
