import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Run } from './store.ts';
interface Event {
  type: string;
  timestamp: string;
  payload: {
    type?: string;
    turn_id?: string;
    role?: string;
    last_agent_message?: string;
    content?: { text?: string }[];
    item?: { type?: string; server?: string };
  };
}
function parseEvents(text: string): Event[] {
  const events: Event[] = [];
  for (const line of text.split('\n')) {
    try {
      const event: Event = JSON.parse(line);
      if (
        event &&
        typeof event.type === 'string' &&
        event.payload &&
        typeof event.payload === 'object'
      )
        events.push(event);
    } catch {
      /* An incomplete final JSONL line is retried on the next observation. */
    }
  }
  return events;
}
function countTools(result: Run, event: Event): void {
  const p = event.payload;
  if (event.type === 'response_item' && p.type === 'function_call')
    result.toolCalls = (result.toolCalls ?? 0) + 1;
  if (p.type === 'item_completed' && p.item?.type === 'McpToolCall' && p.item.server === 'cua_repl')
    result.browserCalls = (result.browserCalls ?? 0) + 1;
}
function updateText(result: Run, event: Event): void {
  const p = event.payload;
  if (event.type === 'response_item' && p.role === 'assistant' && Array.isArray(p.content)) {
    const text = p.content.map((c) => c.text ?? '').join('\n');
    if (text) result.finalText = text;
  }
  if (p.type === 'task_complete' && p.last_agent_message) result.finalText = p.last_agent_message;
}
export function inspect(run: Run, text: string): Run {
  const result = { ...run, toolCalls: 0, browserCalls: 0 };
  let active = false;
  for (const event of parseEvents(text)) {
    const p = event.payload;
    if (p.type === 'task_started') {
      result.activeTurnId = p.turn_id;
      if (!result.turnId && result.submittedAt && event.timestamp >= result.submittedAt)
        result.turnId = p.turn_id;
      active = Boolean(result.turnId && p.turn_id === result.turnId);
      if (active) result.state = 'running';
    }
    if (p.type === 'task_complete' || p.type === 'turn_aborted') result.activeTurnId = undefined;
    if (!active) continue;
    countTools(result, event);
    updateText(result, event);
    if (p.type === 'task_complete') {
      result.state = 'completed';
      active = false;
    }
    if (p.type === 'turn_aborted') {
      result.state = 'cancelled';
      active = false;
    }
  }
  return result;
}
async function findTranscript(directory: string, id: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(id + '.jsonl')) return full;
    if (entry.isDirectory()) {
      const found = await findTranscript(full, id);
      if (found) return found;
    }
  }
}
export async function observe(run: Run, codexHome: string): Promise<Run> {
  if (!run.threadId) return run;
  const transcript =
    run.transcript ?? (await findTranscript(path.join(codexHome, 'sessions'), run.threadId));
  if (!transcript) return run;
  try {
    return inspect({ ...run, transcript }, await readFile(transcript, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return run;
    throw error;
  }
}
