import nunjucks from 'nunjucks';
import type { McpContext } from '../mcp/registry.js';
import type { AssistantResponse, TraceEvent } from '../types.js';

const env = new nunjucks.Environment(null, { autoescape: false });

interface LiteralCalls {
  states: string[];
  entityCalls: string[];
}

function extractLiterals(template: string): LiteralCalls {
  const states: string[] = [];
  const entityCalls: string[] = [];
  for (const m of template.matchAll(/ha\.state\(\s*["']([^"']+)["']\s*\)/g)) states.push(m[1] as string);
  for (const m of template.matchAll(/ha\.entities\(\s*["']([^"']*)["']\s*\)/g)) {
    const domain = m[1] as string;
    if (domain) entityCalls.push(domain);
  }
  return { states, entityCalls };
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

async function preheat(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[]
): Promise<Record<string, unknown>> {
  const { states, entityCalls } = extractLiterals(template);
  const stateMap = new Map<string, string | null>();
  const entityMap = new Map<string, unknown[]>();
  const stateTool = findTool(mcp, [/state/i]);
  const listTool = findTool(mcp, [/search|lookup|entit/i]);

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
      const parsed = JSON.parse(out) as { speech?: string; display?: AssistantResponse['display'] };
      if (typeof parsed.speech === 'string') {
        return { speech: parsed.speech, ...(parsed.display ? { display: parsed.display } : {}) };
      }
    } catch {
      return { speech: out };
    }
  }
  return { speech: out };
}
