import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDef } from '../types.js';
import type { McpTransport } from './client.js';

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: RpcMessage) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface StdioConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class McpStdioClient implements McpTransport {
  private nextId = 1;
  private child: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<number, PendingRequest>();
  private exited = false;

  constructor(private readonly config: StdioConfig) {}

  private ensureChild(): ChildProcess {
    if (this.child && !this.exited) return this.child;
    this.exited = false;
    this.buffer = '';
    this.child = spawn(this.config.command, this.config.args, {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        ...this.config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', () => {
      // Server-Logs auf stderr bewusst ignorieren
    });
    this.child.on('error', (e) => this.onExit(new Error(`stdio spawn: ${e.message}`)));
    this.child.on('close', () => this.onExit(new Error('stdio MCP-Server hat sich beendet')));
    return this.child;
  }

  private onExit(err: Error): void {
    this.exited = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  }

  private rpc(
    method: string,
    params: unknown,
    notify = false,
    timeoutMs = 15_000
  ): Promise<RpcMessage | null> {
    const child = this.ensureChild();
    const id = notify ? undefined : this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== undefined) body.id = id;
    const line = `${JSON.stringify(body)}\n`;
    if (notify) {
      child.stdin!.write(line);
      return Promise.resolve(null);
    }
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id!);
        reject(new Error(`stdio ${method}: Timeout nach ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id!, { resolve, reject, timer });
      child.stdin!.write(line);
    });
  }

  async init(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'meinhelfer', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
  }

  async listTools(): Promise<ToolDef[]> {
    const res = await this.rpc('tools/list', {});
    if (res?.error) throw new Error(`MCP tools/list: ${res.error.message}`);
    const result = res?.result as { tools?: ToolDef[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.rpc('tools/call', { name, arguments: args }, false, 60_000);
    if (res?.error) throw new Error(`MCP tools/call ${name}: ${res.error.message}`);
    return res?.result;
  }

  stop(): void {
    if (this.child && !this.exited) this.child.kill('SIGTERM');
    this.child = null;
  }
}
