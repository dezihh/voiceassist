export type ActionMode = 'deterministic' | 'llm' | 'hybrid';

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
  display?: DisplayPayload;
  followUp?: boolean;
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
  enabled: number;
}

export interface ParsedAction extends ActionRow {
  triggers: string[];
  toolList: string[] | null;
}

export interface McpServerRow {
  id: number;
  name: string;
  url: string;
  auth_token: string | null;
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
