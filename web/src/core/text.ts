/**
 * Pure text/paper helpers — no DOM, no state, no localStorage.
 * Shared between the browser client island and the MCP server.
 */
import type { Paper, Venue } from '../scripts/types';

/** Canonical compound key for a paper across venues. */
export const paperKey = (venue: string, id: string) => `${venue}:${id}`;

/** Lazily-built lowercased search blob covering all searchable fields. */
export function searchBlob(p: Paper): string {
  if (p._search === undefined) {
    p._search = [
      p.id, p.title, p.abstract, p.eventType, p.authorInstitutions,
      ...p.authors, ...p.tracks, ...p.sessionTitles, ...p.locations,
      p.doi ?? '', p.publicationDate ?? '', p.publisher ?? '', p.container ?? '',
      p.volume ?? '', p.issue ?? '', p.pages ?? '',
      ...(p.keywords ?? []),
    ].join(' ').toLowerCase();
  }
  return p._search;
}

/** Split a semicolon-delimited eventType string into individual event types. */
export function eventList(p: Paper): string[] {
  return p.eventType ? p.eventType.split(';').map((s) => s.trim()).filter(Boolean) : [];
}

// authorInstitutions is a display string: "Name (Inst); Name (Inst); ...".
// Institutions can themselves contain parens (e.g. "... (HKUST)"), so we take
// the text before the first " (" as the name and the rest inside parens as inst.
export function parseAff(p: Paper): { author: string; inst: string }[] {
  if (p._aff) return p._aff;
  const out: { author: string; inst: string }[] = [];
  for (const seg of (p.authorInstitutions || '').split(';')) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf(' (');
    if (i >= 0 && s.endsWith(')')) out.push({ author: s.slice(0, i).trim(), inst: s.slice(i + 2, -1).trim() });
    else out.push({ author: s, inst: '' });
  }
  p._aff = out;
  return out;
}

/** Affiliations aligned to p.authors (by position when counts match, else by name). */
export function authorAff(p: Paper): { author: string; inst: string }[] {
  const parsed = parseAff(p);
  if (parsed.length === p.authors.length) return parsed;
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

/** Return the lowercased text for a specific search field on a paper. */
export function fieldText(p: Paper, field: string): string {
  switch (field) {
    case 'title': return p.title.toLowerCase();
    case 'author': return p.authors.join(' | ').toLowerCase();
    case 'inst': return instList(p).join(' | ').toLowerCase();
    case 'abstract': return p.abstract.toLowerCase();
    case 'track': return p.tracks.join(' | ').toLowerCase();
    case 'event': return p.eventType.toLowerCase();
    case 'session': return p.sessionTitles.join(' | ').toLowerCase();
    case 'doi': return (p.doi ?? '').toLowerCase();
    case 'keyword': return (p.keywords ?? []).join(' | ').toLowerCase();
    case 'container': return (p.container ?? '').toLowerCase();
    case 'publisher': return (p.publisher ?? '').toLowerCase();
    case 'id': return p.id.toLowerCase();
    default: return searchBlob(p);
  }
}
