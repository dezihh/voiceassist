import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  authToken: req('AUTH_TOKEN'),
  dbPath: process.env.DB_PATH ?? './data/voiceassist.db',
  llm: {
    baseUrl: req('LLM_BASE_URL').replace(/\/+$/, ''),
    apiKey: req('LLM_API_KEY'),
    model: process.env.LLM_MODEL ?? 'chat-fast',
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 2000),
    reasoningEffort: process.env.LLM_REASONING_EFFORT,
  },
  agentClarificationBudget: Number(process.env.AGENT_CLARIFICATION_BUDGET ?? 2),
  maxToolIterations: Number(process.env.MAX_TOOL_ITERATIONS ?? 6),
  toolDeadlineMs: Number(process.env.LLM_TOOL_DEADLINE_MS ?? 9000),
  alexaSkillId: process.env.ALEXA_SKILL_ID,
  alexaDirectivesBase: process.env.ALEXA_DIRECTIVES_BASE ?? 'https://api.eu.amazonalexa.com',
  alexaBasicUser: process.env.ALEXA_BASIC_USER,
  alexaBasicPass: process.env.ALEXA_BASIC_PASS,
  alexaBasicMode: process.env.ALEXA_BASIC_MODE ?? 'off',
  alexaVerifyMode: process.env.ALEXA_VERIFY_MODE ?? 'off',
};
