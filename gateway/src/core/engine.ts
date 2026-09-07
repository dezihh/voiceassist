import { config } from '../config.js';
import {
  addLog,
  listActions,
  getPrompt,
  getSetting,
} from '../db.js';
import { chatCompletion, type ChatMessage, type ToolSpec } from '../llm/client.js';
import { getMcpContext, type McpContext } from '../mcp/registry.js';
import { routeAction, type RouteMatch } from './router.js';
import { renderActionTemplate } from './template.js';
import type {
  AssistantResponse,
  EngineResult,
  ParsedAction,
  TraceEvent,
  VoiceQuery,
} from '../types.js';

const FallbackError = 'Entschuldigung, da ist etwas schiefgelaufen.';

interface ToolRoute {
  client: McpContext['servers'][number]['client'];
  toolName: string;
}

function buildTools(
  mcp: McpContext,
  allowlist: string[] | null
): { specs: ToolSpec[]; routes: Map<string, ToolRoute> } {
  const specs: ToolSpec[] = [];
  const routes = new Map<string, ToolRoute>();
  for (const server of mcp.servers) {
    for (const def of server.tools) {
      const key = routes.has(def.name) ? `${server.name}.${def.name}` : def.name;
      if (allowlist && !allowlist.includes(def.name) && !allowlist.includes(key)) continue;
      routes.set(key, { client: server.client, toolName: def.name });
      specs.push({
        type: 'function',
        function: {
          name: key,
          description: def.description ?? '',
          parameters: def.inputSchema ?? { type: 'object' },
        },
      });
    }
  }
  return { specs, routes };
}

function parseAgentAnswer(content: string, trace: TraceEvent[]): AssistantResponse {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { needs_clarification?: boolean; speech?: string };
      if (typeof parsed.speech === 'string' && parsed.speech.trim().length > 0) {
        return { speech: parsed.speech, followUp: parsed.needs_clarification === true };
      }
      trace.push({ ts: Date.now(), step: 'agent.empty_speech' });
      return { speech: 'Entschuldigung, dazu habe ich gerade nichts gefunden.' };
    } catch {
      trace.push({ ts: Date.now(), step: 'agent.json_parse_error' });
    }
  }
  if (text.length === 0) {
    trace.push({ ts: Date.now(), step: 'agent.empty_content' });
    return { speech: 'Entschuldigung, dazu habe ich gerade nichts gefunden.' };
  }
  return { speech: text };
}

async function runToolLoop(
  system: string,
  query: string,
  allowlist: string[] | null,
  mcp: McpContext,
  trace: TraceEvent[]
): Promise<AssistantResponse> {
  const { specs, routes } = buildTools(mcp, allowlist);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: query },
  ];
  for (let i = 0; i < config.maxToolIterations; i++) {
    const message = await chatCompletion(messages, specs.length > 0 ? specs : undefined);
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return parseAgentAnswer(message.content ?? '', trace);
    }
    messages.push(message);
    for (const call of message.tool_calls) {
      let result: string;
      try {
        const route = routes.get(call.function.name);
        if (!route) throw new Error(`unbekanntes Tool: ${call.function.name}`);
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        if (typeof args.num_results === 'number' && args.num_results > 3) {
          args.num_results = 3;
        }
        const out = await route.client.callTool(route.toolName, args);
        result = JSON.stringify(out).slice(0, 4000);
        trace.push({ ts: Date.now(), step: 'tool.call', detail: { tool: call.function.name, args } });
      } catch (e) {
        result = `ERROR: ${String(e)}`;
        trace.push({
          ts: Date.now(),
          step: 'tool.error',
          detail: { tool: call.function.name, error: String(e) },
        });
      }
      messages.push({ role: 'tool', content: result, tool_call_id: call.id });
    }
  }
  return { speech: 'Das hat zu lange gedauert, bitte versuche es noch einmal.' };
}

async function runAgent(query: VoiceQuery, mcp: McpContext, trace: TraceEvent[]): Promise<AssistantResponse> {
  const system = getPrompt('agent_system') ?? 'Du bist ein hilfreicher deutscher Sprachassistent.';
  return runToolLoop(system, query.text, null, mcp, trace);
}

async function executeAction(
  action: ParsedAction,
  query: VoiceQuery,
  mcp: McpContext,
  trace: TraceEvent[]
): Promise<AssistantResponse> {
  if (action.mode === 'llm' || (action.mode === 'hybrid' && !action.template)) {
    const system = action.system_prompt ?? getPrompt('agent_system') ?? '';
    return runToolLoop(system, query.text, action.toolList, mcp, trace);
  }
  const rendered = await renderActionTemplate(action.template ?? '', mcp, trace);
  if (action.mode === 'deterministic') return rendered;
  const system = action.system_prompt ?? getPrompt('agent_system') ?? '';
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Daten:\n${rendered.speech}\n\nAnfrage: ${query.text}\nFormuliere daraus eine kurze, sprechbare Antwort.`,
    },
  ];
  const message = await chatCompletion(messages);
  return parseAgentAnswer(message.content ?? '', trace);
}

export async function processQuery(query: VoiceQuery): Promise<EngineResult> {
  const start = Date.now();
  const trace: TraceEvent[] = [
    { ts: start, step: 'query', detail: { sessionId: query.sessionId, text: query.text } },
  ];
  const actions = listActions(true);
  const fuzzyGlobal = getSetting('fuzzy_global') !== '0';
  const match: RouteMatch | null = routeAction(query.text, actions, fuzzyGlobal);
  const mcp = await getMcpContext().catch((e: unknown) => {
    trace.push({ ts: Date.now(), step: 'mcp.error', detail: String(e) });
    return { servers: [] } as McpContext;
  });

  let response: AssistantResponse;
  let route: string;
  if (match) {
    route = 'action';
    trace.push({
      ts: Date.now(),
      step: 'route.action',
      detail: { action: match.action.name, score: match.score, phrase: match.phrase },
    });
    try {
      response = await executeAction(match.action, query, mcp, trace);
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'action.error', detail: String(e) });
      response = { speech: FallbackError };
    }
  } else {
    route = 'agent';
    trace.push({ ts: Date.now(), step: 'route.agent' });
    try {
      response = await runAgent(query, mcp, trace);
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'agent.error', detail: String(e) });
      response = { speech: FallbackError };
    }
  }

  const durationMs = Date.now() - start;
  addLog({
    sessionId: query.sessionId,
    query: query.text,
    route,
    actionId: match?.action.id,
    score: match?.score,
    response: response.speech,
    durationMs,
    trace,
  });
  return {
    response,
    route,
    actionId: match?.action.id,
    score: match?.score,
    durationMs,
    trace,
  };
}
