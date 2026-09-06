import express from 'express';
import { join } from 'node:path';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { processQuery } from './core/engine.js';
import { fromAssistantResponse, toVoiceQuery } from './adapters/alexa.js';
import { McpClient } from './mcp/client.js';
import { invalidateMcpCache } from './mcp/registry.js';
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
  type ActionInput,
  type McpServerInput,
} from './db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

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
  const url = String(body.url ?? '').trim();
  if (!name || !url) throw new Error('name und url sind erforderlich');
  return {
    name,
    url,
    auth_token: body.auth_token ? String(body.auth_token) : null,
    enabled: body.enabled === false ? 0 : 1,
  };
}

app.post('/alexa', requireAuth, async (req, res) => {
  const query = toVoiceQuery(req.body as Record<string, never>);
  const result = await processQuery(query);
  res.json(fromAssistantResponse(result.response));
});

app.post('/api/query', requireAuth, async (req, res) => {
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
});

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
    const client = new McpClient(server.url, server.auth_token);
    await client.init();
    const tools = await client.listTools();
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
