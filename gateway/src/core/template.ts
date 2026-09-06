import nunjucks from 'nunjucks';
import type { McpContext } from '../mcp/registry.js';
import type { AssistantResponse, TraceEvent } from '../types.js';

const env = new nunjucks.Environment(null, { autoescape: false });

interface LiteralCalls {
  states: string[];
  entityCalls: string[];
  calls: string[];
}

function extractLiterals(template: string): LiteralCalls {
  const states: string[] = [];
  const entityCalls: string[] = [];
  const calls: string[] = [];
  for (const m of template.matchAll(/ha\.state\(\s*["']([^"']+)["']\s*\)/g)) states.push(m[1] as string);
  for (const m of template.matchAll(/ha\.entities\(\s*["']([^"']*)["']\s*\)/g)) {
    const domain = m[1] as string;
    if (domain) entityCalls.push(domain);
  }
  for (const m of template.matchAll(/ha\.call\(\s*["']([^"']+)["']\s*\)/g)) calls.push(m[1] as string);
  return { states, entityCalls, calls };
}

function findTool(
  mcp: McpContext,
  patterns: RegExp[]
): { server: McpContext['servers'][number]; toolName: string } | undefined {
  for (const server of mcp.servers) {
    for (const pattern of patterns) {
      const tool = server.tools.find((t) => pattern.test(t.name));
      if (tool) return { server, toolName: tool.name };
    }
  }
  return undefined;
}

function findToolExact(
  mcp: McpContext,
  toolName: string
): { server: McpContext['servers'][number]; toolName: string } | undefined {
  for (const server of mcp.servers) {
    const tool = server.tools.find((t) => t.name === toolName);
    if (tool) return { server, toolName };
  }
  return undefined;
}

function extractText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(result);
  }
  return String(result ?? '');
}

function stripSsml(text: string): string {
  return text
    .replace(/<speak>|<\/speak>/gi, '')
    .replace(/<break[^>]*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapSpeech(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const ssml = obj.ssml;
    if (typeof ssml === 'string') return stripSsml(ssml);
    if (ssml && typeof ssml === 'object') {
      const inner = (ssml as Record<string, unknown>).speech;
      if (typeof inner === 'string') return stripSsml(inner);
    }
    if (typeof obj.speech === 'string') return obj.speech;
  }
  return null;
}

async function preheat(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[]
): Promise<Record<string, unknown>> {
  const { states, entityCalls, calls } = extractLiterals(template);
  const stateMap = new Map<string, string | null>();
  const entityMap = new Map<string, unknown[]>();
  const callMap = new Map<string, string | null>();
  const stateTool = findTool(mcp, [/state/i]);
  const listTool = findTool(mcp, [/search|lookup|entit/i]);

  for (const toolName of calls) {
    if (callMap.has(toolName)) continue;
    try {
      const found = findToolExact(mcp, toolName);
      if (!found) throw new Error(`Tool ${toolName} auf keinem MCP-Server gefunden`);
      const result = await found.server.client.callTool(found.toolName, {});
      callMap.set(toolName, extractText(result));
      trace.push({ ts: Date.now(), step: 'template.call', detail: { toolName, server: found.server.name } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.call.error', detail: { toolName, error: String(e) } });
      callMap.set(toolName, null);
    }
  }

  for (const entityId of states) {
    if (stateMap.has(entityId)) continue;
    try {
      if (!stateTool) throw new Error('kein State-Tool gefunden');
      const result = await stateTool.server.client.callTool(stateTool.toolName, { entity_id: entityId });
      stateMap.set(entityId, extractText(result));
      trace.push({ ts: Date.now(), step: 'template.state', detail: { entityId } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.state.error', detail: { entityId, error: String(e) } });
      stateMap.set(entityId, null);
    }
  }

  for (const domain of entityCalls) {
    if (entityMap.has(domain)) continue;
    try {
      if (!listTool) throw new Error('kein Entity-Tool gefunden');
      const result = await listTool.server.client.callTool(listTool.toolName, { domain });
      entityMap.set(domain, (result as unknown[]) ?? []);
      trace.push({ ts: Date.now(), step: 'template.entities', detail: { domain } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.entities.error', detail: { domain, error: String(e) } });
      entityMap.set(domain, []);
    }
  }

  return {
    ha: {
      state: (entityId: string): string | null => stateMap.get(entityId) ?? null,
      entities: (domain: string): unknown[] => entityMap.get(domain) ?? [],
      call: (toolName: string): string | null => callMap.get(toolName) ?? null,
    },
  };
}

export async function renderActionTemplate(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[]
): Promise<AssistantResponse> {
  const ctx = await preheat(template, mcp, trace);
  const out = env.renderString(template, ctx).trim();
  if (out.startsWith('{')) {
    try {
      const parsed = JSON.parse(out) as { speech?: unknown; display?: AssistantResponse['display'] };
      const speech = unwrapSpeech(parsed.speech);
      if (speech !== null) {
        return { speech, ...(parsed.display ? { display: parsed.display } : {}) };
      }
    } catch {
      return { speech: out };
    }
  }
  return { speech: out };
}
