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
  reasoning_content?: string;
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
    temperature: 0.2,
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
  const data = (await res.json()) as {
    choices?: { message?: { role?: string; content?: string | null; tool_calls?: ChatMessage['tool_calls']; reasoning_content?: string } }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('LLM: leere Antwort');
  return {
    role: (message.role ?? 'assistant') as ChatMessage['role'],
    content: message.content ?? null,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
  };
}
