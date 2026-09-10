import { getSetting, listMcpServers } from '../db.js';

export interface HaEntity {
  entity_id: string;
  name: string;
  state: string;
  unit: string;
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

function toEntity(raw: HaStateRaw): HaEntity {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.attributes ?? {})) {
    if (SPEECH_RELEVANT_ATTRS.has(k)) attrs[k] = String(v);
  }
  return {
    entity_id: raw.entity_id,
    name: String(raw.attributes?.friendly_name ?? raw.entity_id),
    state: raw.state,
    unit: String(raw.attributes?.unit_of_measurement ?? ''),
    attributes: attrs,
  };
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
  const raw = (await haRequest<HaStateRaw[]>('/api/states')) ?? [];
  const entities = raw.map(toEntity);
  snapshot = { ts: Date.now(), entities };
  return entities;
}

export function invalidateStatesSnapshot(): void {
  snapshot = null;
}

export async function findEntities(query: string, maxResults = 10): Promise<HaEntity[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];
  const entities = await getStatesSnapshot();
  const scored: { score: number; entity: HaEntity }[] = [];
  for (const entity of entities) {
    let score = 0;
    for (const term of terms) {
      if (entity.name.toLowerCase().includes(term)) score += 2;
      else if (entity.entity_id.toLowerCase().includes(term)) score += 1;
    }
    if (score > 0) scored.push({ score, entity });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.entity);
}

export async function getState(entityId: string): Promise<HaEntity> {
  const entities = await getStatesSnapshot();
  const hit = entities.find((e) => e.entity_id === entityId || e.entity_id.toLowerCase() === entityId.toLowerCase());
  if (hit) return hit;
  const raw = await haRequest<HaStateRaw>(`/api/states/${encodeURIComponent(entityId)}`);
  if (!raw) throw new Error(`Entity ${entityId} nicht gefunden`);
  return toEntity(raw);
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
