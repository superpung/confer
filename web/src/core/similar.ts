/**
 * TF-IDF similarity index — no DOM, no state, no monkey-patching of Paper.
 * Shared between the browser client island and the MCP server.
 */
import type { Paper } from '../scripts/types';
import { tfidfTokenize, paperKey } from './text';

export interface TfidfIndex {
  /** Top-n papers most similar to the target key (venue:id). */
  similar(targetKey: string, n?: number): { key: string; p: Paper; v: string; score: number }[];
  /** Top-n recommendations given an iterable of seed paper keys. */
  recommend(profileKeys: Iterable<string>, n?: number): { key: string; p: Paper; v: string; score: number }[];
}

/** Build a TF-IDF index over a set of rows.  O(N·V) time/space (N papers, V vocab).
 *  Call once per corpus snapshot; discard and rebuild when the corpus changes. */
export function buildTfidfIndex(rows: { p: Paper; v: string }[]): TfidfIndex {
  const docCount = rows.length;
  const rowByKey = new Map<string, { p: Paper; v: string }>();
  const df = new Map<string, number>();

  for (const row of rows) {
    const k = paperKey(row.v, row.p.id);
    rowByKey.set(k, row);
    const focused = `${row.p.title} ${row.p.abstract} ${(row.p.keywords ?? []).join(' ')} ${row.p.tracks.join(' ')}`;
    for (const t of new Set(tfidfTokenize(focused))) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  // IDF: log(N / df) with add-1 smoothing.
  const idf = new Map([...df.entries()].map(([t, d]) => [t, Math.log((docCount + 1) / (d + 1))]));

  // Per-paper L2-normalised TF-IDF vectors, stored by paper key.
  const vecs = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const k = paperKey(row.v, row.p.id);
    const focused = `${row.p.title} ${row.p.abstract} ${(row.p.keywords ?? []).join(' ')} ${row.p.tracks.join(' ')}`;
    const tokens = tfidfTokenize(focused);
    if (!tokens.length) { vecs.set(k, new Map()); continue; }
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (c / tokens.length) * (idf.get(t) ?? 0);
      if (w > 0) { vec.set(t, w); norm += w * w; }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    vecs.set(k, vec);
  }

  /** Dot product of two L2-normalised sparse vectors = cosine similarity. */
  function cosine(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    for (const [t, w] of a) { const bw = b.get(t); if (bw) dot += w * bw; }
    return dot;
  }

  return {
    similar(targetKey, n = 10) {
      const vec = vecs.get(targetKey);
      if (!vec || !vec.size) return [];
      return [...rowByKey.entries()]
        .filter(([k]) => k !== targetKey)
        .map(([k, row]) => ({ key: k, ...row, score: cosine(vec, vecs.get(k) ?? new Map()) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .filter((x) => x.score > 0);
    },

    recommend(profileKeys, n = 10) {
      const profileSet = new Set(profileKeys);
      const profile = new Map<string, number>();
      let savedCount = 0;
      for (const k of profileSet) {
        const vec = vecs.get(k);
        if (!vec) continue;
        for (const [t, w] of vec) profile.set(t, (profile.get(t) ?? 0) + w);
        savedCount++;
      }
      if (!savedCount) return [];
      // Normalise the averaged profile vector.
      for (const [t, w] of profile) profile.set(t, w / savedCount);
      let pnorm = 0;
      for (const w of profile.values()) pnorm += w * w;
      pnorm = Math.sqrt(pnorm) || 1;
      for (const [t, w] of profile) profile.set(t, w / pnorm);
      return [...rowByKey.entries()]
        .filter(([k]) => !profileSet.has(k))
        .map(([k, row]) => ({ key: k, ...row, score: cosine(profile, vecs.get(k) ?? new Map()) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .filter((x) => x.score > 0);
    },
  };
}
