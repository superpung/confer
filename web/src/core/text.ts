/**
 * Pure text/paper helpers — no DOM, no state, no localStorage.
 * Shared between the browser client island and the MCP server.
 */
import type { Paper, Venue } from '../scripts/types';

/** Canonical compound key for a paper across venues. */
export const paperKey = (venue: string, id: string) => `${venue}:${id}`;

/** Normalize a string for search: lowercase + strip combining diacritics (NFD). */
export function normalize(s: string): string {
  // eslint-disable-next-line no-misleading-character-class
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** Lazily-built lowercased search blob covering all searchable fields. */
export function searchBlob(p: Paper): string {
  if (p._search === undefined) {
    p._search = normalize([
      p.id, p.title, p.abstract, p.eventType, p.authorInstitutions,
      ...p.authors, ...p.tracks, ...p.sessionTitles, ...p.locations,
      p.doi ?? '', p.publicationDate ?? '', p.publisher ?? '', p.container ?? '',
      p.volume ?? '', p.issue ?? '', p.pages ?? '',
      ...(p.keywords ?? []),
    ].join(' '));
  }
  return p._search;
}

/** Split a semicolon-delimited eventType string into individual event types. */
export function eventList(p: Paper): string[] {
  return p.eventType ? p.eventType.split(';').map((s) => s.trim()).filter(Boolean) : [];
}

// authorInstitutions is a display string: "Name (Inst); Name (Inst); ...".
// Author names may themselves contain parens (e.g. "Tse-Hsun (Peter) Chen"),
// and institutions may also contain parens (e.g. "City Univ of New York (CUNY)").
// We find the institution by locating the '(' that matches the final ')' via a
// backwards depth scan, so nicknames in the middle of a name are never mistaken
// for the institution delimiter.
export function parseAff(p: Paper): { author: string; inst: string }[] {
  if (p._aff) return p._aff;
  const out: { author: string; inst: string }[] = [];
  for (const seg of (p.authorInstitutions || '').split(';')) {
    const s = seg.trim();
    if (!s) continue;
    if (s.endsWith(')')) {
      // Walk backwards to find the '(' that closes with the final ')'
      let depth = 0;
      let splitAt = -1;
      for (let j = s.length - 1; j >= 0; j--) {
        if (s[j] === ')') depth++;
        else if (s[j] === '(') {
          depth--;
          if (depth === 0) {
            if (j > 0 && s[j - 1] === ' ') splitAt = j - 1;
            break;
          }
        }
      }
      if (splitAt >= 0) {
        out.push({ author: s.slice(0, splitAt).trim(), inst: s.slice(splitAt + 2, -1).trim() });
      } else {
        out.push({ author: s, inst: '' });
      }
    } else {
      out.push({ author: s, inst: '' });
    }
  }
  p._aff = out;
  return out;
}

/** Affiliations aligned to p.authors (by position when counts match, else by name).
 *  Handles AAAI-style where authorInstitutions lists only institutions (no names):
 *  detected when all parsed entries have no `inst` and none of the "author" fields
 *  match any actual author name — in that case the parsed "author" fields are
 *  institution names, mapped by position. */
export function authorAff(p: Paper): { author: string; inst: string }[] {
  const parsed = parseAff(p);
  if (parsed.length === p.authors.length) {
    const authorSet = new Set(p.authors);
    const matchCount = parsed.filter((x) => authorSet.has(x.author)).length;
    if (matchCount === 0 && parsed.every((x) => x.inst === '')) {
      return p.authors.map((a, i) => ({ author: a, inst: parsed[i]?.author ?? '' }));
    }
    return parsed;
  }
  const byName = new Map(parsed.map((x) => [x.author, x.inst]));
  return p.authors.map((a) => ({ author: a, inst: byName.get(a) ?? '' }));
}

/** Deduplicated institution list for a paper. */
export function instList(p: Paper): string[] {
  if (!p._insts) p._insts = [...new Set(parseAff(p).map((x) => x.inst).filter(Boolean))];
  return p._insts;
}

/** Normalise a string for disambiguation key comparisons. */
export const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Build a per-author resolver over a set of rows: prefer an explicit author id
 *  (ORCID/OpenAlex); otherwise reuse an id learned for the same name(+institution)
 *  elsewhere in the set; otherwise fall back to a name|institution key. */
export function authorResolver(rows: { p: Paper; v: string }[]) {
  const idByNameInst = new Map<string, string>();
  const idByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { p } of rows) {
    if (!p.authorIds) continue;
    const aff = authorAff(p);
    p.authors.forEach((nm, i) => {
      const id = p.authorIds![i];
      if (!id) return;
      const n = normKey(nm);
      idByNameInst.set(`${n}|${normKey(aff[i]?.inst ?? '')}`, id);
      if (idByName.has(n) && idByName.get(n) !== id) ambiguous.add(n);
      else idByName.set(n, id);
    });
  }
  return (p: Paper, i: number): { key: string; name: string } => {
    const aff = authorAff(p);
    const nm = p.authors[i];
    const n = normKey(nm);
    const inst = normKey(aff[i]?.inst ?? '');
    const id = p.authorIds?.[i] || idByNameInst.get(`${n}|${inst}`)
      || (!ambiguous.has(n) ? idByName.get(n) : undefined) || '';
    return { key: id || (inst ? `${n}|${inst}` : n), name: nm };
  };
}

/** Stop words excluded from TF-IDF token streams. */
export const STOP_WORDS = new Set([
  'a','an','the','and','or','but','of','in','to','is','are','was','were','be','been',
  'for','on','at','by','with','as','from','this','that','these','those','it','its',
  'we','our','their','they','has','have','had','not','no','can','may','will','more',
  'each','which','when','who','than','other','into','also','such','two','three','use',
  'used','using','show','shows','paper','approach','method','model','results','based',
  'proposed','present','new','large','high','low','set','data','can','work','provide',
]);

/** Tokenise text for TF-IDF (lowercase alpha-numeric, ≥3 chars, no stop words). */
export function tfidfTokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/** Return the normalized text for a specific search field on a paper. */
export function fieldText(p: Paper, field: string): string {
  switch (field) {
    case 'title': return normalize(p.title);
    case 'author': return normalize(p.authors.join(' | '));
    case 'inst': return normalize(instList(p).join(' | '));
    case 'abstract': return normalize(p.abstract);
    case 'track': return normalize(p.tracks.join(' | '));
    case 'event': return normalize(p.eventType);
    case 'session': return normalize(p.sessionTitles.join(' | '));
    case 'doi': return (p.doi ?? '').toLowerCase();
    case 'keyword': return normalize((p.keywords ?? []).join(' | '));
    case 'container': return normalize(p.container ?? '');
    case 'publisher': return normalize(p.publisher ?? '');
    case 'id': return p.id.toLowerCase();
    case 'location': return normalize(p.locations.join(' | '));
    case 'date': return normalize(p.dates.join(' | '));
    case 'url': return (p.urls.join(' ') + ' ' + (p.pdfUrls ?? []).join(' ')).toLowerCase();
    case 'pubdate': return (p.publicationDate ?? '').toLowerCase();
    case 'pages': return (p.pages ?? '').toLowerCase();
    default: return searchBlob(p);
  }
}
