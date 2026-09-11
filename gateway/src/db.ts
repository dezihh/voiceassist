import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import type { ActionMode, ActionRow, McpServerRow, ParsedAction, TraceEvent } from './types.js';

const dbPath = resolve(config.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    auth_token TEXT,
    transport TEXT NOT NULL DEFAULT 'http',
    command TEXT,
    args TEXT,
    env TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'llm' CHECK (mode IN ('deterministic','llm','hybrid')),
    trigger_phrases TEXT,
    fuzzy_threshold REAL,
    system_prompt TEXT,
    template TEXT,
    tools TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    session_id TEXT,
    query TEXT NOT NULL,
    route TEXT NOT NULL,
    action_id INTEGER,
    score REAL,
    response TEXT,
    duration_ms INTEGER,
    trace TEXT
  );
`);

for (const stmt of [
  "ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'http'",
  'ALTER TABLE mcp_servers ADD COLUMN command TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN args TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN env TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    // Spalte existiert bereits
  }
}

db.prepare(
  'INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)'
).run(
  'agent_system',
  `Du bist Smart Pilot, ein deutscher Sprachassistent für Home Assistant über Alexa.

Deine FINALE Antwort (sobald keine Tool-Aufrufe mehr nötig) ist AUSSCHLIESSLICH ein JSON-Objekt: {"needs_clarification": <true|false>, "speech": "<Antwort>", "keep_open": <true|false>}.
Die speech ist kurz, präzise und sprechbar (keine Listen, Zahlen wie "22,4 Grad"). needs_clarification=true nur bei echter Mehrdeutigkeit, dann kurze Rückfrage mit genau einem Antwortbeispiel. keep_open=true nur bei nachfragen-einladenden Antworten (Zusammenfassung, Liste, Bericht). Stelle KEINE Rückfragen wie "Möchtest du mehr erfahren?".
Anreden am Anfang ("Smart Pilot", "Voice Assist") sind kein Teil der Frage. "mehr dazu" bezieht sich auf das letzte Thema.

Tool-Regeln (sparsam: genug gewusst -> sofort antworten):
- Messwerte/Zustände (Temperatur, Füllstand, Verbrauch, an/aus): NIEMALS aus eigenem Wissen. find_ha_entities mit Stichworten - die Treffer enthalten den AKTUELLEN Zustand, antworte damit direkt (bei Thermostaten: Attribut current_temperature). get_ha_state nur für eine konkrete einzelne entity_id.
- Geräte schalten (Licht, Schalter, Rolladen, Klima): entity_id über find_ha_entities ermitteln, dann control_device mit der exakten entity_id.
- Hausstatus: get_house_status, Bericht sinngemäß wiedergeben.
- Benzinpreis: get_fuel_prices.
- Nachrichten/Suche: sofort search_web (time_range "week" bei Nachrichten; bei Finanzquellen gezielt, z. B. "onvista news"). Antworte mit 2-3 konkreten Titeln/Fakten aus den Snippets oder dem Seiteninhalt, niemals nur mit Verweisen.
- web_url_read nur für eine explizit gewünschte konkrete Seite.
- find_ha_entities-Treffer enthalten bereits den aktuellen Zustand: Bei einem plausiblen Treffer SOFORT damit antworten (max. 1 Aufruf pro Anfrage). Keine Variationen desselben Begriffs (z. B. 'aussen' nach 'draussen') - die Suche behandelt das bereits. Kein exakt passender Treffer: nimm den naechstbesten sinnvollen Wert und benenne ihn korrekt (z. B. ' Gefuehlt sind es X Grad'); nur wenn nichts sinnvolles existiert, sag ehrlich, dass nichts gefunden wurde.
- Mehrteilige Antworten (Nachrichten, Listen, mehrere Themen): Trenne logische Teile mit Zeilenumbruechen (\\n\\n) zwischen den Teilen - die werden als Sprechpausen umgesetzt.`
);

db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('warteton', 'phrase');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('fuzzy_global', '1');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('session_followup', '0');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('session_keywords', 'zusammenfassung,neuigkeiten,liste,bericht,news,tipps,hintergründe');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('debug_logging', '0');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('facade_mode', 'facade');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('fuel_sensor', 'sensor.nordoel_sieker_landstrasse_178_super_e10');

for (const action of [
  {
    name: 'benzinpreis',
    triggers: ['benzinpreis', 'tankstelle', 'nordöl', 'sprit', 'super e10'],
    template: `Super E10 bei Nordöl kostet derzeit {{ ha.state('sensor.nordoel_sieker_landstrasse_178_super_e10') | replace('.', ',') }} Euro.`,
  },
  {
    name: 'bmw_netzladung_an',
    triggers: ['bmw netzladung an', 'lade modus netz'],
    template: `{{ ha.call('bmw_netzladung_an') }}`,
  },
  {
    name: 'bmw_netzladung_aus',
    triggers: ['bmw netzladung aus', 'lade modus pv'],
    template: `{{ ha.call('bmw_netzladung_aus') }}`,
  },
]) {
  db.prepare(
    "INSERT OR IGNORE INTO actions (name, mode, trigger_phrases, template) VALUES (?, 'deterministic', ?, ?)"
  ).run(action.name, JSON.stringify(action.triggers), action.template);
}

export function parseAction(row: ActionRow): ParsedAction {
  let triggers: string[] = [];
  try {
    triggers = row.trigger_phrases ? (JSON.parse(row.trigger_phrases) as unknown[]).map(String) : [];
  } catch {
    triggers = [];
  }
  let toolList: string[] | null = null;
  try {
    toolList = row.tools ? (JSON.parse(row.tools) as unknown[]).map(String) : null;
  } catch {
    toolList = null;
  }
  return { ...row, triggers, toolList };
}

export function listActions(enabledOnly: boolean): ParsedAction[] {
  const rows = enabledOnly
    ? (db.prepare('SELECT * FROM actions WHERE enabled = 1').all() as ActionRow[])
    : (db.prepare('SELECT * FROM actions ORDER BY name').all() as ActionRow[]);
  return rows.map(parseAction);
}

export function getAction(id: number): ParsedAction | undefined {
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
  return row ? parseAction(row) : undefined;
}

export function createAction(data: ActionInput): ParsedAction {
  const info = db
    .prepare(
      `INSERT INTO actions (name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, enabled)
       VALUES (@name, @mode, @trigger_phrases, @fuzzy_threshold, @system_prompt, @template, @tools, @enabled)`
    )
    .run(data);
  const row = getAction(Number(info.lastInsertRowid));
  if (!row) throw new Error('Action konnte nicht gelesen werden');
  return row;
}

export function updateAction(id: number, data: ActionInput): ParsedAction | undefined {
  db.prepare(
    `UPDATE actions SET name = @name, mode = @mode, trigger_phrases = @trigger_phrases,
     fuzzy_threshold = @fuzzy_threshold, system_prompt = @system_prompt, template = @template,
     tools = @tools, enabled = @enabled, updated_at = datetime('now')
     WHERE id = @id`
  ).run({ ...data, id });
  return getAction(id);
}

export function deleteAction(id: number): void {
  db.prepare('DELETE FROM actions WHERE id = ?').run(id);
}

export interface McpServerInput {
  name: string;
  url: string;
  auth_token: string | null;
  transport: 'http' | 'stdio';
  command: string | null;
  args: string | null;
  env: string | null;
  enabled: number;
}

export function listMcpServers(enabledOnly: boolean): McpServerRow[] {
  return enabledOnly
    ? (db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all() as McpServerRow[])
    : (db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as McpServerRow[]);
}

export function getMcpServer(id: number): McpServerRow | undefined {
  return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
}

export function createMcpServer(data: McpServerInput): McpServerRow {
  const info = db
    .prepare(
      `INSERT INTO mcp_servers (name, url, auth_token, transport, command, args, env, enabled)
       VALUES (@name, @url, @auth_token, @transport, @command, @args, @env, @enabled)`
    )
    .run(data);
  return getMcpServer(Number(info.lastInsertRowid)) as McpServerRow;
}

export function updateMcpServer(id: number, data: McpServerInput): McpServerRow | undefined {
  db.prepare(
    `UPDATE mcp_servers SET name = @name, url = @url, auth_token = @auth_token, transport = @transport,
     command = @command, args = @args, env = @env, enabled = @enabled WHERE id = @id`
  ).run({ ...data, id });
  return getMcpServer(id);
}

export function deleteMcpServer(id: number): void {
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

export function getSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getPrompt(key: string): string | undefined {
  const row = db.prepare('SELECT content FROM prompts WHERE key = ?').get(key) as
    | { content: string }
    | undefined;
  return row?.content;
}

export function recentAgentTurns(limit = 2): { query: string; response: string }[] {
  const rows = db
    .prepare(
      "SELECT query, response FROM logs WHERE route = 'agent' AND response != '' ORDER BY id DESC LIMIT ?"
    )
    .all(limit) as { query: string; response: string }[];
  return rows.reverse();
}

export function setPrompt(key: string, content: string): void {
  db.prepare(
    'INSERT INTO prompts (key, content) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = datetime(\'now\')'
  ).run(key, content);
}

export function listPrompts(): { key: string; content: string; updated_at: string }[] {
  return db.prepare('SELECT key, content, updated_at FROM prompts ORDER BY key').all() as {
    key: string;
    content: string;
    updated_at: string;
  }[];
}

export interface LogEntry {
  sessionId: string;
  query: string;
  route: string;
  actionId?: number;
  score?: number;
  response: string;
  durationMs: number;
  trace: TraceEvent[];
}

export function addLog(entry: LogEntry): void {
  db.prepare(
    `INSERT INTO logs (session_id, query, route, action_id, score, response, duration_ms, trace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.sessionId,
    entry.query,
    entry.route,
    entry.actionId ?? null,
    entry.score ?? null,
    entry.response,
    entry.durationMs,
    JSON.stringify(entry.trace)
  );
}

export function listLogs(limit: number): Record<string, unknown>[] {
  const rows = db
    .prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...r,
    trace: r.trace ? JSON.parse(r.trace as string) : [],
  }));
}

export interface ActionInput {
  name: string;
  mode: ActionMode;
  trigger_phrases: string;
  fuzzy_threshold: number | null;
  system_prompt: string | null;
  template: string | null;
  tools: string | null;
  enabled: number;
}
