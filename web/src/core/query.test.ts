/**
 * Unit tests for core/query.ts — parseQuery + matchQuery.
 * Run with:  cd web && npm run test
 */
import { describe, it, expect } from 'vitest';
import { parseQuery, matchQuery, countOcc, relevanceScore, abstractSnippet } from './query';
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

const ctxWithStatus = (statusMap: Record<string, string>) => ({
  venueById: (id: string) => VENUE_MAP.get(id),
  statusOf: (key: string) => statusMap[key] ?? 'unread',
});

const ctxWithNotes = (noteMap: Record<string, string>) => ({
  venueById: (id: string) => VENUE_MAP.get(id),
  noteOf: (key: string) => noteMap[key] ?? '',
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

  it('year field — exact match', () => {
    expect(matchQuery(row(), parseQuery('year:2025'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:2024'), ctx)).toBe(false);
  });

  it('year field — range 2023-2026 includes 2025', () => {
    expect(matchQuery(row(), parseQuery('year:2023-2026'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:2023-2024'), ctx)).toBe(false);
  });

  it('year field — >= comparison', () => {
    expect(matchQuery(row(), parseQuery('year:>=2025'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:>=2026'), ctx)).toBe(false);
  });

  it('year field — <= comparison', () => {
    expect(matchQuery(row(), parseQuery('year:<=2025'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:<=2024'), ctx)).toBe(false);
  });

  it('year field — > and < comparisons', () => {
    expect(matchQuery(row(), parseQuery('year:>2024'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:>2025'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('year:<2026'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:<2025'), ctx)).toBe(false);
  });

  it('keyword field', () => {
    expect(matchQuery(row(), parseQuery('keyword:fuzzing'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('keyword:neural'), ctx)).toBe(true);
  });

  it('doi field', () => {
    expect(matchQuery(row(), parseQuery('doi:10.1145'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('doi:9999'), ctx)).toBe(false);
  });

  it('category: — matches venue category (partial match)', () => {
    // Default fixture venue: category = 'Software Engineering'
    expect(matchQuery(row(), parseQuery('category:software'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('category:NLP'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-category:NLP'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('cat:engineering'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('category:software|nlp'), ctx)).toBe(true);
    // With a different venue category
    const nlpVenueMap = new Map([['icse2025', mkVenue({ category: 'Natural Language Processing' })]]);
    const nlpCtx = { venueById: (id: string) => nlpVenueMap.get(id) };
    expect(matchQuery(row(), parseQuery('category:natural'), nlpCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('category:language'), nlpCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('category:software'), nlpCtx)).toBe(false);
  });

  it('recent: — matches papers within last N years', () => {
    // Default fixture venue year is 2025
    const recentCtx = { venueById: (id: string) => VENUE_MAP.get(id), currentYear: 2026 };
    // recent:2 → cutoff 2024 → year 2025 >= 2024 ✓
    expect(matchQuery(row(), parseQuery('recent:2'), recentCtx)).toBe(true);
    // recent:0 → n=0 → no-op (continue), treated as pass
    expect(matchQuery(row(), parseQuery('recent:0'), recentCtx)).toBe(true);
    // recent:1 → cutoff 2025 → year 2025 >= 2025 ✓
    expect(matchQuery(row(), parseQuery('recent:1'), recentCtx)).toBe(true);
    // Negation: -recent:1 → year 2025 >= 2025 is true → neg → false
    expect(matchQuery(row(), parseQuery('-recent:1'), recentCtx)).toBe(false);
    // Old year: year 2020, recent:3 → cutoff 2023 → 2020 < 2023 ✗
    const oldVenueMap = new Map([['icse2025', mkVenue({ year: 2020 })]]);
    const oldCtx = { venueById: (id: string) => oldVenueMap.get(id), currentYear: 2026 };
    expect(matchQuery(row(), parseQuery('recent:3'), oldCtx)).toBe(false);
    expect(matchQuery(row(), parseQuery('recent:10'), oldCtx)).toBe(true);
    // Without currentYear in ctx → no-op (always passes)
    expect(matchQuery(row(), parseQuery('recent:1'), ctx)).toBe(true);
  });

  it('series: — matches venue series field', () => {
    // Default fixture has series: 'ICSE'
    expect(matchQuery(row(), parseQuery('series:ICSE'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('series:icse'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('series:FSE'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-series:FSE'), ctx)).toBe(true);
    // Partial match
    expect(matchQuery(row(), parseQuery('series:IC'), ctx)).toBe(true);
    // Pipe OR
    expect(matchQuery(row(), parseQuery('series:FSE|ICSE'), ctx)).toBe(true);
    // No series on venue
    const noSeriesMap = new Map([['icse2025', mkVenue({ series: undefined as unknown as string })]]);
    const noSeriesCtx = { venueById: (id: string) => noSeriesMap.get(id) };
    expect(matchQuery(row(), parseQuery('series:ICSE'), noSeriesCtx)).toBe(false);
  });

  it('kind: — matches venue kind (conference/journal)', () => {
    // Default fixture venue has kind: 'conference'
    expect(matchQuery(row(), parseQuery('kind:conference'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('kind:journal'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-kind:journal'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('vtype:conference'), ctx)).toBe(true);
    // Partial match
    expect(matchQuery(row(), parseQuery('kind:conf'), ctx)).toBe(true);
    // Pipe OR
    expect(matchQuery(row(), parseQuery('kind:journal|conference'), ctx)).toBe(true);
    // Journal venue
    const journalVenueMap = new Map([['icse2025', mkVenue({ kind: 'journal' })]]);
    const journalCtx = { venueById: (id: string) => journalVenueMap.get(id) };
    expect(matchQuery(row(), parseQuery('kind:journal'), journalCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('kind:conference'), journalCtx)).toBe(false);
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

  it('tag: count filter — tag:>=2 matches papers with 2 or more tags', () => {
    const twoTagCtx = ctxWithTags({ 'icse2025:p1': ['important', 'ml'] });
    const oneTagCtx = ctxWithTags({ 'icse2025:p1': ['important'] });
    expect(matchQuery(row(), parseQuery('tag:>=2'), twoTagCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('tag:>=2'), oneTagCtx)).toBe(false);
    expect(matchQuery(row(), parseQuery('tag:2'), twoTagCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('tag:1-3'), twoTagCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('tag:>2'), twoTagCtx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-tag:>=2'), oneTagCtx)).toBe(true);
  });

  it('note: word-count filter — note:>5 matches papers with long notes', () => {
    // 10-word note: "This is a very important paper that must be read"
    const longNoteCtx = ctxWithNotes({ 'icse2025:p1': 'This is a very important paper that must be read' });
    const shortNoteCtx = ctxWithNotes({ 'icse2025:p1': 'Good paper' });
    const noNoteCtx = ctxWithNotes({});
    // Comparison
    expect(matchQuery(row(), parseQuery('note:>5'), longNoteCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('note:>5'), shortNoteCtx)).toBe(false);
    // Exact count
    expect(matchQuery(row(), parseQuery('note:10'), longNoteCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('note:2'), shortNoteCtx)).toBe(true);
    // Range
    expect(matchQuery(row(), parseQuery('note:5-15'), longNoteCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('note:5-15'), shortNoteCtx)).toBe(false);
    // Negation
    expect(matchQuery(row(), parseQuery('-note:>5'), shortNoteCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('-note:>5'), longNoteCtx)).toBe(false);
    // No note → word count = 0
    expect(matchQuery(row(), parseQuery('note:>0'), noNoteCtx)).toBe(false);
    expect(matchQuery(row(), parseQuery('note:0'), noNoteCtx)).toBe(true);
    // Text match still works
    expect(matchQuery(row(), parseQuery('note:important'), longNoteCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('note:important'), shortNoteCtx)).toBe(false);
  });

  // ----- has: field --------------------------------------------------------
  it('has:pdf — true when pdfUrls present', () => {
    const r = { p: mkPaper({ pdfUrls: ['https://example.com/paper.pdf'] }), v: 'icse2025' };
    expect(matchQuery(r, parseQuery('has:pdf'), ctx)).toBe(true);
  });

  it('has:pdf — true when urls contains a .pdf link', () => {
    const r = { p: mkPaper({ urls: ['https://example.com/paper.pdf'] }), v: 'icse2025' };
    expect(matchQuery(r, parseQuery('has:pdf'), ctx)).toBe(true);
  });

  it('has:pdf — false when no pdf available', () => {
    const r = { p: mkPaper({ urls: ['https://example.com/paper'] }), v: 'icse2025' };
    expect(matchQuery(r, parseQuery('has:pdf'), ctx)).toBe(false);
  });

  it('-has:pdf — negation excludes papers with PDFs', () => {
    const withPdf = { p: mkPaper({ pdfUrls: ['https://example.com/paper.pdf'] }), v: 'icse2025' };
    const noPdf = { p: mkPaper({ urls: ['https://example.com/paper'] }), v: 'icse2025' };
    expect(matchQuery(withPdf, parseQuery('-has:pdf'), ctx)).toBe(false);
    expect(matchQuery(noPdf, parseQuery('-has:pdf'), ctx)).toBe(true);
  });

  it('has:doi — true when doi present', () => {
    expect(matchQuery(row(), parseQuery('has:doi'), ctx)).toBe(true);
    const noDoi = { p: mkPaper({ doi: undefined }), v: 'icse2025' };
    expect(matchQuery(noDoi, parseQuery('has:doi'), ctx)).toBe(false);
  });

  it('has:abstract — true when abstract non-empty', () => {
    expect(matchQuery(row(), parseQuery('has:abstract'), ctx)).toBe(true);
    const noAbs = { p: mkPaper({ abstract: '' }), v: 'icse2025' };
    expect(matchQuery(noAbs, parseQuery('has:abstract'), ctx)).toBe(false);
  });

  it('has:keyword — true when keywords array non-empty', () => {
    expect(matchQuery(row(), parseQuery('has:keyword'), ctx)).toBe(true);
    const noKw = { p: mkPaper({ keywords: [] }), v: 'icse2025' };
    expect(matchQuery(noKw, parseQuery('has:keyword'), ctx)).toBe(false);
  });

  it('has:oa — true when paper is open access', () => {
    const oaPaper = { p: mkPaper({ extra: { openAccess: { is_oa: true, oa_status: 'gold', oa_url: 'https://example.com' } } }), v: 'icse2025' };
    const closedPaper = { p: mkPaper({ extra: {} }), v: 'icse2025' };
    expect(matchQuery(oaPaper, parseQuery('has:oa'), ctx)).toBe(true);
    expect(matchQuery(closedPaper, parseQuery('has:oa'), ctx)).toBe(false);
  });

  it('has:artifact — true when artifactUrls non-empty', () => {
    const withArt = { p: mkPaper({ artifactUrls: ['https://github.com/repo'] }), v: 'icse2025' };
    expect(matchQuery(withArt, parseQuery('has:artifact'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('has:artifact'), ctx)).toBe(false);
  });

  it('has:note — true when noteOf returns non-empty string', () => {
    const noteCtx = { venueById: (id: string) => VENUE_MAP.get(id), noteOf: (k: string) => k === 'icse2025:p1' ? 'my note' : '' };
    expect(matchQuery(row(), parseQuery('has:note'), noteCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('has:note'), ctx)).toBe(false);
  });

  it('has:status — true when statusOf returns a non-unread status', () => {
    const statusCtx = { venueById: (id: string) => VENUE_MAP.get(id), statusOf: (k: string) => k === 'icse2025:p1' ? 'toread' : 'unread' };
    expect(matchQuery(row(), parseQuery('has:status'), statusCtx)).toBe(true);
    const unreadCtx = { venueById: (id: string) => VENUE_MAP.get(id), statusOf: (_k: string) => 'unread' };
    expect(matchQuery(row(), parseQuery('has:status'), unreadCtx)).toBe(false);
  });

  it('has:tag — true when tagsOf returns non-empty array', () => {
    const tagCtx = { venueById: (id: string) => VENUE_MAP.get(id), tagsOf: (k: string) => k === 'icse2025:p1' ? ['important'] : [] };
    expect(matchQuery(row(), parseQuery('has:tag'), tagCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('has:tag'), ctx)).toBe(false);
  });

  it('has:collection — true when collectionOf returns true', () => {
    const colCtx = { venueById: (id: string) => VENUE_MAP.get(id), collectionOf: (k: string) => k === 'icse2025:p1' };
    expect(matchQuery(row(), parseQuery('has:collection'), colCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('has:collection'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-has:collection'), colCtx)).toBe(false);
    const noColCtx = { venueById: (id: string) => VENUE_MAP.get(id), collectionOf: (_k: string) => false };
    expect(matchQuery(row(), parseQuery('has:collection'), noColCtx)).toBe(false);
  });

  // ----- keyword count filter -------------------------------------------
  // Fixture has keywords: ['neural network', 'static analysis'] → 2 keywords
  it('keyword count: exact', () => {
    expect(matchQuery(row(), parseQuery('keyword:2'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('keyword:3'), ctx)).toBe(false);
  });
  it('keyword count: comparison operators', () => {
    expect(matchQuery(row(), parseQuery('keyword:>=1'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('keyword:>=3'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('keyword:>1'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('keyword:<=2'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('keyword:<2'), ctx)).toBe(false);
  });
  it('keyword count: range', () => {
    expect(matchQuery(row(), parseQuery('keyword:1-5'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('keyword:3-10'), ctx)).toBe(false);
  });
  it('keyword count: text match still works when non-numeric', () => {
    expect(matchQuery(row(), parseQuery('keyword:neural'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('keyword:fuzzing'), ctx)).toBe(false);
  });
  it('keyword count: negation', () => {
    expect(matchQuery(row(), parseQuery('-keyword:2'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-keyword:>=5'), ctx)).toBe(true);
  });

  // ----- len: abstract word count filter --------------------------------
  // Abstract = 'We present a deep learning approach to static analysis.' → 9 words
  it('len: exact match', () => {
    expect(matchQuery(row(), parseQuery('len:9'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('len:10'), ctx)).toBe(false);
  });
  it('len: comparison operators', () => {
    expect(matchQuery(row(), parseQuery('len:>5'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('len:>9'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('len:<10'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('len:<9'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('len:>=9'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('len:<=9'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('len:>=10'), ctx)).toBe(false);
  });
  it('len: range', () => {
    expect(matchQuery(row(), parseQuery('len:5-15'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('len:1-5'), ctx)).toBe(false);
  });
  it('len: negation', () => {
    expect(matchQuery(row(), parseQuery('-len:9'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-len:>100'), ctx)).toBe(true);
  });
  it('len: aliases (words:, wc:)', () => {
    expect(matchQuery(row(), parseQuery('words:>5'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('wc:9'), ctx)).toBe(true);
  });
  it('len: empty abstract counts as 0', () => {
    const noAbs2 = { p: mkPaper({ abstract: '' }), v: 'icse2025' };
    expect(matchQuery(noAbs2, parseQuery('len:0'), ctx)).toBe(true);
    expect(matchQuery(noAbs2, parseQuery('len:>0'), ctx)).toBe(false);
  });

  // ----- pipe OR within field values ------------------------------------
  it('author:smith|jones matches either alternative', () => {
    expect(matchQuery(row(), parseQuery('author:smith|jones'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('author:jones|lee'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('author:taylor|jackson'), ctx)).toBe(false);
  });

  it('track:testing|security matches either track', () => {
    expect(matchQuery(row(), parseQuery('track:testing|security'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('track:security|networking'), ctx)).toBe(false);
  });

  it('has: combines with other terms (AND)', () => {
    const withPdf = { p: mkPaper({ pdfUrls: ['https://example.com/paper.pdf'] }), v: 'icse2025' };
    expect(matchQuery(withPdf, parseQuery('has:pdf author:smith'), ctx)).toBe(true);
    expect(matchQuery(withPdf, parseQuery('has:pdf author:jones'), ctx)).toBe(false);
  });

  // ----- status: field -----------------------------------------------------
  it('status:toread matches papers with that status', () => {
    const statusCtx = ctxWithStatus({ 'icse2025:p1': 'toread' });
    expect(matchQuery(row(), parseQuery('status:toread'), statusCtx)).toBe(true);
    expect(matchQuery(row(), parseQuery('status:reading'), statusCtx)).toBe(false);
  });

  it('status:done with negation', () => {
    const statusCtx = ctxWithStatus({ 'icse2025:p1': 'done' });
    expect(matchQuery(row(), parseQuery('-status:done'), statusCtx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-status:toread'), statusCtx)).toBe(true);
  });

  it('status: without statusOf (MCP context) no-ops — returns empty string', () => {
    expect(matchQuery(row(), parseQuery('status:toread'), ctx)).toBe(false);
  });

  // ----- has:inst field ------------------------------------------------
  it('has:inst — true when authorInstitutions present', () => {
    const withInst = { p: mkPaper({ authorInstitutions: 'Alice Smith (MIT); Bob Lee (Stanford)' }), v: 'icse2025' };
    const noInst = { p: mkPaper({ authorInstitutions: '' }), v: 'icse2025' };
    expect(matchQuery(withInst, parseQuery('has:inst'), ctx)).toBe(true);
    expect(matchQuery(noInst, parseQuery('has:inst'), ctx)).toBe(false);
  });

  // ----- has:session / has:date / has:track / has:url ------------------
  it('has:session — true when sessionTitles present', () => {
    const with_ = { p: mkPaper({ sessionTitles: ['Session A'] }), v: 'icse2025' };
    const without = { p: mkPaper({ sessionTitles: [] }), v: 'icse2025' };
    expect(matchQuery(with_, parseQuery('has:session'), ctx)).toBe(true);
    expect(matchQuery(without, parseQuery('has:session'), ctx)).toBe(false);
  });

  it('has:track — true when tracks present', () => {
    const with_ = { p: mkPaper({ tracks: ['ml'] }), v: 'icse2025' };
    const without = { p: mkPaper({ tracks: [] }), v: 'icse2025' };
    expect(matchQuery(with_, parseQuery('has:track'), ctx)).toBe(true);
    expect(matchQuery(without, parseQuery('has:track'), ctx)).toBe(false);
  });

  it('has:url — true when urls present', () => {
    const with_ = { p: mkPaper({ urls: ['https://example.com'] }), v: 'icse2025' };
    const without = { p: mkPaper({ urls: [] }), v: 'icse2025' };
    expect(matchQuery(with_, parseQuery('has:url'), ctx)).toBe(true);
    expect(matchQuery(without, parseQuery('has:url'), ctx)).toBe(false);
  });

  // ----- authors: count syntax -----------------------------------------
  it('authors:2 — matches papers with exactly 2 authors', () => {
    const two = { p: mkPaper({ authors: ['A', 'B'] }), v: 'icse2025' };
    const three = { p: mkPaper({ authors: ['A', 'B', 'C'] }), v: 'icse2025' };
    expect(matchQuery(two, parseQuery('authors:2'), ctx)).toBe(true);
    expect(matchQuery(three, parseQuery('authors:2'), ctx)).toBe(false);
  });

  it('authors:>=3 — matches papers with 3 or more authors', () => {
    const two = { p: mkPaper({ authors: ['A', 'B'] }), v: 'icse2025' };
    const three = { p: mkPaper({ authors: ['A', 'B', 'C'] }), v: 'icse2025' };
    const four = { p: mkPaper({ authors: ['A', 'B', 'C', 'D'] }), v: 'icse2025' };
    expect(matchQuery(two, parseQuery('authors:>=3'), ctx)).toBe(false);
    expect(matchQuery(three, parseQuery('authors:>=3'), ctx)).toBe(true);
    expect(matchQuery(four, parseQuery('authors:>=3'), ctx)).toBe(true);
  });

  it('authors:2-4 — matches papers with 2 to 4 authors', () => {
    const one = { p: mkPaper({ authors: ['A'] }), v: 'icse2025' };
    const three = { p: mkPaper({ authors: ['A', 'B', 'C'] }), v: 'icse2025' };
    const five = { p: mkPaper({ authors: ['A', 'B', 'C', 'D', 'E'] }), v: 'icse2025' };
    expect(matchQuery(one, parseQuery('authors:2-4'), ctx)).toBe(false);
    expect(matchQuery(three, parseQuery('authors:2-4'), ctx)).toBe(true);
    expect(matchQuery(five, parseQuery('authors:2-4'), ctx)).toBe(false);
  });

  it('authors:1 — matches sole-author papers', () => {
    const solo = { p: mkPaper({ authors: ['Alice Smith'] }), v: 'icse2025' };
    expect(matchQuery(solo, parseQuery('authors:1'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('authors:1'), ctx)).toBe(false); // 2 authors
  });

  // ----- similar: field -------------------------------------------------------
  it('similar:key — matches when candidateKey is in the similar set', () => {
    const targetKey = 'icse2025:p1';
    const ctxWithSimilar = {
      venueById: (id: string) => VENUE_MAP.get(id),
      similarOf: (tk: string) => tk === targetKey ? new Set(['icse2025:p2', 'icse2025:p3']) : new Set<string>(),
    };
    const p2 = { p: mkPaper({ id: 'p2' }), v: 'icse2025' };
    const p4 = { p: mkPaper({ id: 'p4' }), v: 'icse2025' };
    expect(matchQuery(p2, parseQuery(`similar:${targetKey}`), ctxWithSimilar)).toBe(true);
    expect(matchQuery(p4, parseQuery(`similar:${targetKey}`), ctxWithSimilar)).toBe(false);
  });

  it('similar: without similarOf context no-ops (always false)', () => {
    expect(matchQuery(row(), parseQuery('similar:icse2025:p1'), ctx)).toBe(false);
  });

  it('-similar:key — negation excludes similar papers', () => {
    const targetKey = 'icse2025:p1';
    const ctxWithSimilar = {
      venueById: (id: string) => VENUE_MAP.get(id),
      similarOf: (tk: string) => tk === targetKey ? new Set(['icse2025:p1']) : new Set<string>(),
    };
    // p1 is in its own similar set → negation means -similar:key excludes it
    expect(matchQuery(row(), parseQuery(`-similar:${targetKey}`), ctxWithSimilar)).toBe(false);
  });

  it('similar:key1|key2 — OR: matches papers similar to either key', () => {
    const ctxWithSimilar = {
      venueById: (id: string) => VENUE_MAP.get(id),
      similarOf: (tk: string) => {
        if (tk === 'icse2025:a') return new Set(['icse2025:p1']);
        if (tk === 'icse2025:b') return new Set(['icse2025:p2']);
        return new Set<string>();
      },
    };
    // row() has paper id p1 → similar to a
    expect(matchQuery(row(), parseQuery('similar:icse2025:a|icse2025:b'), ctxWithSimilar)).toBe(true);
    const p2 = { p: mkPaper({ id: 'p2' }), v: 'icse2025' };
    // p2 is similar to b
    expect(matchQuery(p2, parseQuery('similar:icse2025:a|icse2025:b'), ctxWithSimilar)).toBe(true);
    const p3 = { p: mkPaper({ id: 'p3' }), v: 'icse2025' };
    // p3 is similar to neither
    expect(matchQuery(p3, parseQuery('similar:icse2025:a|icse2025:b'), ctxWithSimilar)).toBe(false);
  });

  // ----- Unicode normalization ------------------------------------------------
  it('author:muller matches author named Müller', () => {
    const r = { p: mkPaper({ authors: ['Jürgen Müller', 'Alice Smith'] }), v: 'icse2025' };
    expect(matchQuery(r, parseQuery('author:muller'), ctx)).toBe(true);
    expect(matchQuery(r, parseQuery('author:jurgen'), ctx)).toBe(true);
  });

  it('inst:munchen matches institution TU München', () => {
    const r = { p: mkPaper({ authorInstitutions: 'Jürgen Müller (TU München)' }), v: 'icse2025' };
    expect(matchQuery(r, parseQuery('inst:munchen'), ctx)).toBe(true);
  });

  it('bare search term with accent matches normalized text', () => {
    const r = { p: mkPaper({ title: 'Graph Analysis in São Paulo' }), v: 'icse2025' };
    expect(matchQuery(r, parseQuery('sao paulo'), ctx)).toBe(true);
    expect(matchQuery(r, parseQuery('são paulo'), ctx)).toBe(true);
  });

  // ----- sort: directive -------------------------------------------------------
  it('sort: directive is a no-op in matchQuery (does not filter)', () => {
    expect(matchQuery(row(), parseQuery('sort:year'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('neural sort:year'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('quantum sort:year'), ctx)).toBe(false);
  });

  it('in: directive is a no-op in matchQuery (handled by caller)', () => {
    // matchQuery should not reject on in: terms — the caller (app.ts) handles collection filtering
    expect(matchQuery(row(), parseQuery('in:mylist'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('neural in:mylist'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('-in:mylist'), ctx)).toBe(true);
  });

  it('oa:gold — matches paper with gold OA status', () => {
    const oaPaper = mkPaper({ extra: { openAccess: { is_oa: true, oa_status: 'gold', oa_url: 'https://oa.example.com' } } });
    expect(matchQuery({ p: oaPaper, v: 'icse2025' }, parseQuery('oa:gold'), ctx)).toBe(true);
    expect(matchQuery({ p: oaPaper, v: 'icse2025' }, parseQuery('oa:green'), ctx)).toBe(false);
  });

  it('oa:any — matches any open access paper', () => {
    const goldPaper = mkPaper({ extra: { openAccess: { is_oa: true, oa_status: 'gold' } } });
    const closedPaper = mkPaper({ extra: { openAccess: { is_oa: false, oa_status: 'closed' } } });
    expect(matchQuery({ p: goldPaper, v: 'icse2025' }, parseQuery('oa:any'), ctx)).toBe(true);
    expect(matchQuery({ p: closedPaper, v: 'icse2025' }, parseQuery('oa:any'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('oa:any'), ctx)).toBe(false);
  });

  it('-oa:gold — excludes gold OA papers', () => {
    const goldPaper = mkPaper({ extra: { openAccess: { is_oa: true, oa_status: 'gold' } } });
    expect(matchQuery({ p: goldPaper, v: 'icse2025' }, parseQuery('-oa:gold'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('-oa:gold'), ctx)).toBe(true);
  });

  it('year:2020-2025 — matches paper in range', () => {
    expect(matchQuery(row(), parseQuery('year:2020-2025'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:2020-2024'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('year:2025-2030'), ctx)).toBe(true);
  });

  it('year:>=2024 — matches venue year >= 2024', () => {
    expect(matchQuery(row(), parseQuery('year:>=2024'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:>=2026'), ctx)).toBe(false);
  });

  it('year:<2026 — matches venue year less than 2026', () => {
    expect(matchQuery(row(), parseQuery('year:<2026'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('year:<2025'), ctx)).toBe(false);
  });

  it('location: — matches paper session room', () => {
    const paper = mkPaper({ locations: ['Hall A', 'Room 101'] });
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('location:hall'), ctx)).toBe(true);
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('location:room'), ctx)).toBe(true);
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('location:ballroom'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('location:hall'), ctx)).toBe(false);
  });

  it('date: — matches paper presentation date', () => {
    const paper = mkPaper({ dates: ['2025-05-12', '2025-05-13'] });
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('date:2025-05'), ctx)).toBe(true);
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('date:2025-06'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('date:2025'), ctx)).toBe(false);
  });

  it('url: — matches paper URL substring', () => {
    expect(matchQuery(row(), parseQuery('url:example'), ctx)).toBe(true);
    expect(matchQuery(row(), parseQuery('url:arxiv'), ctx)).toBe(false);
    const arxivPaper = mkPaper({ urls: ['https://arxiv.org/abs/2501.12345'] });
    expect(matchQuery({ p: arxivPaper, v: 'icse2025' }, parseQuery('url:arxiv'), ctx)).toBe(true);
  });

  it('room: — alias for location:', () => {
    const paper = mkPaper({ locations: ['Main Hall'] });
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('room:main'), ctx)).toBe(true);
  });

  it('pubdate: — matches publicationDate substring', () => {
    const paper = mkPaper({ publicationDate: '2025-05-12' });
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('pubdate:2025'), ctx)).toBe(true);
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('pubdate:2025-05'), ctx)).toBe(true);
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('pubdate:2024'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('pubdate:2025'), ctx)).toBe(false);
  });

  it('published: — alias for pubdate:', () => {
    const paper = mkPaper({ publicationDate: '2025-05-12' });
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('published:2025'), ctx)).toBe(true);
  });

  it('pages: — matches pages string', () => {
    const paper = mkPaper({ pages: '1-12' });
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('pages:1-12'), ctx)).toBe(true);
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('pages:1'), ctx)).toBe(true);
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('pages:99'), ctx)).toBe(false);
    expect(matchQuery(row(), parseQuery('pages:1-12'), ctx)).toBe(false);
  });

  it('page: — alias for pages:', () => {
    const paper = mkPaper({ pages: '100-110' });
    expect(matchQuery({ p: paper, v: 'icse2025' }, parseQuery('page:100'), ctx)).toBe(true);
  });

  it('has:date — true when dates array non-empty', () => {
    const withDate = mkPaper({ dates: ['2025-05-12'] });
    const noDate = mkPaper({ dates: [] });
    expect(matchQuery({ p: withDate, v: 'icse2025' }, parseQuery('has:date'), ctx)).toBe(true);
    expect(matchQuery({ p: noDate, v: 'icse2025' }, parseQuery('has:date'), ctx)).toBe(false);
  });

  it('has:location — true when locations array non-empty', () => {
    const withLoc = mkPaper({ locations: ['Hall A'] });
    const noLoc = mkPaper({ locations: [] });
    expect(matchQuery({ p: withLoc, v: 'icse2025' }, parseQuery('has:location'), ctx)).toBe(true);
    expect(matchQuery({ p: noLoc, v: 'icse2025' }, parseQuery('has:location'), ctx)).toBe(false);
  });

  it('has:pages — true when pages present', () => {
    const withPages = mkPaper({ pages: '1-12' });
    const noPages = mkPaper({ pages: undefined });
    expect(matchQuery({ p: withPages, v: 'icse2025' }, parseQuery('has:pages'), ctx)).toBe(true);
    expect(matchQuery({ p: noPages, v: 'icse2025' }, parseQuery('has:pages'), ctx)).toBe(false);
  });

  it('has:pubdate — true when publicationDate present', () => {
    const withPd = mkPaper({ publicationDate: '2025-05-12' });
    const noPd = mkPaper({ publicationDate: undefined });
    expect(matchQuery({ p: withPd, v: 'icse2025' }, parseQuery('has:pubdate'), ctx)).toBe(true);
    expect(matchQuery({ p: noPd, v: 'icse2025' }, parseQuery('has:pubdate'), ctx)).toBe(false);
  });

  it('pubdate: >= comparison', () => {
    const paper = mkPaper({ publicationDate: '2025-05-12' });
    const row2 = { p: paper, v: 'icse2025' };
    expect(matchQuery(row2, parseQuery('pubdate:>=2025-05'), ctx)).toBe(true);
    expect(matchQuery(row2, parseQuery('pubdate:>=2025-06'), ctx)).toBe(false);
    expect(matchQuery(row2, parseQuery('pubdate:<2025-06'), ctx)).toBe(true);
    expect(matchQuery(row2, parseQuery('pubdate:<2025-05'), ctx)).toBe(false);
    // no pubdate → no match for comparison
    expect(matchQuery(row(), parseQuery('pubdate:>=2020'), ctx)).toBe(false);
  });

  it('date: >= comparison', () => {
    const paper = mkPaper({ dates: ['2025-06-10', '2025-06-11'] });
    const row2 = { p: paper, v: 'icse2025' };
    expect(matchQuery(row2, parseQuery('date:>=2025-06'), ctx)).toBe(true);
    expect(matchQuery(row2, parseQuery('date:>=2025-07'), ctx)).toBe(false);
    expect(matchQuery(row2, parseQuery('date:<=2025-06-10'), ctx)).toBe(true);
    // no dates → no match for comparison
    expect(matchQuery(row(), parseQuery('date:>=2020'), ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countOcc
// ---------------------------------------------------------------------------
describe('countOcc', () => {
  it('counts non-overlapping occurrences', () => {
    expect(countOcc('aaa', 'aa')).toBe(1); // non-overlapping
    expect(countOcc('neural neural', 'neural')).toBe(2);
    expect(countOcc('hello world', 'xyz')).toBe(0);
    expect(countOcc('hello', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// relevanceScore
// ---------------------------------------------------------------------------
describe('relevanceScore', () => {
  const r = () => ({ p: mkPaper(), v: 'icse2025' });

  it('returns 0 for empty terms', () => {
    expect(relevanceScore(r(), [])).toBe(0);
  });

  it('title matches score higher than abstract matches', () => {
    // "neural" appears in title → weight 5; "deep" appears only in abstract → weight 1
    const titleScore = relevanceScore(r(), parseQuery('neural'));
    const absScore = relevanceScore(r(), parseQuery('deep'));
    expect(titleScore).toBeGreaterThan(absScore);
  });

  it('keyword match scores 3×, abstract match scores 1×', () => {
    // "static analysis" is in both keywords AND abstract — check combined scoring
    const kwScore = relevanceScore(r(), parseQuery('keyword:static'));
    const absScore = relevanceScore(r(), parseQuery('abstract:static'));
    expect(kwScore).toBeGreaterThan(absScore);
  });

  it('negative terms do not contribute to score', () => {
    const pos = relevanceScore(r(), parseQuery('neural'));
    const withNeg = relevanceScore(r(), parseQuery('neural -deep'));
    expect(withNeg).toBe(pos); // negative term ignored
  });

  it('sort: and has: directives do not contribute to score', () => {
    const base = relevanceScore(r(), parseQuery('neural'));
    const withSort = relevanceScore(r(), parseQuery('neural sort:year'));
    const withHas = relevanceScore(r(), parseQuery('neural has:pdf'));
    expect(withSort).toBe(base);
    expect(withHas).toBe(base);
  });

  it('field-specific term only scores that field', () => {
    // title:neural scores title only; any:neural scores title + keyword (paper has "neural network" in kw)
    const titleTerm = relevanceScore(r(), parseQuery('title:neural'));
    const anyTerm = relevanceScore(r(), parseQuery('neural'));
    expect(anyTerm).toBeGreaterThan(titleTerm);
    expect(titleTerm).toBeGreaterThan(0);
  });

  it('word-boundary matches score higher than interior matches', () => {
    const wbPaper = mkPaper({ title: 'Code Analysis', abstract: '' });
    const interiorPaper = mkPaper({ title: 'Decode Analysis', abstract: '' });
    const wbScore = relevanceScore({ p: wbPaper, v: 'icse2025' }, parseQuery('code'));
    const interiorScore = relevanceScore({ p: interiorPaper, v: 'icse2025' }, parseQuery('code'));
    expect(wbScore).toBeGreaterThan(interiorScore);
  });
});

// ---------------------------------------------------------------------------
// abstractSnippet
// ---------------------------------------------------------------------------
describe('abstractSnippet', () => {
  it('returns empty string when text is empty', () => {
    expect(abstractSnippet('', ['neural'])).toBe('');
  });

  it('returns empty string when terms are empty', () => {
    expect(abstractSnippet('Some abstract text.', [])).toBe('');
  });

  it('returns the matching sentence when abstract has multiple sentences', () => {
    const text = 'Intro sentence. We study neural networks. Conclusion follows.';
    const snip = abstractSnippet(text, ['neural']);
    expect(snip).toContain('neural');
    expect(snip).toContain('We study neural networks');
  });

  it('picks the sentence with the most term hits', () => {
    const text = 'First sentence about learning. Second sentence about deep learning and neural networks. Third.';
    const snip = abstractSnippet(text, ['learning', 'neural']);
    // Second sentence has both 'learning' and 'neural'
    expect(snip).toContain('deep learning');
    expect(snip).toContain('neural');
  });

  it('falls back to first sentence when no terms match', () => {
    const text = 'First sentence here. Second sentence has xyz. Third.';
    const snip = abstractSnippet(text, ['nomatch']);
    // No term matches → picks first sentence (bestScore stays 0, bestSent = sentences[0])
    expect(snip).toContain('First sentence here');
  });

  it('prepends ellipsis when best sentence is not the first', () => {
    const text = 'First sentence about nothing. The neural approach is key.';
    const snip = abstractSnippet(text, ['neural']);
    expect(snip.startsWith('…')).toBe(true);
  });

  it('does not prepend ellipsis for the first sentence', () => {
    const text = 'Neural networks are great. Other stuff.';
    const snip = abstractSnippet(text, ['neural']);
    expect(snip.startsWith('…')).toBe(false);
  });
});
