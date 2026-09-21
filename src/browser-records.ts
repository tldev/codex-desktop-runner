import { readFile } from 'node:fs/promises';
import type { Run } from './store.ts';
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function recordsFromOutput(output: unknown, runId: string, updateId: string): unknown {
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (!object(item) || item.type !== 'input_text' || typeof item.text !== 'string') continue;
    const value = parse(item.text);
    if (!object(value) || !object(value.cdrRecords)) continue;
    const envelope = value.cdrRecords;
    if (envelope.runId === runId && envelope.updateId === updateId) return envelope.records;
  }
  return undefined;
}

function browserCall(p: Record<string, unknown>): boolean {
  return p.type === 'function_call' && ['js', 'mcp__cua_repl__js'].includes(String(p.name));
}

/** Read explicit JSON emitted by the browser REPL, never narrative or page text. */
export function browserRecords(text: string, run: Run, updateId: string): unknown {
  const calls = new Set<string>();
  let result: unknown;
  for (const line of text.split('\n')) {
    const event = parse(line);
    if (!object(event) || event.type !== 'response_item' || !object(event.payload)) continue;
    if (typeof event.timestamp !== 'string' || event.timestamp < (run.submittedAt ?? '')) continue;
    const p = event.payload;
    if (typeof p.call_id !== 'string') continue;
    if (browserCall(p)) {
      calls.add(p.call_id);
    }
    if (p.type === 'function_call_output' && calls.has(p.call_id)) {
      const records = recordsFromOutput(p.output, run.id, updateId);
      if (records !== undefined) result = records;
    }
  }
  if (result === undefined) throw new Error('No matching structured browser output found');
  return result;
}

export async function readBrowserRecords(run: Run, updateId: string): Promise<unknown> {
  if (!run.transcript || !run.submittedAt) throw new Error('Run has no active transcript');
  return browserRecords(await readFile(run.transcript, 'utf8'), run, updateId);
}
