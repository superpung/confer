/**
 * Unit tests for core/insights.ts — computeInsights + topN.
 */
import { describe, it, expect } from 'vitest';
import { computeInsights, topN } from './insights';
import type { Paper } from '../scripts/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mkPaper = (id: string, authors: string[], aff: string, tracks: string[]): Paper => ({
  id,
  title: `Paper ${id}`,
  abstract: '',
  authors,
  authorInstitutions: aff,
  tracks,
  eventType: '',
  sessionTitles: [],
  sessions: [],
  dates: [],
  locations: [],
  urls: [],
});

const rows = [
  {
    p: mkPaper('p1', ['Alice Smith', 'Bob Lee'], 'Alice Smith (MIT); Bob Lee (Stanford)', ['testing']),
    v: 'icse2025',
  },
  {
    p: mkPaper('p2', ['Alice Smith', 'Carol Ng'], 'Alice Smith (MIT); Carol Ng (ETH)', ['testing', 'security']),
    v: 'icse2025',
  },
  {
    p: mkPaper('p3', ['Dave Kim'], 'Dave Kim (MIT)', ['security']),
    v: 'fse2025',
  },
];

// ---------------------------------------------------------------------------
// computeInsights
// ---------------------------------------------------------------------------
describe('computeInsights', () => {
  const { instCount, authorCount, trackCount, authorNames } = computeInsights(rows);

  it('counts institutions', () => {
    expect(instCount.get('MIT')).toBe(3);     // Alice p1, Alice p2, Dave p3
    expect(instCount.get('Stanford')).toBe(1);
    expect(instCount.get('ETH')).toBe(1);
  });

  it('counts tracks', () => {
    expect(trackCount.get('testing')).toBe(2);
    expect(trackCount.get('security')).toBe(2);
  });

  it('deduplicates authors per paper (no double-count)', () => {
    // Alice appears in p1 and p2 but is one unique author in each → count = 2
    const aliceKey = [...authorCount.keys()].find((k) =>
      (authorNames.get(k) ?? k).toLowerCase().includes('alice'),
    );
    expect(aliceKey).toBeDefined();
    expect(authorCount.get(aliceKey!)).toBe(2);
  });

  it('records display name for each author key', () => {
    for (const [key, name] of authorNames) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
      // The key for a named author should be their name (or an id if provided)
      expect(authorCount.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// topN
// ---------------------------------------------------------------------------
describe('topN', () => {
  it('returns entries sorted by count descending', () => {
    const counts = new Map([['a', 3], ['b', 5], ['c', 1]]);
    const result = topN(counts, 3);
    expect(result.map((r) => r.name)).toEqual(['b', 'a', 'c']);
    expect(result.map((r) => r.count)).toEqual([5, 3, 1]);
  });

  it('respects the limit', () => {
    const counts = new Map([['a', 3], ['b', 5], ['c', 1], ['d', 4]]);
    expect(topN(counts, 2)).toHaveLength(2);
    expect(topN(counts, 2)[0].name).toBe('b');
  });

  it('breaks ties alphabetically', () => {
    const counts = new Map([['beta', 2], ['alpha', 2]]);
    const result = topN(counts, 2);
    expect(result[0].name).toBe('alpha');
  });
});
