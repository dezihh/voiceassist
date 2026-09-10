import { getSetting, listMcpServers } from '../db.js';

export interface HaEntity {
  entity_id: string;
  name: string;
  state: string;
  unit: string;
  area: string;
  attributes: Record<string, string>;
}

const SPEECH_RELEVANT_ATTRS = new Set([
  'current_temperature',
  'target_temperature',
  'temperature',
  'humidity',
  'brightness',
  'position',
  'battery_level',
  'unit_of_measurement',
  'friendly_name',
  'hvac_mode',
  'fan_mode',
  'device_class',
]);

const SNAPSHOT_TTL_MS = 60_000;

const TERM_ALIASES: Record<string, string> = {
  draussen: 'aussen',
  drausen: 'aussen',
};

const METRIC_DOMAIN_HINTS: { re: RegExp; domains: string[] }[] = [
  { re: /temperatur|warm|kalt|grad/, domains: ['sensor', 'climate', 'weather'] },
  { re: /feucht/, domains: ['sensor'] },
  { re: /verbrauch|leistung|energie|strom|kwh|watt/, domains: ['sensor'] },
  { re: /fullstand|zisterne|tank/, domains: ['sensor'] },
  { re: /licht|lampe|leuchte/, domains: ['light'] },
  { re: /steckdose|schalter/, domains: ['switch', 'light'] },
  { re: /rolladen|raffstore|jalousie/, domains: ['cover'] },
  { re: /thermostat|heizung|heizen/, domains: ['climate'] },
  { re: /lautsta|musik|radio|sprecher/, domains: ['media_player'] },
];

const STOPWORDS = new Set([
  'wie', 'ist', 'es', 'im', 'in', 'der', 'den', 'das', 'die', 'von', 'am', 'an', 'um',
  'mein', 'meine', 'mir', 'bitte', 'sag', 'mal', 'derzeit', 'aktuell', 'aktuelle',
  'gibt', 'gib', 'mir', 'den', 'dem', 'eine', 'einen', 'und', 'oder', 'für', 'mit',
]);

let snapshot: { ts: number; entities: HaEntity[] } | null = null;

interface HaConfig {
  base: string;
  token: string;
}

function resolveHaConfig(): HaConfig {
  const settingBase = getSetting('ha_rest_base');
  const settingToken = getSetting('ha_rest_token');
  if (settingBase && settingToken) return { base: settingBase.replace(/\/+$/, ''), token: settingToken };
  const row = listMcpServers(true).find((s) => s.transport === 'http' && s.url.includes('/api/mcp'));
  if (!row || !row.auth_token) throw new Error('kein Home-Assistant-Zugang konfiguriert');
  return { base: row.url.replace(/\/api\/mcp\/?$/, ''), token: row.auth_token };
}

interface HaStateRaw {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

function toEntity(raw: HaStateRaw, area: string): HaEntity {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.attributes ?? {})) {
    if (SPEECH_RELEVANT_ATTRS.has(k)) attrs[k] = String(v);
  }
  return {
    entity_id: raw.entity_id,
    name: String(raw.attributes?.friendly_name ?? raw.entity_id),
    state: raw.state,
    unit: String(raw.attributes?.unit_of_measurement ?? ''),
    area,
    attributes: attrs,
  };
}

async function fetchAreas(): Promise<Map<string, string>> {
  const { base, token } = resolveHaConfig();
  const template =
    '{% for e in states %}{{ e.entity_id }}|{{ area_name(e.entity_id) }}\n{% endfor %}';
  const res = await fetch(`${base}/api/template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ template }),
    signal: AbortSignal.timeout(10_000),
  });
  const map = new Map<string, string>();
  if (!res.ok) return map;
  const text = await res.text();
  for (const line of text.split('\n')) {
    const sep = line.indexOf('|');
    if (sep > 0) {
      const entityId = line.slice(0, sep).trim();
      const area = line.slice(sep + 1).trim();
      if (entityId && area) map.set(entityId, area);
    }
  }
  return map;
}

async function haRequest<T>(path: string): Promise<T> {
  const { base, token } = resolveHaConfig();
  const res = await fetch(`${base}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HA ${res.status}: ${path}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function getStatesSnapshot(force = false): Promise<HaEntity[]> {
  if (!force && snapshot && Date.now() - snapshot.ts < SNAPSHOT_TTL_MS) return snapshot.entities;
  const [raw, areas] = await Promise.all([
    haRequest<HaStateRaw[]>('/api/states').catch(() => [] as HaStateRaw[]),
    fetchAreas().catch(() => new Map<string, string>()),
  ]);
  const entities = raw.map((r) => toEntity(r, areas.get(r.entity_id) ?? ''));
  snapshot = { ts: Date.now(), entities };
  return entities;
}

export function invalidateStatesSnapshot(): void {
  snapshot = null;
}

function tokensOf(text: string): string[] {
  return text.split(/[^a-z0-9äöüß]+/).filter(Boolean);
}

export async function findEntities(query: string, maxResults = 10): Promise<HaEntity[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => TERM_ALIASES[fold(t)] ?? fold(t))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (terms.length === 0) return [];
  const entities = await getStatesSnapshot();
  const metricDomains = new Set<string>();
  for (const hint of METRIC_DOMAIN_HINTS) {
    if (terms.some((t) => hint.re.test(t))) {
      for (const d of hint.domains) metricDomains.add(d);
    }
  }
  const wantsTemperature = terms.some((t) => /temperatur|warm|kalt|grad/.test(t));
  const wantsHumidity = terms.some((t) => /feucht/.test(t));
  const scored: { score: number; entity: HaEntity }[] = [];
  for (const entity of entities) {
    let score = 0;
    const nameLower = fold(entity.name);
    const nameTokens = nameLower.split(/[^a-z0-9]+/).filter(Boolean);
    const idTokens = entity.entity_id.toLowerCase().split(/[._-]+/).filter(Boolean).map(fold);
    const areaTokens = fold(entity.area).split(/\s+/).filter(Boolean);
    for (const term of terms) {
      if (nameTokens.includes(term)) score += 3;
      else if (nameLower.includes(term)) score += 1;
      if (idTokens.includes(term)) score += 2;
      if (areaTokens.includes(term)) score += 2;
      for (const token of nameTokens) {
        if (token.length >= 4 && term.includes(token)) {
          score += 2;
          break;
        }
      }
      for (const token of idTokens) {
        if (token.length >= 4 && token.length < term.length && term.includes(token)) {
          score += 1;
          break;
        }
      }
    }
    if (metricDomains.has(entity.entity_id.split('.')[0])) score += 2;
    if (wantsTemperature && (entity.attributes.device_class === 'temperature' || 'current_temperature' in entity.attributes)) {
      score += 4;
    }
    if (wantsTemperature && entity.entity_id.startsWith('weather.')) score += 5;
    if (wantsHumidity && (entity.attributes.device_class === 'humidity' || 'humidity' in entity.attributes)) {
      score += 3;
    }
    if (score > 0) scored.push({ score, entity });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.entity);
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss');
}

export async function getState(entityId: string): Promise<HaEntity> {
  const entities = await getStatesSnapshot();
  const hit = entities.find((e) => e.entity_id === entityId || e.entity_id.toLowerCase() === entityId.toLowerCase());
  if (hit) return hit;
  const raw = await haRequest<HaStateRaw>(`/api/states/${encodeURIComponent(entityId)}`);
  if (!raw) throw new Error(`Entity ${entityId} nicht gefunden`);
  return toEntity(raw, '');
}

export async function callService(
  domain: string,
  service: string,
  data: Record<string, unknown>
): Promise<unknown> {
  const { base, token } = resolveHaConfig();
  const res = await fetch(`${base}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10),
  });
  if (!res.ok) throw new Error(`HA ${res.status}: ${domain}.${service}`);
  const out = await res.json();
  invalidateStatesSnapshot();
  return out;
}
