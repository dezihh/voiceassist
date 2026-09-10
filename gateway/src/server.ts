import express, { type Request, type Response } from 'express';
import { join } from 'node:path';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { verifyAlexaSignature } from './alexa-verify.js';
import { processQuery } from './core/engine.js';
import { chatCompletion } from './llm/client.js';
import { fromAssistantResponse, toVoiceQuery } from './adapters/alexa.js';
import { invalidateMcpCache, createClient } from './mcp/registry.js';
import type { ActionMode } from './types.js';
import {
  createAction,
  createMcpServer,
  deleteAction,
  deleteMcpServer,
  getAction,
  getMcpServer,
  getSettings,
  listActions,
  listLogs,
  listMcpServers,
  listPrompts,
  setPrompt,
  setSetting,
  updateAction,
  updateMcpServer,
  addLog,
  getSetting,
  type ActionInput,
  type McpServerInput,
} from './db.js';

const app = express();
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

function normalizeActionInput(body: Record<string, unknown>): ActionInput {
  const mode = String(body.mode ?? '');
  if (mode !== 'deterministic' && mode !== 'llm' && mode !== 'hybrid') {
    throw new Error(`Ungültiger Modus: ${mode}`);
  }
  const triggers = Array.isArray(body.trigger_phrases) ? body.trigger_phrases.map(String) : [];
  const tools = Array.isArray(body.tools) ? body.tools.map(String) : null;
  return {
    name: String(body.name ?? '').trim(),
    mode: mode as ActionMode,
    trigger_phrases: JSON.stringify(triggers),
    fuzzy_threshold: body.fuzzy_threshold == null ? null : Number(body.fuzzy_threshold),
    system_prompt: body.system_prompt == null ? null : String(body.system_prompt),
    template: body.template == null ? null : String(body.template),
    tools: tools && tools.length > 0 ? JSON.stringify(tools) : null,
    enabled: body.enabled === false ? 0 : 1,
  };
}

function normalizeServerInput(body: Record<string, unknown>): McpServerInput {
  const name = String(body.name ?? '').trim();
  const transport = body.transport === 'stdio' ? 'stdio' : 'http';
  let url = String(body.url ?? '').trim();
  let command: string | null = null;
  let args: string | null = null;
  let env: string | null = null;
  if (transport === 'stdio') {
    command = String(body.command ?? '').trim();
    if (!command) throw new Error('command ist für Transport stdio erforderlich');
    if (!name) throw new Error('name ist erforderlich');
    url = '';
    const argsList = Array.isArray(body.args)
      ? (body.args as unknown[]).map(String)
      : String(body.args ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    args = JSON.stringify(argsList);
    const envObj: Record<string, string> = {};
    const envRaw = body.env;
    const entries: [string, string][] =
      envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw)
        ? Object.entries(envRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        : String(envRaw ?? '')
            .split('\n')
            .map((line) => {
              const i = line.indexOf('=');
              return i > 0 ? ([line.slice(0, i).trim(), line.slice(i + 1).trim()] as [string, string]) : null;
            })
            .filter((e): e is [string, string] => e !== null);
    for (const [k, v] of entries) if (k) envObj[k] = v;
    env = JSON.stringify(envObj);
  } else if (!url || !name) {
    throw new Error('name und url sind erforderlich');
  }
  return {
    name,
    url,
    auth_token: body.auth_token ? String(body.auth_token) : null,
    transport,
    command,
    args,
    env,
    enabled: body.enabled === false ? 0 : 1,
  };
}

const WARTETON_PHRASE = 'Einen Moment, ich schaue das kurz nach.';
const ALEXA_WELCOME = 'Hallo, ich bin Ihr Voice-Assistent. Was kann ich für Sie tun?';
const ALEXA_HELP =
  'Sie können mich zum Beispiel nach dem Hausstatus oder nach aktuellen Nachrichten fragen.';
const ALEXA_GOODBYE = 'Bis zum nächsten Mal.';
const ALEXA_FALLBACK =
  'Entschuldigung, das habe ich nicht verstanden. Versuchen Sie zum Beispiel: was ist der Hausstatus.';

async function sendProgressiveDirective(
  apiAccessToken: string,
  requestId: string
): Promise<void> {
  try {
    await fetch(`${config.alexaDirectivesBase}/v1/directives`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        directive: {
          header: { requestId },
          directive: { type: 'VoicePlayer.Speak', speech: WARTETON_PHRASE },
        },
      }),
    });
  } catch (e) {
    console.error('Progressive Directive fehlgeschlagen:', e);
  }
}

app.get('/privacy', (req, res) => {
  res
    .type('html')
    .send(
      '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Datenschutz – Voice Assist</title></head><body><h1>Datenschutz – Voice Assist</h1><p>Der Skill &bdquo;Voice Assist&ldquo; verarbeitet Sprachanfragen ausschlie&szlig;lich zur Beantwortung der Anfrage. Es werden keine Sprachdaten dauerhaft gespeichert und keine Daten an Dritte weitergegeben. Der Betrieb erfolgt privat im eigenen Netzwerk des Betreibers.</p><p>Bei Fragen wenden Sie sich an den Betreiber des Skills.</p></body></html>'
    );
});

app.post('/alexa', async (req, res) => {
  const body = req.body as {
    context?: {
      System?: { application?: { applicationId?: string }; apiAccessToken?: string };
    };
    session?: { application?: { applicationId?: string }; sessionId?: string };
    request?: { requestId?: string; type?: string; intent?: { name?: string } };
  };
  const appId =
    body.context?.System?.application?.applicationId ??
    body.session?.application?.applicationId;
  const appIdSource = body.context?.System?.application?.applicationId
    ? 'context'
    : body.session?.application?.applicationId
      ? 'session'
      : 'fehlt';
  const reqType = body.request?.type ?? '';
  const intentName =
    (body.request as { intent?: { name?: string } } | undefined)?.intent?.name ?? '';

  let sigState = 'off';
  if (config.alexaVerifyMode !== 'off') {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const result = await verifyAlexaSignature(
      raw,
      req.headers['signature'] as string | undefined,
      req.headers['signaturecertchainurl'] as string | undefined,
      (body.request as { timestamp?: string } | undefined)?.timestamp
    );
    sigState = result.ok ? 'ok' : `invalid:${result.reason}`.slice(0, 80);
  }

  if (getSetting('debug_logging') === '1') {
    addLog({
      sessionId: body.session?.sessionId ?? 'alexa',
      query: JSON.stringify({
        type: reqType,
        intent: intentName,
        appId: appId ? appId.slice(0, 30) : 'fehlt',
        appIdSource,
        skillMatch: appId === config.alexaSkillId,
        sig: sigState,
      }),
      route: `alexa:${reqType || intentName || '?'}`,
      response: '',
      durationMs: 0,
      trace: [],
    });
  }

  if (config.alexaSkillId && appId !== config.alexaSkillId) {
    res.status(403).json({ reason: 'Unerwartete applicationId' });
    return;
  }

  if (sigState.startsWith('invalid') && config.alexaVerifyMode === 'enforce') {
    res.status(401).json({ reason: 'ungueltige Alexa-Signatur' });
    return;
  }
  if (sigState.startsWith('invalid')) {
    console.warn(`Alexa-Signaturpruefung: ${sigState} (warn-Modus, Request zugelassen)`);
  }

  // Fast-Paths: einfache Requests ohne Engine-Aufruf (kein LLM-Turn, keine Kosten)
  if (reqType === 'SessionEndedRequest') {
    res.json({ version: '1.0', response: {} });
    return;
  }
  const fast =
    reqType === 'LaunchRequest'
      ? { speech: ALEXA_WELCOME, end: false }
      : intentName === 'AMAZON.HelpIntent'
        ? { speech: ALEXA_HELP, end: false }
        : intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent'
          ? { speech: ALEXA_GOODBYE, end: true }
          : intentName === 'AMAZON.FallbackIntent' || intentName === 'FallbackIntent'
            ? { speech: ALEXA_FALLBACK, end: false }
            : undefined;
  if (fast) {
    res.json(fromAssistantResponse({ speech: fast.speech, followUp: !fast.end }));
    return;
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  if (body.request?.type === 'IntentRequest' && body.context?.System?.apiAccessToken && body.request.requestId) {
    watchdog = setTimeout(
      () =>
        sendProgressiveDirective(
          body.context!.System!.apiAccessToken!,
          body.request!.requestId!
        ),
      6500
    );
  }

  try {
    const query = toVoiceQuery(req.body as Record<string, never>);
    const result = await processQuery(query);
    res.json(fromAssistantResponse(result.response));
  } catch (e) {
    console.error('Alexa-Verarbeitung fehlgeschlagen:', e);
    res.json(fromAssistantResponse({ speech: 'Entschuldigung, da ist etwas schiefgelaufen.' }));
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
});

const handleQuery = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { sessionId?: string; userId?: string; text?: string };
  if (!body.text) {
    res.status(400).json({ error: 'text erforderlich' });
    return;
  }
  const result = await processQuery({
    sessionId: body.sessionId ?? 'api-test',
    userId: body.userId,
    text: body.text,
  });
  res.json(result);
};

app.post('/api/query', requireAuth, handleQuery);
app.post('/admin/api/query', requireAuth, handleQuery);

const handleLambdaTrace = (req: Request, res: Response) => {
  const body = req.body as { sessionId?: string; event?: string; elapsedMs?: number; note?: string };
  if (getSetting('debug_logging') === '1') {
    addLog({
      sessionId: body.sessionId ?? 'lambda',
      query: JSON.stringify(body),
      route: `lambda-trace:${body.event ?? '?'}`,
      response: '',
      durationMs: Number(body.elapsedMs ?? 0),
      trace: [],
    });
  }
  res.status(204).end();
};
// Unter /api (nicht /admin): die LAN-only-Regel des Nginx-Vhosts blockiert sonst AWS-Lambda-IPs (403).
app.post('/api/lambda-trace', requireAuth, handleLambdaTrace);
app.post('/admin/api/lambda-trace', requireAuth, handleLambdaTrace);

app.get('/admin/api/bootstrap', requireAuth, (req, res) => {
  res.json({
    settings: getSettings(),
    actions: listActions(false),
    servers: listMcpServers(false),
    prompts: listPrompts(),
  });
});

app.put('/admin/api/settings', requireAuth, (req, res) => {
  const body = req.body as { settings?: Record<string, string> };
  if (!body.settings || typeof body.settings !== 'object') {
    res.status(400).json({ error: 'settings-Objekt erforderlich' });
    return;
  }
  for (const [key, value] of Object.entries(body.settings)) setSetting(key, String(value));
  res.json({ settings: getSettings() });
});

app.get('/admin/api/actions', requireAuth, (req, res) => {
  res.json({ actions: listActions(false) });
});

app.post('/admin/api/actions', requireAuth, (req, res) => {
  res.json({ action: createAction(normalizeActionInput(req.body as Record<string, unknown>)) });
});

app.put('/admin/api/actions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const updated = updateAction(id, normalizeActionInput(req.body as Record<string, unknown>));
  if (!updated) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  res.json({ action: updated });
});

app.delete('/admin/api/actions/:id', requireAuth, (req, res) => {
  deleteAction(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/admin/api/mcp-servers', requireAuth, (req, res) => {
  res.json({ servers: listMcpServers(false) });
});

app.post('/admin/api/mcp-servers', requireAuth, (req, res) => {
  const server = createMcpServer(normalizeServerInput(req.body as Record<string, unknown>));
  invalidateMcpCache();
  res.json({ server });
});

app.put('/admin/api/mcp-servers/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const updated = updateMcpServer(id, normalizeServerInput(req.body as Record<string, unknown>));
  invalidateMcpCache();
  if (!updated) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  res.json({ server: updated });
});

app.delete('/admin/api/mcp-servers/:id', requireAuth, (req, res) => {
  deleteMcpServer(Number(req.params.id));
  invalidateMcpCache();
  res.json({ ok: true });
});

app.post('/admin/api/mcp-servers/:id/health', requireAuth, async (req, res) => {
  const server = getMcpServer(Number(req.params.id));
  if (!server) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  try {
    const client = createClient(server);
    await client.init();
    const tools = await client.listTools();
    if (typeof client.stop === 'function') client.stop();
    res.json({ ok: true, tools: tools.map((t) => t.name) });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

app.put('/admin/api/prompts/:key', requireAuth, (req, res) => {
  const body = req.body as { content?: string };
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'content erforderlich' });
    return;
  }
  setPrompt(String(req.params.key), body.content);
  res.json({ ok: true });
});

app.get('/admin/api/logs', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  res.json({ logs: listLogs(limit) });
});

app.use('/admin', express.static(join(process.cwd(), 'web')));

app.listen(config.port, () => {
  console.log(`VoiceAssist Gateway auf Port ${config.port}`);
});

if (process.env.LLM_KEEPALIVE_MS !== '0') {
  setInterval(() => {
    chatCompletion([{ role: 'user', content: 'OK' }], undefined, 15000).catch(() => {});
  }, Number(process.env.LLM_KEEPALIVE_MS ?? 120_000)).unref();
}
