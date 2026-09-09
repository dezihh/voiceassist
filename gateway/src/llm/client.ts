import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolSpec[],
  timeoutMs?: number
): Promise<ChatMessage> {
  const body: Record<string, unknown> = {
    model: config.llm.model,
    messages,
    max_tokens: config.llm.maxTokens,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (config.llm.reasoningEffort) {
    body.reasoning_effort = config.llm.reasoningEffort;
  }
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: ChatMessage }[] };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('LLM: leere Antwort');
  return message;
}
