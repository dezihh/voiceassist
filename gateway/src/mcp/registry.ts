import { listMcpServers } from '../db.js';
import type { ToolDef } from '../types.js';
import { McpClient, type McpTransport } from './client.js';
import { McpStdioClient } from './stdio.js';

export interface McpServerContext {
  id: number;
  name: string;
  client: McpTransport;
  tools: ToolDef[];
}

export interface McpContext {
  servers: McpServerContext[];
}

const TTL_MS = 60_000;
const cache = new Map<number, { client: McpTransport; tools: ToolDef[]; ts: number }>();

function stopClient(client: McpTransport | undefined): void {
  if (client && typeof client.stop === 'function') client.stop();
}

export function invalidateMcpCache(): void {
  for (const entry of cache.values()) stopClient(entry.client);
  cache.clear();
}

function parseJsonArray(raw: string | null): string[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, string> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

function createClient(row: { transport: 'http' | 'stdio'; url: string; auth_token: string | null; command: string | null; args: string | null; env: string | null }): McpTransport {
  if (row.transport === 'stdio') {
    return new McpStdioClient({
      command: row.command ?? '',
      args: parseJsonArray(row.args),
      env: parseJsonObject(row.env),
    });
  }
  return new McpClient(row.url, row.auth_token);
}

export { createClient };

export async function getMcpContext(): Promise<McpContext> {
  const rows = listMcpServers(true);
  const servers: McpServerContext[] = [];
  for (const row of rows) {
    let entry = cache.get(row.id);
    if (!entry || Date.now() - entry.ts > TTL_MS) {
      stopClient(entry?.client);
      const client = createClient(row);
      await client.init();
      const tools = await client.listTools();
      entry = { client, tools, ts: Date.now() };
      cache.set(row.id, entry);
    }
    servers.push({ id: row.id, name: row.name, client: entry.client, tools: entry.tools });
  }
  return { servers };
}
