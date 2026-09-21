import { mkdir, readFile, writeFile, rename, readdir, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Execution } from './execution.ts';
import type { Contract } from './schema.ts';
import type { Reporting } from './reporting.ts';
export interface Run {
  lookup?: boolean;
  parentState?: string;
  execution?: Execution;
  actualExecution?: Execution;
  contract?: Contract;
  reporting?: Reporting;
  id: string;
  requestId: string;
  fingerprint: string;
  createdAt: string;
  state: string;
  cwd: string;
  title: string;
  prompt: string;
  threadId?: string;
  turnId?: string;
  activeTurnId?: string;
  transcript?: string;
  submittedAt?: string;
  error?: string;
  finalText?: string;
  toolCalls?: number;
  browserCalls?: number;
}
export function key(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export async function reserve(
  root: string,
  requestId: string,
  prompt: string,
  cwd: string,
  title: string,
  contract?: Contract,
  execution: Execution = {},
  lookup = false,
): Promise<{ run: Run; fresh: boolean }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = key(requestId);
  const settings = {
    ...(Object.keys(execution).length ? { execution } : {}),
    ...(lookup ? { lookup } : {}),
  };
  const fingerprint = key(
    JSON.stringify({ prompt, cwd, title, ...(contract ? { contract } : {}), ...settings }),
  );
  const run: Run = {
    id,
    requestId,
    fingerprint,
    createdAt: new Date().toISOString(),
    state: 'preparing',
    cwd,
    title,
    prompt,
    ...settings,
    ...(contract ? { contract } : {}),
  };
  const temporary = path.join(root, `.reserve-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(run, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, path.join(root, id + '.json'));
    return { run, fresh: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary);
  }
  const existing = await load(root, id);
  if (existing.fingerprint !== fingerprint)
    throw new Error('Request ID already exists with different input');
  return { run: existing, fresh: false };
}
export async function save(root: string, run: Run): Promise<void> {
  const temporary = path.join(root, `.${run.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(run, null, 2), { mode: 0o600 });
  await rename(temporary, path.join(root, run.id + '.json'));
}
export async function load(root: string, id: string): Promise<Run> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid run ID');
  return JSON.parse(await readFile(path.join(root, id + '.json'), 'utf8'));
}
export async function list(root: string): Promise<Run[]> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return Promise.all(
    (await readdir(root))
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .map((f) => load(root, f.slice(0, -5))),
  );
}
