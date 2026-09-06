import { listMcpServers } from '../db.js';
import type { ToolDef } from '../types.js';
import { McpClient } from './client.js';

export interface McpServerContext {
  id: number;
  name: string;
  client: McpClient;
  tools: ToolDef[];
}

export interface McpContext {
  servers: McpServerContext[];
}

const TTL_MS = 60_000;
const cache = new Map<number, { client: McpClient; tools: ToolDef[]; ts: number }>();

export function invalidateMcpCache(): void {
  cache.clear();
}

export async function getMcpContext(): Promise<McpContext> {
  const rows = listMcpServers(true);
  const servers: McpServerContext[] = [];
  for (const row of rows) {
    let entry = cache.get(row.id);
    if (!entry || Date.now() - entry.ts > TTL_MS) {
      const client = new McpClient(row.url, row.auth_token);
      await client.init();
      const tools = await client.listTools();
      entry = { client, tools, ts: Date.now() };
      cache.set(row.id, entry);
    }
    servers.push({ id: row.id, name: row.name, client: entry.client, tools: entry.tools });
  }
  return { servers };
}
