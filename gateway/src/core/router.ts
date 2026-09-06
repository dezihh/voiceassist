import type { ParsedAction } from '../types.js';

export interface RouteMatch {
  action: ParsedAction;
  score: number;
  phrase: string;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'´`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 1; i++) out.add(padded.slice(i, i + 2));
  return out;
}

export function similarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size);
}

export function routeAction(
  text: string,
  actions: ParsedAction[],
  fuzzyGlobal: boolean
): RouteMatch | null {
  const query = normalize(text);
  let best: RouteMatch | null = null;
  for (const action of actions) {
    for (const phrase of action.triggers) {
      const target = normalize(phrase);
      if (!target) continue;
      let score = 0;
      if (query === target) score = 1;
      else if (query.includes(target)) score = Math.max(0.95, action.fuzzy_threshold ?? 0);
      else if (fuzzyGlobal) score = similarity(query, target);
      const threshold = action.fuzzy_threshold ?? 0.85;
      if (score >= threshold && (!best || score > best.score)) {
        best = { action, score, phrase };
      }
    }
  }
  return best;
}
