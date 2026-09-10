import type { ToolSpec } from '../llm/client.js';
import type { McpContext } from '../mcp/registry.js';
import { getSetting } from '../db.js';
import { callService, findEntities, getState, type HaEntity } from '../ha/states.js';

export interface FacadeTool {
  name: string;
  description: string;
  parameters: unknown;
  run: (args: Record<string, unknown>, mcp: McpContext) => Promise<unknown>;
}

const ALLOWED_SERVICES: Record<string, string[]> = {
  switch: ['turn_on', 'turn_off', 'toggle'],
  light: ['turn_on', 'turn_off', 'toggle'],
  cover: ['open_cover', 'close_cover', 'stop_cover'],
  fan: ['turn_on', 'turn_off', 'toggle'],
  climate: ['turn_on', 'turn_off', 'toggle', 'set_temperature'],
  script: ['turn_on'],
  automation: ['trigger', 'turn_on', 'turn_off'],
};

function gfmt(value: unknown, decimals = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const fixed = n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
  const [int, frac] = fixed.split('.');
  return [int.replace(/\B(?=(\d{3})+(?!\d))/g, '.'), frac].filter(Boolean).join(',');
}

function findMcpTool(
  mcp: McpContext,
  name: string
): { client: McpContext['servers'][number]['client']; toolName: string } | undefined {
  for (const server of mcp.servers) {
    const tool = server.tools.find((t) => t.name === name);
    if (tool) return { client: server.client, toolName: tool.name };
  }
  return undefined;
}

export async function callMcpToolText(mcp: McpContext, name: string, args: Record<string, unknown>): Promise<string> {
  const found = findMcpTool(mcp, name);
  if (!found) throw new Error(`Tool ${name} auf keinem MCP-Server gefunden`);
  const result = (await found.client.callTool(found.toolName, args)) as unknown;
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown[] }).content)) {
    return ((result as { content: { text?: string }[] }).content ?? [])
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(result ?? '');
}

function asString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function compactEntity(e: HaEntity): Record<string, unknown> {
  const out: Record<string, unknown> = {
    entity_id: e.entity_id,
    name: e.name,
    state: e.state,
  };
  if (e.unit) out.unit = e.unit;
  if (Object.keys(e.attributes).length > 0) out.attributes = e.attributes;
  return out;
}

export const facadeTools: FacadeTool[] = [
  {
    name: 'find_ha_entities',
    description:
      'Findet Home-Assistant-Entities anhand von Stichworten (Friendly Name oder entity_id) und liefert deren AKTUELLEN Zustand gleich mit. IMMER zuerst bei Fragen zu Temperatur, Verbrauch, Sensorwerten, Status von Geraeten oder Raeumen; bei Thermostaten steht die Raumtemperatur im Attribut current_temperature. Aus den Treffern kannst du meist direkt antworten.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: "Stichwoerter, z. B. 'Schlafzimmer Temperatur' oder 'Zisterne'" } },
      required: ['query'],
    },
    run: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return { error: "Parameter 'query' erforderlich." };
      const results = await findEntities(query, 8);
      return { results: results.map(compactEntity) };
    },
  },
  {
    name: 'get_ha_state',
    description:
      'Liest den aktuellen Zustand einer konkreten Home-Assistant-Entity per entity_id (z. B. sensor.schlafzimmer_temperature) und dessen sprechrelevanten Attribute.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string', description: "z. B. 'sensor.schlafzimmer_temperature'" } },
      required: ['entity_id'],
    },
    run: async (args) => {
      const entityId = String(args.entity_id ?? '').trim();
      if (!entityId) return { error: 'entity_id erforderlich.' };
      return compactEntity(await getState(entityId));
    },
  },
  {
    name: 'control_device',
    description:
      'Schaltet, dimmt oder bewegt Home-Assistant-Geraete (Licht, Schalter, Rolladen, Klima). entity_id muss exakt sein (zuerst find_ha_entities nutzen).',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: "z. B. 'light.wohnzimmer'" },
        action: {
          type: 'string',
          enum: ['turn_on', 'turn_off', 'toggle', 'open_cover', 'close_cover', 'stop_cover', 'set_temperature'],
        },
        temperature: { type: 'number', description: 'Nur fuer set_temperature: Zieltemperatur in Grad' },
      },
      required: ['entity_id', 'action'],
    },
    run: async (args) => {
      const entityId = String(args.entity_id ?? '').trim();
      const action = String(args.action ?? '').trim();
      const domain = entityId.split('.')[0] ?? '';
      if (!entityId.includes('.')) return { error: "Ungueltige entity_id, erwartet z. B. 'light.wohnzimmer'." };
      if (!(domain in ALLOWED_SERVICES)) return { error: `Domain '${domain}' ist fuer Sprachsteuerung nicht erlaubt.` };
      if (!ALLOWED_SERVICES[domain]?.includes(action)) {
        return { error: `Aktion '${action}' fuer ${domain} nicht erlaubt.` };
      }
      const data: Record<string, unknown> = { entity_id: entityId };
      if (action === 'set_temperature' && args.temperature !== undefined) {
        data.temperature = Number(args.temperature);
      }
      await callService(domain, action, data);
      return { success: true, message: `${action} auf ${entityId} ausgefuehrt.` };
    },
  },
  {
    name: 'search_web',
    description:
      'Websuche ueber SearXNG fuer aktuelle Informationen (Nachrichten, Kurse, Wetter). Liefert Snippets plus den extrahierten Text des ersten Treffers. Hoechstens ein Aufruf pro Frage.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Suchbegriff, z. B. 'neuigkeiten e-mobilitaet' oder 'DAX Stand heute'" },
        time_range: { type: 'string', enum: ['day', 'week', 'month'], description: "optional, z. B. 'week' fuer Nachrichten" },
      },
      required: ['query'],
    },
    run: async (args, mcp) => {
      const query = String(args.query ?? '').trim();
      if (!query) return { error: 'query erforderlich.' };
      const searchArgs: Record<string, unknown> = { query, language: 'de', num_results: 5 };
      if (typeof args.time_range === 'string' && args.time_range) searchArgs.time_range = args.time_range;
      const raw = await callMcpToolText(mcp, 'searxng_web_search', searchArgs);
      let snippets: string[] = [];
      let firstUrl = '';
      try {
        const parsed = JSON.parse(raw) as { results?: { url?: string; title?: string; content?: string }[] };
        for (const item of parsed.results ?? []) {
          const title = (item?.title ?? '').trim();
          const content = (item?.content ?? '').trim();
          if (title || content) snippets.push(`${title}: ${content}`);
          if (!firstUrl && typeof item?.url === 'string' && item.url.startsWith('http')) firstUrl = item.url;
        }
      } catch {
        snippets = [raw.slice(0, 1200)];
      }
      let fetched = '';
      if (firstUrl) {
        try {
          fetched = await callMcpToolText(mcp, 'web_url_read', { url: firstUrl });
        } catch {
          fetched = '';
        }
      }
      return {
        snippets: snippets.slice(0, 5).join('\n').slice(0, 1200),
        ...(firstUrl ? { erster_treffer: firstUrl } : {}),
        ...(fetched ? { seiteninhalt: fetched.slice(0, 1600) } : {}),
      };
    },
  },
  {
    name: 'web_url_read',
    description: 'Liest den Textinhalt einer konkreten URL (Artikel, News-Seite).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    run: async (args, mcp) => {
      const url = String(args.url ?? '').trim();
      if (!url.startsWith('http')) return { error: 'gueltige URL erforderlich.' };
      return { inhalt: (await callMcpToolText(mcp, 'web_url_read', { url })).slice(0, 1800) };
    },
  },
  {
    name: 'get_house_status',
    description: 'Erstellt einen umfassenden Hausstatus-Bericht (Akkustand, Verbrauch, Solar, Benzinpreis).',
    parameters: { type: 'object', properties: {} },
    run: async (_args, mcp) => {
      const text = await callMcpToolText(mcp, 'hausstatus', {});
      return { bericht: text.slice(0, 1800) };
    },
  },
  {
    name: 'get_fuel_prices',
    description: 'Liest den aktuellen Benzinpreis bei Nordoel (Super E10).',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const entityId = getSetting('fuel_sensor') ?? 'sensor.nordoel_sieker_landstrasse_178_super_e10';
      const entity = await getState(entityId);
      if (['unknown', 'unavailable', ''].includes(entity.state)) {
        return { error: 'Der aktuelle Benzinpreis ist leider nicht verfuegbar.' };
      }
      return { antwort: `Super E10 bei Nordoel kostet derzeit ${gfmt(entity.state, 3)} Euro.` };
    },
  },
];

