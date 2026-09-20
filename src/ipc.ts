import net from 'node:net';
import type { Execution } from './execution.ts';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

export type Message = Record<string, unknown>;
const MAX_FRAME = 64 * 1024 * 1024;
export function encode(message: Message): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export class Decoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): Message[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Message[] = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (!size || size > MAX_FRAME) throw new Error('Invalid IPC frame size');
      if (this.buffer.length < size + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, size + 4).toString()));
      this.buffer = this.buffer.subarray(size + 4);
    }
    return messages;
  }
}
export async function validateSocket(socketPath: string): Promise<void> {
  for (const [file, socket] of [
    [path.dirname(socketPath), false],
    [socketPath, true],
  ] as const) {
    const st = await lstat(file);
    if (
      st.uid !== process.getuid?.() ||
      st.mode & 0o022 ||
      (socket ? !st.isSocket() : !st.isDirectory())
    ) {
      throw new Error(`Untrusted IPC endpoint: ${file}`);
    }
  }
}
export class IPC {
  private socket: net.Socket;
  private clientId = 'initializing-client';
  private pending = new Map<
    string,
    { resolve: (m: Message) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private constructor(socket: net.Socket) {
    this.socket = socket;
    const decoder = new Decoder();
    socket.on('data', (chunk) => {
      try {
        for (const message of decoder.push(chunk)) this.receive(message);
      } catch (error) {
        this.fail(error as Error);
        socket.destroy();
      }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Desktop IPC disconnected')));
  }
  static async connect(socketPath: string): Promise<IPC> {
    await validateSocket(socketPath);
    const socket = net.createConnection(socketPath);
    const ipc = new IPC(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('IPC connect timeout'));
        }, 5000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const response = await ipc.request('initialize', { clientType: 'codex-desktop-runner' }, 0);
      ipc.clientId = stringField(object(response.result), 'clientId');
      return ipc;
    } catch (error) {
      ipc.close();
      throw error;
    }
  }
  request(
    method: string,
    params: Message,
    version: number,
    targetClientId?: string,
  ): Promise<Message> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out; acceptance may be unknown`));
      }, 25000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(
        encode({
          type: 'request',
          requestId,
          sourceClientId: this.clientId,
          method,
          params,
          version,
          targetClientId,
          timeoutMs: 15000,
        }),
      );
    });
  }
  private receive(message: Message): void {
    if (message.type === 'client-discovery-request') {
      this.socket.write(
        encode({
          type: 'client-discovery-response',
          requestId: message.requestId,
          response: { canHandle: false },
        }),
      );
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(String(message.requestId));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.requestId));
    if (message.resultType !== 'success') pending.reject(new Error(JSON.stringify(message)));
    else pending.resolve(message);
  }
  private fail(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  close(): void {
    this.socket.destroy();
  }
}
export function turnPayload(
  threadId: string,
  prompt: string,
  reporting = false,
  execution: Execution = {},
  lookup = false,
): Message {
  return {
    conversationId: threadId,
    turnStart: {
      request: {
        threadId,
        ...execution,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(reporting
          ? { permissions: lookup ? 'cdr-lookup' : 'cdr-report', approvalPolicy: 'on-request' }
          : {}),
      },
      context: {
        useAppServerPermissionDefault: !reporting,
        attachments: [],
        commentAttachments: [],
        responseItems: [],
        mcpAppModelContextAttachments: [],
      },
    },
  };
}

export function object(value: unknown): Message {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected protocol object');
  return value as Message;
}
export function stringField(value: Message, key: string): string {
  if (typeof value[key] !== 'string' || !value[key])
    throw new Error(`Missing protocol string: ${key}`);
  return value[key];
}
