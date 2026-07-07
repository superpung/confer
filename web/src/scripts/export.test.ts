import { describe, it, expect } from 'vitest';
import { toBibtex, toMarkdown, toCsv, toRis, toTable } from './export';
import type { Paper, Venue } from './types';

const mkPaper = (overrides: Partial<Paper> = {}): Paper => ({
  id: 'p1',
  title: 'Neural Networks for Code Analysis',
  abstract: 'A deep learning approach.',
  authors: ['Alice Smith', 'Bob Lee'],
  authorInstitutions: 'Alice Smith (MIT); Bob Lee (Stanford)',
  tracks: ['machine-learning'],
  eventType: 'Research Paper',
  sessionTitles: [],
  sessions: [],
  dates: [],
  locations: [],
  urls: ['https://example.com/paper'],
  doi: '10.1145/test.123',
  keywords: ['neural network', 'static analysis'],
  pdfUrls: ['https://example.com/paper.pdf'],
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

const row = (p = mkPaper(), v = mkVenue(), note?: string) => ({ paper: p, venue: v, note });

describe('toBibtex', () => {
  it('generates inproceedings entry', () => {
    const bib = toBibtex([row()]);
    expect(bib).toContain('@inproceedings{');
    expect(bib).toContain('title = {Neural Networks for Code Analysis}');
    expect(bib).toContain('author = {Alice Smith and Bob Lee}');
    expect(bib).toContain('booktitle = {ICSE 2025}');
    expect(bib).toContain('year = {2025}');
    expect(bib).toContain('doi = {10.1145/test.123}');
  });

  it('generates article entry for journals', () => {
    const bib = toBibtex([row(mkPaper(), mkVenue({ kind: 'journal' }))]);
    expect(bib).toContain('@article{');
    expect(bib).toContain('journal = {ICSE 2025}');
  });

  it('deduplicates BibTeX keys with suffix', () => {
    const bib = toBibtex([row(), row()]);
    expect(bib).toContain('Smith2025Neural,');
    expect(bib).toContain('Smith2025Neuralb,');
  });

  it('includes annote when note is present', () => {
    const bib = toBibtex([row(mkPaper(), mkVenue(), 'Great paper!')]);
    expect(bib).toContain('annote = {Great paper!}');
  });

  it('handles empty rows', () => {
    expect(toBibtex([])).toBe('');
  });
});

describe('toMarkdown', () => {
  it('generates heading with title', () => {
    const md = toMarkdown([row()]);
    expect(md).toContain('### Neural Networks for Code Analysis');
  });

  it('includes authors', () => {
    const md = toMarkdown([row()]);
    expect(md).toContain('**Authors**: Alice Smith, Bob Lee');
  });

  it('includes abstract', () => {
    const md = toMarkdown([row()]);
    expect(md).toContain('**Abstract**: A deep learning approach.');
  });

  it('includes links', () => {
    const md = toMarkdown([row()]);
    expect(md).toContain('[Paper](https://example.com/paper)');
    expect(md).toContain('[PDF](https://example.com/paper.pdf)');
    expect(md).toContain('[DOI](https://doi.org/10.1145/test.123)');
  });

  it('includes note as blockquote', () => {
    const md = toMarkdown([row(mkPaper(), mkVenue(), 'Must read')]);
    expect(md).toContain('> Must read');
  });

  it('adds venue heading when multiple venues', () => {
    const r1 = row(mkPaper(), mkVenue({ id: 'icse2025', name: 'ICSE 2025' }));
    const r2 = row(mkPaper(), mkVenue({ id: 'ase2025', name: 'ASE 2025' }));
    const md = toMarkdown([r1, r2]);
    expect(md).toContain('## ICSE 2025');
    expect(md).toContain('## ASE 2025');
  });

  it('no venue heading for single venue', () => {
    const md = toMarkdown([row(), row()]);
    expect(md).not.toContain('## ICSE 2025');
  });

  it('handles empty rows', () => {
    expect(toMarkdown([])).toBe('');
  });
});

describe('toCsv', () => {
  it('generates header row', () => {
    const csv = toCsv([row()]);
    const hdr = csv.split('\n')[0];
    expect(hdr).toContain('venue');
    expect(hdr).toContain('id');
    expect(hdr).toContain('title');
    expect(hdr).toContain('authorCount');
    expect(hdr).toContain('authors');
    expect(hdr).toContain('keywordCount');
    expect(hdr).toContain('abstractWordCount');
  });

  it('includes note column', () => {
    const csv = toCsv([row(mkPaper(), mkVenue(), 'my note')]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('note');
    expect(lines[1]).toContain('my note');
  });

  it('quotes cells containing commas', () => {
    const csv = toCsv([row(mkPaper({ title: 'Title, with comma' }))]);
    expect(csv).toContain('"Title, with comma"');
  });

  it('escapes double quotes inside cells', () => {
    const csv = toCsv([row(mkPaper({ title: 'Title "quoted"' }))]);
    expect(csv).toContain('"Title ""quoted"""');
  });

  it('includes abstract column with value', () => {
    const csv = toCsv([row(mkPaper({ abstract: 'A deep learning approach.' }))]);
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const absIdx = headers.indexOf('abstract');
    expect(absIdx).toBeGreaterThan(-1);
    const cells = lines[1].split(',');
    expect(cells[absIdx]).toBe('A deep learning approach.');
  });

  it('omits simScore column when no simScores provided', () => {
    const csv = toCsv([row()]);
    expect(csv.split('\n')[0]).not.toContain('simScore');
  });

  it('includes simScore column and values when simScores provided', () => {
    const scores = new Map([['icse2025:p1', 0.75]]);
    const csv = toCsv([row()], { simScores: scores });
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const simIdx = headers.indexOf('simScore');
    expect(simIdx).toBeGreaterThan(-1);
    // 0.75 → 75%
    expect(lines[1].split(',')[simIdx]).toBe('75');
  });

  it('simScore column appears after abstractWordCount and before note', () => {
    const scores = new Map([['icse2025:p1', 0.5]]);
    const csv = toCsv([row(mkPaper(), mkVenue(), 'my note')], { simScores: scores });
    const headers = csv.split('\n')[0].split(',');
    const wcIdx = headers.indexOf('abstractWordCount');
    const simIdx = headers.indexOf('simScore');
    const noteIdx = headers.indexOf('note');
    expect(wcIdx).toBeGreaterThan(headers.indexOf('abstract'));
    expect(simIdx).toBe(wcIdx + 1);
    expect(noteIdx).toBeGreaterThan(simIdx);
  });

  it('simScore is empty string for papers with zero similarity', () => {
    const scores = new Map([['icse2025:p1', 0]]);
    const csv = toCsv([row()], { simScores: scores });
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const simIdx = headers.indexOf('simScore');
    expect(lines[1].split(',')[simIdx]).toBe('');
  });

  it('omits readStatus column when no non-unread status in rows', () => {
    const csv = toCsv([row()]);
    expect(csv.split('\n')[0]).not.toContain('readStatus');
  });

  it('includes readStatus column when any row has non-unread status', () => {
    const csv = toCsv([{ ...row(), readStatus: 'done' }]);
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const rsIdx = headers.indexOf('readStatus');
    expect(rsIdx).toBeGreaterThan(-1);
    expect(lines[1].split(',')[rsIdx]).toBe('done');
  });

  it('omits tags column when no rows have tags', () => {
    const csv = toCsv([row()]);
    expect(csv.split('\n')[0]).not.toContain('tags');
  });

  it('includes tags column with semicolon-separated values', () => {
    const csv = toCsv([{ ...row(), tags: ['ml', 'important'] }]);
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const tagIdx = headers.indexOf('tags');
    expect(tagIdx).toBeGreaterThan(-1);
    expect(lines[1].split(',')[tagIdx]).toBe('ml; important');
  });

  it('column order: abstract, abstractWordCount, [simScore], [readStatus], [tags], note', () => {
    const scores = new Map([['icse2025:p1', 0.5]]);
    const csv = toCsv([{ ...row(), readStatus: 'toread', tags: ['review'] }], { simScores: scores });
    const headers = csv.split('\n')[0].split(',');
    const absIdx = headers.indexOf('abstract');
    const wcIdx = headers.indexOf('abstractWordCount');
    const simIdx = headers.indexOf('simScore');
    const rsIdx = headers.indexOf('readStatus');
    const tagIdx = headers.indexOf('tags');
    const noteIdx = headers.indexOf('note');
    expect(wcIdx).toBe(absIdx + 1);
    expect(simIdx).toBe(wcIdx + 1);
    expect(rsIdx).toBe(simIdx + 1);
    expect(tagIdx).toBe(rsIdx + 1);
    expect(noteIdx).toBe(tagIdx + 1);
  });
});

// ---------------------------------------------------------------------------
// toRis
// ---------------------------------------------------------------------------
describe('toRis', () => {
  it('outputs TY - CONF for a conference paper', () => {
    const ris = toRis([row()]);
    expect(ris).toContain('TY  - CONF');
  });

  it('outputs TY - JOUR for a journal article', () => {
    const ris = toRis([row(undefined, mkVenue({ kind: 'journal' }))]);
    expect(ris).toContain('TY  - JOUR');
  });

  it('includes title, authors, year, DOI', () => {
    const ris = toRis([row()]);
    expect(ris).toContain('TI  - Neural Networks for Code Analysis');
    expect(ris).toContain('AU  - Alice Smith');
    expect(ris).toContain('AU  - Bob Lee');
    expect(ris).toContain('PY  - 2025');
    expect(ris).toContain('DO  - 10.1145/test.123');
  });

  it('includes abstract', () => {
    const ris = toRis([row()]);
    expect(ris).toContain('AB  - A deep learning approach.');
  });

  it('includes keywords', () => {
    const ris = toRis([row()]);
    expect(ris).toContain('KW  - neural network');
    expect(ris).toContain('KW  - static analysis');
  });

  it('ends each record with ER  - ', () => {
    const ris = toRis([row()]);
    expect(ris).toContain('ER  - ');
  });

  it('separates multiple records with blank line', () => {
    const ris = toRis([row(), row(mkPaper({ id: 'p2', title: 'Another Paper' }))]);
    expect(ris).toContain('\n\n');
    expect(ris).toContain('TI  - Another Paper');
  });
});

// ---------------------------------------------------------------------------
// toTable
// ---------------------------------------------------------------------------
describe('toTable', () => {
  it('generates header and separator rows', () => {
    const tbl = toTable([row()]);
    const lines = tbl.split('\n');
    expect(lines[0]).toContain('Title');
    expect(lines[0]).toContain('Authors');
    expect(lines[0]).toContain('Venue');
    expect(lines[1]).toMatch(/^\|[-| ]+\|$/);
  });

  it('includes paper title and authors', () => {
    const tbl = toTable([row()]);
    expect(tbl).toContain('Neural Networks for Code Analysis');
    expect(tbl).toContain('Alice Smith, Bob Lee');
  });

  it('escapes pipe chars in cells', () => {
    const tbl = toTable([row(mkPaper({ title: 'A | B' }))]);
    expect(tbl).toContain('A \\| B');
  });

  it('includes DOI link', () => {
    const tbl = toTable([row()]);
    expect(tbl).toContain('[DOI](https://doi.org/10.1145/test.123)');
  });

  it('handles empty rows', () => {
    expect(toTable([])).toBe('');
  });

  it('truncates long author lists to 3 + et al.', () => {
    const tbl = toTable([row(mkPaper({ authors: ['A', 'B', 'C', 'D', 'E'] }))]);
    expect(tbl).toContain('et al.');
  });
});
