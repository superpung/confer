/**
 * Top-entity tallies for the Insights rail — no DOM, no state.
 * Shared between the browser client island and the MCP server.
 */
import type { Paper } from '../scripts/types';
import { instList, authorResolver } from './text';

export interface InsightsData {
  /** Institution name → paper count. */
  instCount: Map<string, number>;
  /** Disambiguated author key → paper count. */
  authorCount: Map<string, number>;
  /** Track name → paper count. */
  trackCount: Map<string, number>;
  /** Disambiguated author key → longest display name seen. */
  authorNames: Map<string, string>;
}

/** Compute top-entity tallies over a set of paper rows.
 *  Author disambiguation reuses the ORCID/OpenAlex resolver so co-author
 *  network clicks and the author-detail view stay consistent. */
export function computeInsights(rows: { p: Paper; v: string }[]): InsightsData {
  const instCount = new Map<string, number>();
  const authorCount = new Map<string, number>();
  const trackCount = new Map<string, number>();
  const authorNames = new Map<string, string>();
  const resolve = authorResolver(rows);

  for (const { p } of rows) {
    for (const inst of instList(p)) {
      instCount.set(inst, (instCount.get(inst) ?? 0) + 1);
    }
    const seen = new Set<string>();
    p.authors.forEach((_, i) => {
      const { key, name } = resolve(p, i);
      if (seen.has(key)) return;
      seen.add(key);
      authorCount.set(key, (authorCount.get(key) ?? 0) + 1);
      const cur = authorNames.get(key);
      if (!cur || name.length > cur.length) authorNames.set(key, name);
    });
    for (const t of new Set(p.tracks)) {
      trackCount.set(t, (trackCount.get(t) ?? 0) + 1);
    }
  }

  return { instCount, authorCount, trackCount, authorNames };
}

/** Return the top-n entries from a count Map, sorted descending. */
export function topN(counts: Map<string, number>, n: number): { name: string; count: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}
