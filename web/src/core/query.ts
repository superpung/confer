/**
 * Field-aware query parsing and matching — no DOM, no state.
 * Shared between the browser client island and the MCP server.
 */
import type { Paper, Venue } from '../scripts/types';
import { searchBlob, fieldText, normalize, paperKey } from './text';

export type Term = { field: string; value: string; neg: boolean };

export const FIELD_ALIASES: Record<string, string> = {
  title: 'title', t: 'title',
  author: 'author', authors: 'author', au: 'author', a: 'author',
  inst: 'inst', institution: 'inst', institutions: 'inst', aff: 'inst', affiliation: 'inst', org: 'inst',
  abstract: 'abstract', abs: 'abstract',
  track: 'track', topic: 'track', tracks: 'track',
  venue: 'venue', conf: 'venue', conference: 'venue',
  event: 'event', type: 'event',
  session: 'session',
  doi: 'doi',
  keyword: 'keyword', keywords: 'keyword', kw: 'keyword',
  container: 'container', journal: 'container', booktitle: 'container',
  publisher: 'publisher',
  kind: 'kind', 'venue-kind': 'kind', vkind: 'kind', vtype: 'kind',
  category: 'category', cat: 'category', 'venue-category': 'category',
  id: 'id', year: 'year',
  date: 'date', day: 'date',
  pubdate: 'pubdate', 'publication-date': 'pubdate', published: 'pubdate',
  pages: 'pages', page: 'pages',
  len: 'len', length: 'len', words: 'len', wc: 'len',
  location: 'location', room: 'location', loc: 'location',
  tag: 'tag', tags: 'tag', label: 'tag',
  has: 'has',
  in: 'in', collection: 'in',
  oa: 'oa', 'oa-status': 'oa', openaccess: 'oa',
  status: 'status', st: 'status',
  note: 'note', notes: 'note',
  url: 'url', link: 'url',
  similar: 'similar', sim: 'similar', like: 'similar',
  sort: 'sort', orderby: 'sort', 'order-by': 'sort',
  group: 'group', 'venue-group': 'group', vgroup: 'group',
  samesession: 'samesession', 'same-session': 'samesession', session2: 'samesession',
  recent: 'recent', new: 'recent', latest: 'recent',
  series: 'series',
};

/** Tokenize into AND terms; supports field:"quoted phrase", field:bare, "quoted",
 *  bare, and a leading "-" to exclude (e.g. -author:doe, -"tool demo"). */
export function parseQuery(q: string): Term[] {
  const terms: Term[] = [];
  const re = /(-?)(?:(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const neg = m[1] === '-';
    let field = 'any';
    let value = '';
    if (m[2] !== undefined) { field = FIELD_ALIASES[m[2].toLowerCase()] ?? 'any'; value = m[3]; }
    else if (m[4] !== undefined) { field = FIELD_ALIASES[m[4].toLowerCase()] ?? 'any'; value = m[5]; }
    else value = (m[6] ?? m[7]) as string;
    value = normalize(value);
    if (value) terms.push({ field, value, neg });
  }
  return terms;
}

/** Context injected by the caller so matchQuery stays framework-agnostic. */
export interface QueryContext {
  /** Look up a Venue by its id. */
  venueById: (id: string) => Venue | undefined;
  /** Resolve user tags for a paper key (venue:id). Absent in MCP context → tag: field no-ops. */
  tagsOf?: (key: string) => string[];
  /** Resolve reading status for a paper key. Absent → status: field no-ops. */
  statusOf?: (key: string) => string;
  /** Resolve private note text for a paper key. Absent → note: field no-ops. */
  noteOf?: (key: string) => string;
  /** Return the set of paper keys similar to the given target key. Absent → similar: no-ops. */
  similarOf?: (targetKey: string) => Set<string>;
  /** Return true if the paper key is in any collection. Absent → has:collection no-ops. */
  collectionOf?: (key: string) => boolean;
  /** Current year — used by the `recent:` operator. Absent → recent: no-ops. */
  currentYear?: number;
}

/** Return true when row matches all terms (AND semantics; empty terms → always true). */
export function matchQuery(
  row: { p: Paper; v: string },
  terms: Term[],
  ctx: QueryContext,
): boolean {
  if (!terms.length) return true;
  const { p, v } = row;
  const venue = ctx.venueById(v);
  for (const t of terms) {
    if (t.field === 'has') {
      const v2 = t.value;
      let ok = false;
      if (v2 === 'pdf') ok = !!(p.pdfUrls?.[0] || p.urls.some((u) => u.toLowerCase().endsWith('.pdf')));
      else if (v2 === 'oa') ok = !!((p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean } | undefined)?.is_oa;
      else if (v2 === 'abstract' || v2 === 'abs') ok = p.abstract.trim().length > 0;
      else if (v2 === 'doi') ok = !!p.doi;
      else if (v2 === 'keyword' || v2 === 'kw') ok = (p.keywords?.length ?? 0) > 0;
      else if (v2 === 'artifact') ok = (p.artifactUrls?.length ?? 0) > 0;
      else if (v2 === 'inst' || v2 === 'institution') ok = !!p.authorInstitutions?.trim();
      else if (v2 === 'note' || v2 === 'notes') ok = !!(ctx.noteOf?.(paperKey(v, p.id)));
      else if (v2 === 'status' || v2 === 'read') ok = !!(ctx.statusOf?.(paperKey(v, p.id)) && ctx.statusOf(paperKey(v, p.id)) !== 'unread');
      else if (v2 === 'tag' || v2 === 'tags') ok = !!(ctx.tagsOf?.(paperKey(v, p.id))?.length);
      else if (v2 === 'session') ok = (p.sessionTitles?.length ?? 0) > 0;
      else if (v2 === 'date') ok = !!(p.dates?.length ?? 0);
      else if (v2 === 'location' || v2 === 'room') ok = !!(p.locations?.length ?? 0);
      else if (v2 === 'track') ok = (p.tracks?.length ?? 0) > 0;
      else if (v2 === 'url') ok = p.urls.length > 0;
      else if (v2 === 'pages' || v2 === 'page') ok = !!p.pages?.trim();
      else if (v2 === 'pubdate' || v2 === 'published') ok = !!p.publicationDate?.trim();
      else if (v2 === 'collection') ok = !!(ctx.collectionOf?.(paperKey(v, p.id)));
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    if (t.field === 'oa') {
      const oaData = (p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean; oa_status?: string } | undefined;
      const ok = !!(oaData?.is_oa && (t.value === 'any' || oaData.oa_status === t.value));
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    if (t.field === 'similar') {
      const candidateKey = paperKey(v, p.id);
      const targetKeys = t.value.includes('|') ? t.value.split('|').filter(Boolean) : [t.value];
      const ok = targetKeys.some((tk) => (ctx.similarOf?.(tk) ?? new Set<string>()).has(candidateKey));
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    if (t.field === 'sort') continue; // directive, not a filter — handled by the caller
    if (t.field === 'in') continue;   // collection filter — handled by app.ts caller, not matchQuery
    if (t.field === 'group') continue; // venue-group filter — handled by app.ts caller, not matchQuery
    if (t.field === 'samesession') continue; // session-mate filter — handled by app.ts caller, not matchQuery
    // Venue kind filter: kind:journal, kind:conference, kind:workshop
    if (t.field === 'kind') {
      const vKind = (venue?.kind ?? '').toLowerCase();
      const altsK = t.value.includes('|') ? t.value.split('|').filter(Boolean) : [t.value];
      const ok = altsK.some((a) => vKind.includes(a));
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    // Venue category filter: category:NLP, category:security
    if (t.field === 'category') {
      const vCat = (venue?.category ?? '').toLowerCase();
      const altsC = t.value.includes('|') ? t.value.split('|').filter(Boolean) : [t.value];
      const ok = altsC.some((a) => vCat.includes(a));
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    // Keyword count: keywords:>=5, keywords:1-10
    if (t.field === 'keyword') {
      const cmpMK = t.value.match(/^(>=|<=|>|<)(\d+)$/);
      const rngMK = t.value.match(/^(\d+)-(\d+)$/);
      const numMK = /^\d+$/.test(t.value);
      if (cmpMK || rngMK || numMK) {
        const cnt = p.keywords?.length ?? 0;
        let ok = false;
        if (cmpMK) {
          const n = Number(cmpMK[2]);
          ok = cmpMK[1] === '>=' ? cnt >= n : cmpMK[1] === '<=' ? cnt <= n : cmpMK[1] === '>' ? cnt > n : cnt < n;
        } else if (rngMK) {
          ok = cnt >= Number(rngMK[1]) && cnt <= Number(rngMK[2]);
        } else {
          ok = cnt === Number(t.value);
        }
        if (t.neg ? ok : !ok) return false;
        continue;
      }
    }
    // Author count: authors:>=3, authors:1, authors:2-5
    if (t.field === 'author') {
      const cmpM2 = t.value.match(/^(>=|<=|>|<)(\d+)$/);
      const rngM2 = t.value.match(/^(\d+)-(\d+)$/);
      const numM2 = /^\d+$/.test(t.value);
      if (cmpM2 || rngM2 || numM2) {
        const cnt = p.authors.length;
        let ok = false;
        if (cmpM2) {
          const n = Number(cmpM2[2]);
          ok = cmpM2[1] === '>=' ? cnt >= n : cmpM2[1] === '<=' ? cnt <= n : cmpM2[1] === '>' ? cnt > n : cnt < n;
        } else if (rngM2) {
          ok = cnt >= Number(rngM2[1]) && cnt <= Number(rngM2[2]);
        } else {
          ok = cnt === Number(t.value);
        }
        if (t.neg ? ok : !ok) return false;
        continue;
      }
    }
    // recent:N — papers from the last N years relative to currentYear
    if (t.field === 'recent') {
      if (ctx.currentYear) {
        const n = Number(t.value);
        if (!isNaN(n) && n > 0) {
          const cutoff = ctx.currentYear - n;
          const ok = (venue?.year ?? 0) >= cutoff;
          if (t.neg ? ok : !ok) return false;
          continue;
        }
      }
      continue;
    }
    // series: — filter by venue series field (e.g., series:ICSE, series:FSE)
    if (t.field === 'series') {
      const ser = (venue?.series ?? '').toLowerCase();
      const altsS = t.value.includes('|') ? t.value.split('|').filter(Boolean) : [t.value];
      const ok = altsS.some((alt) => ser.includes(alt.toLowerCase()));
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    // Year range / comparison operators: year:>=2024, year:2023-2025, year:<2026, etc.
    if (t.field === 'year') {
      const yr = venue?.year ?? 0;
      let ok = false;
      const rangeM = t.value.match(/^(\d{4})-(\d{4})$/);
      const cmpM = t.value.match(/^(>=|<=|>|<)(\d{4})$/);
      if (rangeM) {
        const [, lo, hi] = rangeM.map(Number);
        ok = yr >= lo && yr <= hi;
      } else if (cmpM) {
        const n = Number(cmpM[2]);
        ok = cmpM[1] === '>=' ? yr >= n : cmpM[1] === '<=' ? yr <= n : cmpM[1] === '>' ? yr > n : yr < n;
      } else {
        ok = String(yr).includes(t.value);
      }
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    // Date / pubdate comparison operators: date:>=2025-05, pubdate:>=2025-01
    if (t.field === 'date' || t.field === 'pubdate') {
      const dates = t.field === 'date' ? p.dates : (p.publicationDate ? [p.publicationDate] : []);
      const cmpM2 = t.value.match(/^(>=|<=|>|<)(.+)$/);
      if (cmpM2) {
        const [, op, ref] = cmpM2;
        if (!dates.length) { if (!t.neg) return false; continue; }
        const ok = dates.some((d) => {
          const d2 = d.slice(0, ref.length); // compare same prefix length
          return op === '>=' ? d2 >= ref : op === '<=' ? d2 <= ref : op === '>' ? d2 > ref : d2 < ref;
        });
        if (t.neg ? ok : !ok) return false;
        continue;
      }
    }
    // Abstract length filter: len:N, len:>N, len:N-M (word count)
    if (t.field === 'len') {
      const wc = p.abstract.trim() ? p.abstract.trim().split(/\s+/).length : 0;
      const cmpM3 = t.value.match(/^(>=|<=|>|<)(\d+)$/);
      const rngM3 = t.value.match(/^(\d+)-(\d+)$/);
      let ok = false;
      if (cmpM3) {
        const n = Number(cmpM3[2]);
        ok = cmpM3[1] === '>=' ? wc >= n : cmpM3[1] === '<=' ? wc <= n : cmpM3[1] === '>' ? wc > n : wc < n;
      } else if (rngM3) {
        ok = wc >= Number(rngM3[1]) && wc <= Number(rngM3[2]);
      } else if (/^\d+$/.test(t.value)) {
        ok = wc === Number(t.value);
      }
      if (t.neg ? ok : !ok) return false;
      continue;
    }
    // Note length filter: note:>50, note:>=100
    if (t.field === 'note') {
      const cmpMN = t.value.match(/^(>=|<=|>|<)(\d+)$/);
      const rngMN = t.value.match(/^(\d+)-(\d+)$/);
      const numMN = /^\d+$/.test(t.value);
      if (cmpMN || rngMN || numMN) {
        const noteText = ctx.noteOf?.(paperKey(v, p.id)) ?? '';
        const nlen = noteText.trim().split(/\s+/).filter(Boolean).length;
        let ok = false;
        if (cmpMN) {
          const n = Number(cmpMN[2]);
          ok = cmpMN[1] === '>=' ? nlen >= n : cmpMN[1] === '<=' ? nlen <= n : cmpMN[1] === '>' ? nlen > n : nlen < n;
        } else if (rngMN) {
          ok = nlen >= Number(rngMN[1]) && nlen <= Number(rngMN[2]);
        } else {
          ok = nlen === Number(t.value);
        }
        if (t.neg ? ok : !ok) return false;
        continue;
      }
    }
    // Tag count: tag:>=2, tag:1-5
    if (t.field === 'tag') {
      const cmpMT = t.value.match(/^(>=|<=|>|<)(\d+)$/);
      const rngMT = t.value.match(/^(\d+)-(\d+)$/);
      const numMT = /^\d+$/.test(t.value);
      if (cmpMT || rngMT || numMT) {
        const cnt = (ctx.tagsOf?.(paperKey(v, p.id)) ?? []).length;
        let ok = false;
        if (cmpMT) {
          const n = Number(cmpMT[2]);
          ok = cmpMT[1] === '>=' ? cnt >= n : cmpMT[1] === '<=' ? cnt <= n : cmpMT[1] === '>' ? cnt > n : cnt < n;
        } else if (rngMT) {
          ok = cnt >= Number(rngMT[1]) && cnt <= Number(rngMT[2]);
        } else {
          ok = cnt === Number(t.value);
        }
        if (t.neg ? ok : !ok) return false;
        continue;
      }
    }
    let hay: string;
    if (t.field === 'any') hay = `${searchBlob(p)} ${normalize(venue?.name ?? '')}`;
    else if (t.field === 'venue') hay = normalize(`${venue?.name ?? ''} ${venue?.series ?? ''} ${v}`);
    else if (t.field === 'tag') hay = (ctx.tagsOf?.(paperKey(v, p.id)) ?? []).join(' | ').toLowerCase();
    else if (t.field === 'status') hay = (ctx.statusOf?.(paperKey(v, p.id)) ?? '').toLowerCase();
    else if (t.field === 'note') hay = (ctx.noteOf?.(paperKey(v, p.id)) ?? '').toLowerCase();
    else hay = fieldText(p, t.field);
    // Support OR alternatives via pipe: author:smith|jones matches either smith or jones
    const alts = t.value.includes('|') ? t.value.split('|').filter(Boolean) : null;
    const hit = alts ? alts.some((a) => hay.includes(a)) : hay.includes(t.value);
    if (t.neg ? hit : !hit) return false;
  }
  return true;
}

/** Extract a ~160-char snippet from `text` centred on the densest-match sentence.
 *  Falls back to first 160 chars when no terms match. Terms should be raw (not pre-normalized). */
export function abstractSnippet(text: string, terms: string[]): string {
  if (!text || !terms.length) return '';
  const nfcText = text.normalize('NFC');
  const normTerms = terms.map((t) => normalize(t)).filter(Boolean);
  if (!normTerms.length) return '';
  const sentRe = /[^.!?]+(?:[.!?]+\s*|$)/g;
  const sentences: { raw: string; norm: string; start: number }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sentRe.exec(nfcText))) sentences.push({ raw: sm[0], norm: normalize(sm[0]), start: sm.index });
  let bestSent = sentences[0] ?? null;
  let bestScore = 0;
  for (const s of sentences) {
    let score = 0;
    for (const t of normTerms) score += countOcc(s.norm, t);
    if (score > bestScore) { bestScore = score; bestSent = s; }
  }
  if (!bestSent) return nfcText.slice(0, 160) + (nfcText.length > 160 ? '…' : '');
  const isFirst = bestSent.start === 0;
  const rawSent = bestSent.raw.trim();
  if (rawSent.length <= 200) {
    return (isFirst ? '' : '…') + rawSent + (bestSent.start + bestSent.raw.length < nfcText.length ? '…' : '');
  }
  const firstMatchIdx = normTerms.reduce((best, t) => {
    const idx = bestSent!.norm.indexOf(t); return idx !== -1 && (best === -1 || idx < best) ? idx : best;
  }, -1);
  const WIN = 80;
  let start = firstMatchIdx !== -1 ? Math.max(0, firstMatchIdx - WIN) : 0;
  let end = firstMatchIdx !== -1 ? Math.min(rawSent.length, firstMatchIdx + WIN) : Math.min(rawSent.length, WIN * 2);
  while (start > 0 && rawSent[start] !== ' ') start--;
  while (end < rawSent.length && rawSent[end] !== ' ') end++;
  return '…' + rawSent.slice(start, end).trim() + '…';
}

/** Count non-overlapping occurrences of needle in hay. */
export function countOcc(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/** Count occurrences of needle that start at a word boundary (after non-word char or string start). */
function countOccWB(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    const before = i > 0 ? hay[i - 1] : ' ';
    if (!/\w/.test(before)) n++;
    i += needle.length;
  }
  return n;
}

/**
 * Compute a term-frequency-based relevance score for a row against a parsed query.
 * Higher = more relevant. Weights: title×5+wb bonus, author/keyword×3, track×2, abstract×1.
 * Word-boundary matches get an extra ×1.5 multiplier on top of the base weight.
 * Negative terms, sort:, has:, and similar: directives are ignored.
 */
export function relevanceScore(row: { p: Paper; v: string }, terms: Term[]): number {
  if (!terms.length) return 0;
  const { p } = row;
  const titleNorm = normalize(p.title);
  const absNorm = normalize(p.abstract);
  let score = 0;
  for (const t of terms) {
    if (t.neg || t.field === 'sort' || t.field === 'has' || t.field === 'similar') continue;
    const nd = t.value;
    const inTitle = t.field === 'any' || t.field === 'title';
    const inAuthor = t.field === 'any' || t.field === 'author';
    const inKw = t.field === 'any' || t.field === 'keyword';
    const inTrack = t.field === 'any' || t.field === 'track';
    const inAbs = t.field === 'any' || t.field === 'abstract';
    if (inTitle) {
      const all = countOcc(titleNorm, nd), wb = countOccWB(titleNorm, nd);
      score += wb * 8 + (all - wb) * 5; // word-boundary in title: weight 8, interior: 5
    }
    if (inAuthor) score += countOcc(fieldText(p, 'author'), nd) * 3;
    if (inKw) score += countOcc(fieldText(p, 'keyword'), nd) * 3;
    if (inTrack) score += countOcc(fieldText(p, 'track'), nd) * 2;
    if (inAbs) {
      const all = countOcc(absNorm, nd), wb = countOccWB(absNorm, nd);
      score += wb * 2 + (all - wb) * 1; // word-boundary in abstract: weight 2, interior: 1
    }
  }
  return score;
}
