/**
 * Unit tests for core/similar.ts — buildTfidfIndex.
 */
import { describe, it, expect } from 'vitest';
import { buildTfidfIndex } from './similar';
import { paperKey } from './text';
import type { Paper } from '../scripts/types';

// ---------------------------------------------------------------------------
// Minimal Paper fixture factory (only TF-IDF-relevant fields needed)
// ---------------------------------------------------------------------------
const mkPaper = (
  id: string,
  title: string,
  abstract: string,
  keywords: string[] = [],
  tracks: string[] = [],
): Paper => ({
  id,
  title,
  abstract,
  authors: [],
  authorInstitutions: '',
  tracks,
  eventType: '',
  sessionTitles: [],
  sessions: [],
  dates: [],
  locations: [],
  urls: [],
  keywords,
});

// Three papers: A and B are about ML; C is about databases.
const A = mkPaper('a', 'Deep Learning for Image Recognition', 'Convolutional neural networks for recognition', ['deep learning', 'image recognition'], ['ml']);
const B = mkPaper('b', 'Transfer Learning Approaches', 'Neural network transfer learning fine-tuning', ['transfer learning', 'neural networks'], ['ml']);
const C = mkPaper('c', 'Query Optimisation in Relational Databases', 'SQL join ordering cost model query planner', ['database', 'sql'], ['db']);

const rows = [
  { p: A, v: 'conf2025' },
  { p: B, v: 'conf2025' },
  { p: C, v: 'conf2025' },
];

const keyA = paperKey('conf2025', 'a');
const keyB = paperKey('conf2025', 'b');
const keyC = paperKey('conf2025', 'c');

// ---------------------------------------------------------------------------
// similar
// ---------------------------------------------------------------------------
describe('buildTfidfIndex.similar', () => {
  const idx = buildTfidfIndex(rows);

  it('similar(A) returns B (related) and excludes C (unrelated, score=0)', () => {
    const results = idx.similar(keyA, 5);
    expect(results.length).toBeGreaterThan(0);
    const keys = results.map((r) => r.key);
    // B shares neural/learning vocabulary with A → appears in results
    expect(keys).toContain(keyB);
    // C (databases/SQL) shares nothing with A after stop-word removal → score=0, filtered out
    expect(keys).not.toContain(keyC);
  });

  it('similar returns positive scores', () => {
    const results = idx.similar(keyA, 5);
    for (const r of results) expect(r.score).toBeGreaterThan(0);
  });

  it('similar does not include the target itself', () => {
    const results = idx.similar(keyA, 5);
    expect(results.map((r) => r.key)).not.toContain(keyA);
  });

  it('similar for an unknown key returns empty', () => {
    expect(idx.similar('conf2025:nonexistent', 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------
describe('buildTfidfIndex.recommend', () => {
  const idx = buildTfidfIndex(rows);

  it('recommend from A as seed returns B (related) and excludes C (score=0)', () => {
    const results = idx.recommend([keyA], 5);
    const keys = results.map((r) => r.key);
    expect(keys).not.toContain(keyA);
    // B shares vocabulary with A's profile → ranked highest
    expect(keys).toContain(keyB);
    // C shares nothing → score=0, filtered out
    expect(keys).not.toContain(keyC);
  });

  it('recommend excludes all seed papers', () => {
    const results = idx.recommend([keyA, keyB], 5);
    const keys = results.map((r) => r.key);
    expect(keys).not.toContain(keyA);
    expect(keys).not.toContain(keyB);
  });

  it('recommend from unknown seeds returns empty', () => {
    expect(idx.recommend(['conf2025:ghost'], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// similarScoreMap
// ---------------------------------------------------------------------------
describe('buildTfidfIndex.similarScoreMap', () => {
  const idx = buildTfidfIndex(rows);

  it('returns a non-empty map for a known key with similar papers', () => {
    const m = idx.similarScoreMap(keyA);
    expect(m.size).toBeGreaterThan(0);
    // A and B are related — B should appear in the map
    expect(m.has(keyB)).toBe(true);
  });

  it('returns positive scores for related papers', () => {
    const m = idx.similarScoreMap(keyA);
    for (const score of m.values()) expect(score).toBeGreaterThan(0);
  });

  it('does not include the target key itself', () => {
    const m = idx.similarScoreMap(keyA);
    expect(m.has(keyA)).toBe(false);
  });

  it('unrelated paper (C) not in map when score < minScore threshold', () => {
    const m = idx.similarScoreMap(keyA, 0.05);
    // C shares no meaningful vocabulary with A → score very low (expected 0 or below threshold)
    const scoreC = m.get(keyC) ?? 0;
    expect(scoreC).toBeLessThan(0.05);
  });

  it('returns empty map for unknown key', () => {
    const m = idx.similarScoreMap('conf2025:ghost');
    expect(m.size).toBe(0);
  });

  it('minScore=0 includes all non-target papers with non-zero score', () => {
    const m = idx.similarScoreMap(keyA, 0);
    // With minScore=0, B should definitely be in the map
    expect(m.has(keyB)).toBe(true);
  });

  it('score for B is consistent with similar()', () => {
    const m = idx.similarScoreMap(keyA, 0);
    const simResults = idx.similar(keyA, 10);
    const simBScore = simResults.find((r) => r.key === keyB)?.score;
    const mapBScore = m.get(keyB);
    // Both methods should give the same cosine score
    expect(mapBScore).toBeCloseTo(simBScore ?? 0, 10);
  });
});

// ---------------------------------------------------------------------------
// similarSet
// ---------------------------------------------------------------------------
describe('buildTfidfIndex.similarSet', () => {
  const idx = buildTfidfIndex(rows);

  it('contains B for target A (related papers)', () => {
    const s = idx.similarSet(keyA, 0.01);
    expect(s.has(keyB)).toBe(true);
  });

  it('does not contain target itself', () => {
    const s = idx.similarSet(keyA);
    expect(s.has(keyA)).toBe(false);
  });

  it('returns empty set for unknown key', () => {
    const s = idx.similarSet('conf2025:ghost');
    expect(s.size).toBe(0);
  });
});
