import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { object, stringField, type Message } from './ipc.ts';

export function threadParameters(cwd: string, reportsRoot?: string): Message {
  return {
    cwd,
    approvalPolicy: 'on-request',
    ...(reportsRoot
      ? {
          config: { default_permissions: 'cdr-report' },
        }
      : { sandbox: 'read-only' }),
  };
}

export function verifyReportingPermissions(started: Message, directory: string): void {
  const sandbox = object(started.sandbox);
  const profile = object(started.activePermissionProfile);
  if (
    profile.id !== 'cdr-report' ||
    profile.extends !== ':read-only' ||
    started.approvalPolicy !== 'on-request' ||
    sandbox.type !== 'workspaceWrite' ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true ||
    JSON.stringify(sandbox.writableRoots) !== JSON.stringify([directory])
  )
    throw new Error('Runtime did not apply the scoped reporting permission profile');
}

// Only this short-lived child is stopped. Never stop the desktop-owned runtime.
export async function bootstrap(
  binary: string,
  cwd: string,
  title: string,
  onThread: (thread: Message) => Promise<void>,
  reportsRoot?: string,
): Promise<Message> {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  let next = 0;
  const waiters = new Set<{
    match: (m: Message) => boolean;
    resolve: (m: Message) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  const fail = (error: Error) => {
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(error);
    }
    waiters.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error(`Bootstrap exited: ${stderr}`)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let m: Message;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    for (const w of waiters)
      if (w.match(m)) {
        clearTimeout(w.timer);
        waiters.delete(w);
        w.resolve(m);
      }
  });
  const wait = (match: (m: Message) => boolean, timeout = 90000) =>
    new Promise<Message>((resolve, reject) => {
      const w = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(w);
          reject(new Error('Bootstrap timeout'));
        }, timeout),
      };
      waiters.add(w);
    });
  const send = (m: Message) => child.stdin.write(JSON.stringify(m) + '\n');
  const request = async (method: string, params: Message) => {
    const id = ++next;
    const response = wait((m) => m.id === id);
    send({ id, method, params });
    const m = await response;
    if (m.error) throw new Error(JSON.stringify(m.error));
    return object(m.result);
  };
  try {
    await request('initialize', { clientInfo: { name: 'codex_desktop_runner', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    const started = await request('thread/start', threadParameters(cwd, reportsRoot));
    if (reportsRoot) verifyReportingPermissions(started, reportsRoot);
    const thread = object(started.thread);
    const threadId = stringField(thread, 'id');
    await onThread(thread);
    await request('thread/name/set', { threadId: threadId, name: title });
    // Persist a real rollout before handing ownership to the desktop.
    const completed = wait(
      (m) => m.method === 'turn/completed' && object(m.params).threadId === threadId,
    );
    completed.catch(() => {}); // The request below may fail before completion is awaited.
    await request('turn/start', {
      threadId: threadId,
      input: [
        {
          type: 'text',
          text: 'Reply only: Desktop runner ready. Do not use tools.',
          text_elements: [],
        },
      ],
    });
    const event = await completed;
    if (object(object(event.params).turn).status !== 'completed')
      throw new Error('Bootstrap turn failed');
    await request('thread/unsubscribe', { threadId: threadId });
    return thread;
  } finally {
    lines.close();
    fail(new Error('Bootstrap closed'));
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
  }
}
