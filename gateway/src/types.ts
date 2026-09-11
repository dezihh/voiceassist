export type ActionMode = 'deterministic' | 'llm' | 'hybrid' | 'search_summary';

export interface SearchSummaryConfig {
  search_query: string;
  keep_open?: boolean;
  fetch?: { url: string; pick?: string; fields?: string[]; max?: number };
  urls?: string[];
  url_chars?: number;
  topic_template?: string;
  stopwords?: string[];
  time_range?: 'day' | 'week' | 'month';
  engines?: string;
  max_results?: number;
  snippet_chars?: number;
  model?: string;
  fallback_model?: string;
  answer_prompt?: string;
}

export interface VoiceQuery {
  sessionId: string;
  userId?: string;
  text: string;
}

export interface DisplayPayload {
  title?: string;
  text?: string;
  images?: string[];
  video?: string;
}

export interface AssistantResponse {
  speech: string;
  ssml?: boolean;
  display?: DisplayPayload;
  followUp?: boolean;
  followupPrompt?: string;
  keepOpen?: boolean;
}

export interface ActionRow {
  id: number;
  name: string;
  mode: ActionMode;
  trigger_phrases: string | null;
  fuzzy_threshold: number | null;
  system_prompt: string | null;
  template: string | null;
  tools: string | null;
  handler_config: string | null;
  enabled: number;
}

export interface ParsedAction extends ActionRow {
  triggers: string[];
  toolList: string[] | null;
  handlerConfig: SearchSummaryConfig | null;
}

export interface McpServerRow {
  id: number;
  name: string;
  url: string;
  auth_token: string | null;
  transport: 'http' | 'stdio';
  command: string | null;
  args: string | null;
  env: string | null;
  enabled: number;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface TraceEvent {
  ts: number;
  step: string;
  detail?: unknown;
}

export interface EngineResult {
  response: AssistantResponse;
  route: string;
  actionId?: number;
  score?: number;
  durationMs: number;
  trace: TraceEvent[];
}
