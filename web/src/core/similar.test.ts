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
