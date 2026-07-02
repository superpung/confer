import { describe, it, expect } from 'vitest';
import { parseAff, authorAff, normalize, searchBlob, fieldText } from './text';
import type { Paper } from '../scripts/types';
const mkPaper = (authorInstitutions: string): Paper => ({
  id: 'p1', title: 'T', abstract: '', authors: [], authorInstitutions,
  tracks: [], eventType: '', sessionTitles: [], sessions: [], dates: [], locations: [], urls: [],
});

describe('parseAff', () => {
  it('simple name and institution', () => {
    expect(parseAff(mkPaper('Alice Smith (MIT)'))).toEqual([{ author: 'Alice Smith', inst: 'MIT' }]);
  });

  it('author name with nickname in parens', () => {
    expect(parseAff(mkPaper('Tse-Hsun (Peter) Chen (Concordia University)'))).toEqual([
      { author: 'Tse-Hsun (Peter) Chen', inst: 'Concordia University' },
    ]);
  });

  it('institution with abbreviation in parens', () => {
    expect(parseAff(mkPaper('Alice (City University of New York (CUNY) Hunter College)'))).toEqual([
      { author: 'Alice', inst: 'City University of New York (CUNY) Hunter College' },
    ]);
  });

  it('institution with city in parens', () => {
    expect(parseAff(mkPaper('Feng Wu (Tencent Technology (Shenzhen) Co. Ltd)'))).toEqual([
      { author: 'Feng Wu', inst: 'Tencent Technology (Shenzhen) Co. Ltd' },
    ]);
  });

  it('author with nickname AND institution with abbreviation', () => {
    expect(parseAff(mkPaper('Steven (Jiaxun) Tang (University of Massachusetts Amherst)'))).toEqual([
      { author: 'Steven (Jiaxun) Tang', inst: 'University of Massachusetts Amherst' },
    ]);
  });

  it('no institution (segment has no parens)', () => {
    expect(parseAff(mkPaper('South China University of Technology'))).toEqual([
      { author: 'South China University of Technology', inst: '' },
    ]);
  });

  it('multiple semicolon-separated entries', () => {
    expect(parseAff(mkPaper('An Ran Chen (University of Alberta); Tse-Hsun (Peter) Chen (Concordia University); Shaowei Wang (University of Manitoba)'))).toEqual([
      { author: 'An Ran Chen', inst: 'University of Alberta' },
      { author: 'Tse-Hsun (Peter) Chen', inst: 'Concordia University' },
      { author: 'Shaowei Wang', inst: 'University of Manitoba' },
    ]);
  });

  it('author-only entry (no institution)', () => {
    expect(parseAff(mkPaper('Jenna DiVincenzo (Wise)'))).toEqual([
      { author: 'Jenna DiVincenzo', inst: 'Wise' },
    ]);
  });

  it('empty string', () => {
    expect(parseAff(mkPaper(''))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------
describe('normalize', () => {
  it('strips accents from common diacritics', () => {
    expect(normalize('Müller')).toBe('muller');
    expect(normalize('José')).toBe('jose');
    expect(normalize('Björn')).toBe('bjorn');
    expect(normalize('François')).toBe('francois');
    expect(normalize('Ångström')).toBe('angstrom');
  });

  it('lowercases ASCII', () => {
    expect(normalize('HELLO')).toBe('hello');
  });

  it('leaves ASCII unchanged otherwise', () => {
    expect(normalize('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(normalize('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// searchBlob uses normalize so accented names become searchable
// ---------------------------------------------------------------------------
describe('searchBlob + normalize', () => {
  const mkFullPaper = (overrides: Partial<Paper> = {}): Paper => ({
    id: 'p1', title: 'Test', abstract: '', authors: ['Jürgen Müller'],
    authorInstitutions: 'Jürgen Müller (TU München)',
    tracks: [], eventType: '', sessionTitles: [], sessions: [],
    dates: [], locations: [], urls: [],
    ...overrides,
  });

  it('author:muller matches a paper by Müller', () => {
    const blob = searchBlob(mkFullPaper());
    expect(blob).toContain('muller');
    expect(blob).toContain('jurgen');
  });

  it('fieldText author field normalizes diacritics', () => {
    expect(fieldText(mkFullPaper(), 'author')).toContain('muller');
  });

  it('fieldText inst field normalizes diacritics', () => {
    expect(fieldText(mkFullPaper(), 'inst')).toContain('munchen');
  });
});

describe('authorAff', () => {
  it('AAAI-style: institution-only list maps to authors by position', () => {
    const p: Paper = {
      ...mkPaper('MIT; Stanford University; Carnegie Mellon University'),
      authors: ['Alice Smith', 'Bob Lee', 'Carol Wang'],
    };
    expect(authorAff(p)).toEqual([
      { author: 'Alice Smith', inst: 'MIT' },
      { author: 'Bob Lee', inst: 'Stanford University' },
      { author: 'Carol Wang', inst: 'Carnegie Mellon University' },
    ]);
  });

  it('standard format: name+inst pairs aligned by position', () => {
    const p: Paper = {
      ...mkPaper('Alice Smith (MIT); Bob Lee (Stanford)'),
      authors: ['Alice Smith', 'Bob Lee'],
    };
    expect(authorAff(p)).toEqual([
      { author: 'Alice Smith', inst: 'MIT' },
      { author: 'Bob Lee', inst: 'Stanford' },
    ]);
  });

  it('name lookup fallback when count differs (more authors than aff entries)', () => {
    const p: Paper = {
      ...mkPaper('Alice Smith (MIT); Carol Wang (CMU)'),
      authors: ['Carol Wang', 'Alice Smith', 'Bob Jones'],
    };
    expect(authorAff(p)).toEqual([
      { author: 'Carol Wang', inst: 'CMU' },
      { author: 'Alice Smith', inst: 'MIT' },
      { author: 'Bob Jones', inst: '' },
    ]);
  });
});
