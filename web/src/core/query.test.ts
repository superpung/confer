/**
 * Unit tests for core/query.ts — parseQuery + matchQuery.
 * Run with:  cd web && npm run test
 */
import { describe, it, expect } from 'vitest';
import { parseQuery, matchQuery } from './query';
import type { Paper, Venue } from '../scripts/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mkPaper = (overrides: Partial<Paper> = {}): Paper => ({
  id: 'p1',
  title: 'Neural Networks for Code Analysis',
  abstract: 'We present a deep learning approach to static analysis.',
  authors: ['Alice Smith', 'Bob Lee'],
  authorInstitutions: 'Alice Smith (MIT); Bob Lee (Stanford)',
  tracks: ['machine-learning', 'testing'],
  eventType: 'Research Paper',
  sessionTitles: [],
  sessions: [],
  dates: [],
  locations: [],
  urls: ['https://example.com'],
  doi: '10.1145/test.123',
  keywords: ['neural network', 'static analysis'],
  ...overrides,
});

const mkVenue = (overrides: Partial<Venue> = {}): Venue => ({
  id: 'icse2025',
  name: 'ICSE 2025',
  series: 'ICSE',
  category: 'Software Engineering',
  year: 2025,
  kind: 'conference',
  count: 500,
  ...overrides,
});

const VENUE_MAP = new Map<string, Venue>([['icse2025', mkVenue()]]);

const ctx = {
  venueById: (id: string) => VENUE_MAP.get(id),
};

const ctxWithTags = (tagMap: Record<string, string[]>) => ({
  venueById: (id: string) => VENUE_MAP.get(id),
  tagsOf: (key: string) => tagMap[key] ?? [],
});

const row = (overrides?: Partial<Paper>) => ({ p: mkPaper(overrides), v: 'icse2025' });

// ---------------------------------------------------------------------------
// parseQuery
// ---------------------------------------------------------------------------
describe('parseQuery', () => {
  it('parses bare words as any-field terms', () => {
    const terms = parseQuery('neural code');
    expect(terms).toEqual([
      { field: 'any', value: 'neural', neg: false },
      { field: 'any', value: 'code', neg: false },
    ]);
  });

  it('recognises field prefixes', () => {
    const terms = parseQuery('author:smith title:neural');
    expect(terms[0]).toMatchObject({ field: 'author', value: 'smith' });
    expect(terms[1]).toMatchObject({ field: 'title', value: 'neural' });
  });

  it('resolves field aliases', () => {
    const terms = parseQuery('au:smith t:neural inst:mit');
    expect(terms[0].field).toBe('author');
    expect(terms[1].field).toBe('title');
    expect(terms[2].field).toBe('inst');
  });

  it('handles quoted phrases', () => {
    const terms = parseQuery('"deep learning"');
    expect(terms[0]).toMatchObject({ field: 'any', value: 'deep learning' });
  });

  it('handles field:quoted phrase', () => {
    const terms = parseQuery('title:"code review"');
    expect(terms[0]).toMatchObject({ field: 'title', value: 'code review' });
  });

  it('handles negation', () => {
    const terms = parseQuery('-author:jones -"demo paper"');
    expect(terms[0]).toMatchObject({ field: 'author', value: 'jones', neg: true });
    expect(terms[1]).toMatchObject({ field: 'any', value: 'demo paper', neg: true });
  });

  it('returns empty array for empty input', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// matchQuery — field matching
// ---------------------------------------------------------------------------
describe('matchQuery', () => {
  it('empty terms matches anything', () => {
    expect(matchQuery(row(), [], ctx)).toBe(true);
  });

  it('any-field: matches against title', () => {
    expect(matchQuery(row(), parseQuery('neural'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('quantum'), ctx)).toBe(false);
  });

  it('any-field: matches against abstract', () => {
    expect(matchQuery(row(), parseQuery('static analysis'), ctx)).toBe(true);
  });

  it('any-field: matches venue name', () => {
    expect(matchQuery(row(), parseQuery('icse'), ctx)).toBe(true);
  });

  it('title field', () => {
    expect(matchQuery(row(), parseQuery('title:neural'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('title:smith'), ctx)).toBe(false);
  });

  it('author field', () => {
    expect(matchQuery(row(), parseQuery('author:smith'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('author:jones'), ctx)).toBe(false);
  });

  it('inst field (parsed from authorInstitutions)', () => {
    expect(matchQuery(row(), parseQuery('inst:mit'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('inst:caltech'), ctx)).toBe(false);
  });

  it('track field', () => {
    expect(matchQuery(row(), parseQuery('track:testing'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('track:security'), ctx)).toBe(false);
  });

  it('venue field — matches name and series', () => {
    expect(matchQuery(row(), parseQuery('venue:icse'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('venue:ICSE'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('venue:nips'), ctx)).toBe(false);
  });

  it('year field — matches venue year', () => {
    expect(matchQuery(row(), parseQuery('year:2025'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:2024'), ctx)).toBe(false);
  });

  it('keyword field', () => {
    expect(matchQuery(row(), parseQuery('keyword:fuzzing'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('keyword:neural'), ctx)).toBe(true);
  });

  it('doi field', () => {
    expect(matchQuery(row(), parseQuery('doi:10.1145'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('doi:9999'), ctx)).toBe(false);
  });

  it('negation — -author:jones matches (jones absent)', () => {
    expect(matchQuery(row(), parseQuery('-author:jones'), ctx)).toBe(true);
  });

  it('negation — -author:smith does not match (smith present)', () => {
    expect(matchQuery(row(), parseQuery('-author:smith'), ctx)).toBe(false);
  });

  it('AND semantics — all terms must match', () => {
    expect(matchQuery(row(), parseQuery('author:smith track:testing'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('author:smith track:security'), ctx)).toBe(false);
  });

  // ----- tag: regression guard -----------------------------------------
  // Original bug: the facetBase matchQuery call omitted tagsOf, so tag: always
  // returned '' regardless of the user's actual tags. This guard locks it.
  it('tag: with tagsOf resolves correctly', () => {
    const tagCtx = ctxWithTags({ 'icse2025:p1': ['read-later', 'important'] });
    expect(matchQuery(row(), parseQuery('tag:important'), tagCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('tag:boring'), tagCtx)).toBe(false);
  });

  it('tag: without tagsOf (MCP context) no-ops — never matches', () => {
    // tagsOf absent → tag: field returns '' → match fails, so tag: is effectively
    // ignored in a context that has no tag store. This is the intended MCP behaviour.
    expect(matchQuery(row(), parseQuery('tag:important'), ctx)).toBe(false);
  });
});
