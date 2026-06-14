/**
 * Field-aware query parsing and matching — no DOM, no state.
 * Shared between the browser client island and the MCP server.
 */
import type { Paper, Venue } from '../scripts/types';
import { searchBlob, fieldText, paperKey } from './text';

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
  id: 'id', year: 'year',
  tag: 'tag', tags: 'tag', label: 'tag',
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
    value = value.toLowerCase();
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
    let hay: string;
    if (t.field === 'any') hay = `${searchBlob(p)} ${(venue?.name ?? '').toLowerCase()}`;
    else if (t.field === 'venue') hay = `${venue?.name ?? ''} ${venue?.series ?? ''} ${v}`.toLowerCase();
    else if (t.field === 'year') hay = String(venue?.year ?? '');
    else if (t.field === 'tag') hay = (ctx.tagsOf?.(paperKey(v, p.id)) ?? []).join(' | ').toLowerCase();
    else hay = fieldText(p, t.field);
    const hit = hay.includes(t.value);
    if (t.neg ? hit : !hit) return false;
  }
  return true;
}
