import type { Paper, Venue, SavedSearch, VenueGroup, Collection, SettingsBundle, GitHubUser, SyncMeta } from './types';
import { toBibtex, toCsv, type ExportRow } from './export';

// --- constants & storage keys ------------------------------------------
const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');
const K_SELECTED = 'confer.selected';
const K_THEME = 'confer.theme';
const K_SAVED = 'confer.savedSearches';
const K_SIDEBAR = 'confer.sidebarCollapsed';
const K_RAIL = 'confer.railCollapsed';
const K_VGROUPS = 'confer.venueGroups';      // VenueGroup[] (series-level groups)
const K_COLLECTIONS = 'confer.collections';  // Collection[] (paper collections)
const K_TAGS = 'confer.paperTags';           // Record<paperKey, string[]>
const K_NOTES = 'confer.paperNotes';         // Record<paperKey, string> — private notes
const K_STATUS = 'confer.readStatus';        // Record<paperKey, 'toread'|'reading'|'done'> — omit 'unread'
const K_SORT = 'confer.sort';               // last-used sort — local only, never synced
const K_ACCENT = 'confer.accent';            // accent color key (e.g. "sage")
const K_GH_TOKEN = 'confer.ghToken';         // GitHub gist-scoped access token
const K_GH_REFRESH = 'confer.ghRefresh';     // GitHub refresh token (when expiry is enabled)
const K_GH_EXPIRES = 'confer.ghExpires';     // epoch-ms when the access token expires
const K_GIST_ID = 'confer.gistId';           // id of the user's confer config gist
const K_GH_USER = 'confer.ghUser';           // cached GitHubUser JSON
const K_SYNC_META = 'confer.syncMeta';       // SyncMeta JSON (conflict detection)
const K_SYNC_ETAG = 'confer.syncEtag';       // ETag of the last fetched gist (conditional GET)
// Keys bundled by the settings export/import and Gist sync.
const CONFIG_KEYS = [K_VGROUPS, K_COLLECTIONS, K_TAGS, K_SAVED, K_NOTES, K_STATUS];
// OAuth broker endpoint (Netlify Function — stateless, stores nothing).
const OAUTH_BROKER = '/.netlify/functions/github-oauth';
// GitHub OAuth App client_id (public; the secret lives only in Netlify env).
// Fill this in after registering the OAuth App at github.com/settings/developers.
const GH_CLIENT_ID = import.meta.env.PUBLIC_GH_CLIENT_ID ?? '';
const REPO_URL = 'https://github.com/superpung/confer';
const PAGE = 200;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Sanitize free-text the user types for names/tags: strip control chars, collapse
// whitespace, trim, and cap length so it can't break the layout. (Output is also
// HTML-escaped via esc() at render time, so this is about tidiness, not safety.)
const NAME_MAX = 40;
const TAG_MAX = 24;
// All supported accent colors; light = the representative swatch color.
const ACCENTS: Record<string, { label: string; light: string }> = {
  clay:  { label: 'Clay',  light: '#c96442' },
  sage:  { label: 'Sage',  light: '#5a7c5a' },
  slate: { label: 'Slate', light: '#4a6e8a' },
  wine:  { label: 'Wine',  light: '#8c3a52' },
  amber: { label: 'Amber', light: '#a67a36' },
  plum:  { label: 'Plum',  light: '#7a5a8c' },
};
function cleanInput(s: string, max = NAME_MAX): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// --- helpers -----------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// Inline SVG icons (Lucide-style, inherit currentColor via the .ic class).
const ICONS = {
  moon: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  sun: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>',
  auto: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  star: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  starFilled: '<svg class="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  bookmark: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  bookmarkFilled: '<svg class="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  layers: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  pencil: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
  settings: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  externalLink: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
  network: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="7" r="2"/><circle cx="12" cy="18" r="2"/><line x1="6.8" y1="6.8" x2="10.4" y2="16.2"/><line x1="17.3" y1="8.4" x2="13.3" y2="16.4"/><line x1="6.9" y1="6.2" x2="17" y2="6.8"/></svg>',
  download: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  upload: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  link: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  github: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>',
  help: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  signout: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  extLink: '<svg style="width:12px;height:12px;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;fill:none;display:inline-block;vertical-align:middle" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
  refresh: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  chevronDown: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
  chevronUp:   '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>',
  // reading-status icons (circle outline / half-filled dot / checkmark / bookmark+plus)
  statusUnread:  '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>',
  statusToread:  '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8.5" x2="12" y2="15.5"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>',
  statusReading: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
  statusDone:    '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="8.5 12 11 14.5 15.5 9.5"/></svg>',
  // find-similar icon (two overlapping circles = venn/similarity)
  similar: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/></svg>',
  // "for you" / sparkle icon for the toolbar recommendation button
  sparkle: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.2 7.3L21.5 12l-7.3 2.2L12 21.5l-2.2-7.3L2.5 12l7.3-2.2z"/></svg>',
  // tag / label icon
  tag: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>',
  // expand / fullscreen icon (for chart enlarge)
  expand: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  // history / rotate-left icon (for config history)
  history: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v6h6"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/></svg>',
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  // Trigger auto-sync for personal data writes (theme/accent are set directly and
  // call markLocalChange() themselves; K_SYNC_META writes should never loop back).
  if (CONFIG_KEYS.includes(key)) markLocalChange();
}

function joinList(values: string[], fallback = 'Not listed') {
  return values.length ? values.join('; ') : fallback;
}
function shortList(values: string[], max = 1) {
  if (!values.length) return 'Not listed';
  const visible = values.slice(0, max).join('; ');
  const hidden = values.length - max;
  return hidden > 0 ? `${visible} +${hidden}` : visible;
}
/** Pick singular/plural noun for a count (word only; caller supplies the number). */
const plural = (n: number, one: string, many = one + 's') => (n === 1 ? one : many);
function searchBlob(p: Paper): string {
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
function eventList(p: Paper): string[] {
  return p.eventType ? p.eventType.split(';').map((s) => s.trim()).filter(Boolean) : [];
}

// --- author / institution parsing -------------------------------------
// authorInstitutions is a display string: "Name (Inst); Name (Inst); ...".
// Institutions can themselves contain parens (e.g. "... (HKUST)"), so we take
// the text before the first " (" as the name and the rest inside parens as inst.
function parseAff(p: Paper): { author: string; inst: string }[] {
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
function authorAff(p: Paper): { author: string; inst: string }[] {
  const parsed = parseAff(p);
  if (parsed.length === p.authors.length) return parsed;
  const byName = new Map(parsed.map((x) => [x.author, x.inst]));
  return p.authors.map((a) => ({ author: a, inst: byName.get(a) ?? '' }));
}
function instList(p: Paper): string[] {
  if (!p._insts) p._insts = [...new Set(parseAff(p).map((x) => x.inst).filter(Boolean))];
  return p._insts;
}

// --- author disambiguation (hybrid: id else name+institution) ----------
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Build a per-author resolver over a set of rows: prefer an explicit author id
 *  (ORCID/OpenAlex); otherwise reuse an id learned for the same name(+institution)
 *  elsewhere in the set; otherwise fall back to a name|institution key. */
function authorResolver(rows: { p: Paper; v: string }[]) {
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

// --- field-prefixed search ("author:", "title:", "inst:", …) ----------
type Term = { field: string; value: string; neg: boolean };
const FIELD_ALIASES: Record<string, string> = {
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
function parseQuery(q: string): Term[] {
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
// --- field-search smart input helpers -----------------------------------
/** Module-level ref assigned during init so render() can call it before the search handler is set up. */
let renderSearchHL: (() => void) | null = null;

/** Canonical field names shown in autocomplete (order = priority). */
const SUGGEST_FIELDS = [
  'author', 'title', 'inst', 'abstract', 'track', 'venue', 'event',
  'session', 'keyword', 'doi', 'container', 'publisher', 'year', 'id', 'tag',
];
const SUGGEST_FIELD_SET = new Set(SUGGEST_FIELDS);

/** Return the whitespace-delimited token that ends at `caret`. */
function activeToken(value: string, caret: number): string {
  const before = value.slice(0, caret);
  const m = before.match(/\S+$/);
  return m ? m[0] : '';
}

/**
 * If `token` is a prefix of exactly one canonical field (or equals one),
 * return the completion string (the part to append, including the colon).
 * Returns null when not a field prefix or token already has a colon.
 */
function fieldSuggestion(token: string): string | null {
  if (!token || token.includes(':') || token.includes('：')) return null;
  const lower = token.replace(/^-/, '').toLowerCase();
  if (!lower) return null;
  const matches = SUGGEST_FIELDS.filter((f) => f.startsWith(lower));
  if (!matches.length) return null;
  // Only suggest when exactly one match to avoid ambiguity
  if (matches.length === 1) {
    const field = matches[0];
    return field === lower ? ':' : field.slice(lower.length) + ':';
  }
  // Multiple matches: suggest only if every match shares the same prefix up to the token length
  // (i.e. no ambiguity yet)  — just return null and wait for more input
  return null;
}

/** Returns true when the query contains at least one completed recognised field: token. */
function queryHasFieldToken(value: string): boolean {
  const re = /(?:^|\s)-?(\w+)[:：]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (SUGGEST_FIELD_SET.has(m[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Normalise field prefixes in `value`:
 *  - full-width `：` → `:` (only for recognised fields)
 *  - strip spaces/tabs immediately after the colon (only for recognised fields)
 * Non-field tokens are left untouched. Returns the normalised string.
 */
function normalizeFieldTokens(value: string): string {
  return value.replace(/((?:^|\s)(-?)(\w+))([:：])([ \t]*)/g, (_, pre, neg, word, colon, sp) => {
    if (!FIELD_ALIASES[word.toLowerCase()]) return pre + colon + sp; // not a field, leave intact
    return pre + ':'; // half-width colon, drop trailing space
  });
}

/** Escape HTML for inserting into innerHTML (used only in the search-highlight overlay). */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the highlighted HTML for the search-hl overlay.
 * Wraps `word:` in .hl-field when word is a recognised field;
 * appends a .hl-ghost span with the autocomplete suffix when suggestion is active.
 */
function buildSearchHlHtml(value: string, suggestion: string | null, caretPos: number): string {
  // Match field-prefix tokens at start-of-string or after whitespace
  // Pattern: (optional leading whitespace + optional neg)(word)(colon)
  // We scan char-by-char using a simple regex without lookbehind for compatibility.
  let result = '';
  const re = /(^|\s)(-?)(\w+)([:：])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const word = m[3];
    const isField = !!FIELD_ALIASES[word.toLowerCase()];
    // Everything before this match
    if (m.index > last) result += escHtml(value.slice(last, m.index));
    if (isField) {
      // leading whitespace + neg as plain, field + colon coloured
      result += escHtml(m[1] + m[2]) + `<span class="hl-field">${escHtml(m[3] + m[4])}</span>`;
    } else {
      result += escHtml(m[1] + m[2] + m[3] + m[4]);
    }
    last = m.index + m[0].length;
  }
  if (last < value.length) result += escHtml(value.slice(last));
  // Append ghost suggestion if active and caret is at the end of the value
  if (suggestion && caretPos === value.length) {
    result += `<span class="hl-ghost">${escHtml(suggestion)}</span>`;
  }
  return result;
}

function fieldText(p: Paper, field: string): string {
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
function matchQuery(row: { p: Paper; v: string }, terms: Term[]): boolean {
  if (!terms.length) return true;
  const { p, v } = row;
  const venue = venueById.get(v);
  for (const t of terms) {
    let hay: string;
    if (t.field === 'any') hay = `${searchBlob(p)} ${(venue?.name ?? '').toLowerCase()}`;
    else if (t.field === 'venue') hay = `${venue?.name ?? ''} ${venue?.series ?? ''} ${v}`.toLowerCase();
    else if (t.field === 'year') hay = String(venue?.year ?? '');
    else if (t.field === 'tag') hay = tagsOf(key(v, p.id)).join(' | ').toLowerCase();
    else hay = fieldText(p, t.field);
    const hit = hay.includes(t.value);
    if (t.neg ? hit : !hit) return false;
  }
  return true;
}

// --- state -------------------------------------------------------------
const manifest: Venue[] = JSON.parse($('#venues-data').textContent || '[]');
const venueById = new Map(manifest.map((v) => [v.id, v]));

const state = {
  selected: new Set<string>(),
  loaded: new Map<string, Paper[]>(),
  rows: [] as { p: Paper; v: string }[],
  query: '',
  terms: [] as Term[],
  tracks: new Set<string>(),
  events: new Set<string>(),
  venuesFacet: new Set<string>(),
  tagFilter: new Set<string>(),                            // active tag filter (OR within tags)
  facetCollapsed: new Set<string>(),
  sort: 'venue',
  collection: '',                                       // active collection-filter id ('' = all)
  colSet: null as Set<string> | null,                   // memoized keys of the active collection
  groups: readJson<VenueGroup[]>(K_VGROUPS, []),
  collections: readJson<Collection[]>(K_COLLECTIONS, []),
  tags: new Map<string, string[]>(Object.entries(readJson<Record<string, string[]>>(K_TAGS, {}))),
  notes: new Map<string, string>(Object.entries(readJson<Record<string, string>>(K_NOTES, {}))),
  status: new Map<string, string>(Object.entries(readJson<Record<string, string>>(K_STATUS, {}))),
  statusFilter: '',                                          // '' = all, 'toread', 'reading', 'done'
  notesOnly: false,                                          // show only papers with notes
  sel: new Set<string>(),
  saved: readJson<SavedSearch[]>(K_SAVED, []),
  shown: PAGE,
};

const key = (v: string, id: string) => `${v}:${id}`;

// --- personal data: groups, collections, tags -------------------------
function saveGroups() { writeJson(K_VGROUPS, state.groups); }
function saveCollections() { writeJson(K_COLLECTIONS, state.collections); }
function saveTags() {
  writeJson(K_TAGS, Object.fromEntries([...state.tags].filter(([, v]) => v.length)));
}
const collectionById = (id: string) => state.collections.find((c) => c.id === id);
const collectionsOf = (k: string) => state.collections.filter((c) => c.keys.includes(k));
function tagsOf(k: string): string[] { return state.tags.get(k) ?? []; }
function noteOf(k: string): string { return state.notes.get(k) ?? ''; }
function saveNotes() {
  writeJson(K_NOTES, Object.fromEntries([...state.notes].filter(([, v]) => v)));
}
/** 'unread' is the implicit default — 'toread', 'reading', 'done' are persisted. */
function statusOf(k: string): string { return state.status.get(k) ?? 'unread'; }
function saveStatus() {
  writeJson(K_STATUS, Object.fromEntries([...state.status].filter(([, v]) => v && v !== 'unread')));
}
const STATUS_ICONS: Record<string, string> = {
  unread: ICONS.statusUnread, toread: ICONS.statusToread,
  reading: ICONS.statusReading, done: ICONS.statusDone,
};
const STATUS_NEXT: Record<string, string> = {
  unread: 'toread', toread: 'reading', reading: 'done', done: 'unread',
};
const STATUS_TITLE: Record<string, string> = {
  unread: 'Mark as to read',
  toread: 'Mark as reading (currently: to read)',
  reading: 'Mark as done (currently: reading)',
  done: 'Mark as unread (currently: done)',
};
/** Venue ids whose series belongs to the group (across all years). */
function venuesOfGroup(g: VenueGroup): string[] {
  const series = new Set(g.series);
  return manifest.filter((v) => series.has(v.series)).map((v) => v.id);
}

// --- URL state ---------------------------------------------------------
function readUrl() {
  const q = new URLSearchParams(location.search);
  const v = q.get('v');
  if (v) v.split(',').filter(Boolean).forEach((id) => state.selected.add(id));
  state.query = q.get('q') ?? '';
  state.sort = q.get('sort') ?? localStorage.getItem(K_SORT) ?? 'venue';
  state.collection = q.get('col') ?? '';
  (q.get('track') ?? '').split(',').filter(Boolean).forEach((t) => state.tracks.add(t));
  (q.get('event') ?? '').split(',').filter(Boolean).forEach((e) => state.events.add(e));
  (q.get('tags') ?? '').split(',').filter(Boolean).forEach((t) => state.tagFilter.add(t));
  state.statusFilter = q.get('status') ?? '';
  state.notesOnly = q.has('notes');
  (q.get('vf') ?? '').split(',').filter(Boolean).forEach((id) => state.venuesFacet.add(id));
  return !!v || q.has('q') || q.has('track');
}
function writeUrl() {
  const q = new URLSearchParams();
  if (state.selected.size) q.set('v', [...state.selected].join(','));
  const trimmedQuery = state.query.trim();
  if (trimmedQuery) q.set('q', trimmedQuery);
  if (state.sort !== 'venue') q.set('sort', state.sort);
  if (state.collection) q.set('col', state.collection);
  if (state.tracks.size) q.set('track', [...state.tracks].join(','));
  if (state.events.size) q.set('event', [...state.events].join(','));
  if (state.tagFilter.size) q.set('tags', [...state.tagFilter].join(','));
  if (state.statusFilter) q.set('status', state.statusFilter);
  if (state.notesOnly) q.set('notes', '1');
  if (state.venuesFacet.size) q.set('vf', [...state.venuesFacet].join(','));
  const qs = q.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  writeJson(K_SELECTED, [...state.selected]);
}

// --- data loading ------------------------------------------------------
const loadingBar = Object.assign(document.createElement('div'), { className: 'loading-bar' });
document.body.appendChild(loadingBar);

async function ensureLoaded(ids: string[], opts?: { silent?: boolean }) {
  const todo = ids.filter((id) => !state.loaded.has(id) && venueById.has(id));
  if (!todo.length) { rebuildRows(); return; }
  let done = 0;
  if (!opts?.silent) {
    loadingBar.classList.remove('done');
    loadingBar.style.width = '8%';
  }
  await Promise.all(
    todo.map(async (id) => {
      try {
        const res = await fetch(`${BASE}data/${id}.json`);
        state.loaded.set(id, res.ok ? await res.json() : []);
      } catch {
        state.loaded.set(id, []);
      }
      done += 1;
      if (!opts?.silent) loadingBar.style.width = `${8 + (done / todo.length) * 92}%`;
    }),
  );
  if (!opts?.silent) {
    loadingBar.classList.add('done');
    setTimeout(() => { loadingBar.style.width = '0'; }, 320);
  }
  rebuildRows();
}

function rebuildRows() {
  const rows: { p: Paper; v: string }[] = [];
  for (const v of manifest) {
    if (!state.selected.has(v.id)) continue;
    for (const p of state.loaded.get(v.id) ?? []) rows.push({ p, v: v.id });
  }
  state.rows = rows;
  _tfidfBuilt = false; // invalidate TF-IDF cache whenever the corpus changes
}

// --- filtering & sorting ----------------------------------------------
function matches(row: { p: Paper; v: string }): boolean {
  const { p, v } = row;
  if (state.colSet && !state.colSet.has(key(v, p.id))) return false;
  if (state.venuesFacet.size && !state.venuesFacet.has(v)) return false;
  if (state.tracks.size && !p.tracks.some((t) => state.tracks.has(t))) return false;
  if (state.events.size && !eventList(p).some((e) => state.events.has(e))) return false;
  if (state.tagFilter.size && !tagsOf(key(v, p.id)).some((t) => state.tagFilter.has(t))) return false;
  if (state.statusFilter && statusOf(key(v, p.id)) !== state.statusFilter) return false;
  if (state.notesOnly && !noteOf(key(v, p.id))) return false;
  if (!matchQuery(row, state.terms)) return false;
  return true;
}
function sortRows(rows: { p: Paper; v: string }[]) {
  const s = state.sort;
  const dateKey = (r: { p: Paper; v: string }) =>
    r.p.publicationDate || (venueById.get(r.v)?.year ? String(venueById.get(r.v)!.year) : '');
  return rows.sort((a, b) => {
    if (s === 'title') return a.p.title.localeCompare(b.p.title);
    if (s === 'authors') return (a.p.authors[0] ?? '').localeCompare(b.p.authors[0] ?? '');
    if (s === 'id') return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    if (s === 'date') {
      const da = dateKey(a); const db = dateKey(b);
      if (da && db && da !== db) return db.localeCompare(da); // newest first
      if (!da !== !db) return da ? -1 : 1;                    // undated last
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    // venue: group by manifest order, then id
    if (a.v !== b.v) return manifest.findIndex((m) => m.id === a.v) - manifest.findIndex((m) => m.id === b.v);
    return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
  });
}

// --- rendering ---------------------------------------------------------
const els = {
  topbar: $<HTMLElement>('.topbar'),
  list: $('#paperList'),
  more: $('#listMore'),
  summary: $('#resultSummary'),
  facets: $<HTMLElement>('#facets'),
  facetsWrap: $<HTMLElement>('#facetsWrap'),
  facetCount: $('#facetActiveCount'),
  railBody: $<HTMLElement>('#railBody'),
  active: $('#activeFilters'),
  exportBar: $('#exportBar'),
  selCount: $('#selCount'),
  search: $<HTMLInputElement>('#searchInput'),
  searchClear: $<HTMLButtonElement>('[data-search-clear]'),
};

let topbarResizeObserver: ResizeObserver | undefined;

function updateTopbarHeight() {
  const height = Math.ceil(els.topbar.getBoundingClientRect().height);
  if (height > 0) {
    document.documentElement.style.setProperty('--topbar-height', `${height}px`);
  }
}

function observeTopbarHeight() {
  updateTopbarHeight();
  if ('ResizeObserver' in window && !topbarResizeObserver) {
    topbarResizeObserver = new ResizeObserver(updateTopbarHeight);
    topbarResizeObserver.observe(els.topbar);
  }
  window.addEventListener('resize', updateTopbarHeight, { passive: true });
  window.addEventListener('orientationchange', updateTopbarHeight);
  document.fonts?.ready.then(updateTopbarHeight).catch(() => {});
}

function cardHtml(p: Paper, v: string): string {
  const venue = venueById.get(v)!;
  const k = key(v, p.id);
  const collected = collectionsOf(k).length > 0;
  const tags = tagsOf(k);
  const note = noteOf(k);
  const status = statusOf(k);
  const sel = state.sel.has(k);
  const authors = p.authors.length
    ? authorAff(p).map(({ author, inst }) =>
        `<span class="author${inst ? ' has-inst' : ''}">` +
          `<button class="link-author" data-author="${esc(author)}">${esc(author)}</button>` +
          (inst
            ? `<span class="author-pop"><button class="author-inst" data-inst="${esc(inst)}" title="Search papers from ${esc(inst)}">${esc(inst)}</button></span>`
            : '') +
        `</span>`).join(', ')
    : 'Not listed';
  const tracks = p.tracks.slice(0, 5).map((t) => `<button class="chip chip-track" data-track="${esc(t)}">${esc(t)}</button>`).join('');
  const extra = p.tracks.length > 5 ? `<span class="chip">+${p.tracks.length - 5} more</span>` : '';
  const tagChips = tags.map((t) =>
    `<button class="chip chip-tag" data-tag="${esc(t)}" title="Filter by tag “${esc(t)}”">${esc(t)}<span class="tag-x" data-tag-del="${esc(t)}" role="button" aria-label="Remove tag" title="Remove tag">×</span></button>`).join('');
  // Tags share the chips row with tracks (no dedicated line). The "+ tag" affordance
  // is revealed on hover (desktop) / when the card already has tags (mobile).
  const addTagBtn = `<button class="chip chip-add" data-tag-add type="button" title="Add a tag" aria-label="Add a tag">+ tag</button>`;
  // Date / location / session are hidden by default; they live inside the
  // disclosure so they appear together with the abstract when expanded.
  const publicationBits = [
    p.publicationDate,
    p.volume ? `Vol. ${p.volume}` : '',
    p.issue ? `No. ${p.issue}` : '',
    p.pages ? `pp. ${p.pages}` : '',
  ].filter(Boolean);
  const doiHtml = p.doi
    ? `<a class="meta-link" href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noreferrer" title="${esc(p.doi)}">DOI</a>`
    : '';
  const pdfHtml = p.pdfUrls?.[0]
    ? `<a class="meta-link" href="${esc(p.pdfUrls[0])}" target="_blank" rel="noreferrer">PDF</a>`
    : '';
  const artifactHtml = p.artifactUrls?.[0]
    ? `<a class="meta-link" href="${esc(p.artifactUrls[0])}" target="_blank" rel="noreferrer">Artifact</a>`
    : '';
  const hasMeta = p.dates.length || p.locations.length || p.sessionTitles.length ||
    publicationBits.length || p.container || p.publisher || doiHtml || pdfHtml || artifactHtml;
  const metaHtml = hasMeta ? `<div class="compact-meta">
      <span class="meta-item" title="${esc(joinList(p.dates))}"><strong>Date</strong>${esc(shortList(p.dates))}</span>
      <span class="meta-item" title="${esc(joinList(p.locations))}"><strong>Location</strong>${esc(shortList(p.locations))}</span>
      <span class="meta-item" title="${esc(joinList(p.sessionTitles))}"><strong>Session</strong>${esc(shortList(p.sessionTitles))}</span>
      ${p.container ? `<span class="meta-item" title="${esc(p.container)}"><strong>Published in</strong>${esc(p.container)}</span>` : ''}
      ${publicationBits.length ? `<span class="meta-item"><strong>Publication</strong>${esc(publicationBits.join(' · '))}</span>` : ''}
      ${p.publisher ? `<span class="meta-item"><strong>Publisher</strong>${esc(p.publisher)}</span>` : ''}
      ${doiHtml || pdfHtml || artifactHtml ? `<span class="meta-item meta-links"><strong>Links</strong>${doiHtml}${pdfHtml}${artifactHtml}</span>` : ''}
    </div>` : '';
  const noteHtml = note ? `<p class="disc-note"><strong>Note:</strong> ${esc(note)}</p>` : '';
  const similarBtn = `<button class="icon-btn similar-btn" data-find-similar="${esc(k)}" type="button" title="Find similar papers (global search)" aria-label="Find similar papers">${ICONS.similar}</button>`;
  const discInner = noteHtml + (p.abstract ? `<p class="disc-text">${esc(p.abstract)}</p>` : '') + metaHtml + (p.abstract || hasMeta ? `<div class="disc-actions">${similarBtn}</div>` : '');
  // The title is the toggle: clicking it expands the disclosure, and the whole
  // card animates height via the grid-template-rows 0fr↔1fr trick. Papers with
  // nothing to reveal render a plain (non-interactive) title.
  const discId = `disc-${k.replace(/[^a-z0-9_-]/gi, '-')}`;
  const titleHtml = discInner
    ? `<h2 class="paper-title"><button class="title-toggle" type="button" data-card-toggle aria-expanded="false" aria-controls="${discId}">${esc(p.title)}<span class="title-caret" aria-hidden="true">▾</span></button></h2>`
    : `<h2 class="paper-title">${esc(p.title)}</h2>`;
  const disc = discInner
    ? `<div class="paper-disc"><div class="disc-collapse" id="${discId}"><div class="disc-inner">${discInner}</div></div></div>`
    : '';
  return `<article class="paper-card${sel ? ' is-selected' : ''}" data-key="${esc(k)}">
    <span class="card-select"><input type="checkbox" data-sel ${sel ? 'checked' : ''} aria-label="Select"></span>
    <div class="card-top">
      <div class="card-head">
        <button class="venue-badge" data-venue-badge title="Filter results to ${esc(venue.name)} (click to toggle; use Filters panel to remove)">${esc(venue.name)}</button>
        <span class="paper-id">${esc(p.id)}</span>
      </div>
      <div class="card-actions">
        <button class="icon-btn status-btn status-btn--${status}" data-status-cycle title="${STATUS_TITLE[status]}" aria-label="${STATUS_TITLE[status]}">${STATUS_ICONS[status]}</button>
        <button class="icon-btn note-btn${note ? ' is-on' : ''}" data-note-edit title="${note ? `Note: ${esc(note)}` : 'Add a note'}" aria-label="Note">${ICONS.pencil}</button>
        <button class="icon-btn collect-btn${collected ? ' is-on' : ''}" data-collect data-pop-anchor aria-pressed="${collected}" title="${collected ? 'In a collection — edit' : 'Add to a collection'}">${collected ? ICONS.bookmarkFilled : ICONS.bookmark}</button>
      </div>
    </div>
    ${titleHtml}
    <p class="paper-authors">${authors}</p>
    ${disc}
    <div class="chips${tags.length ? ' has-tags' : ''}">${tracks}${extra}${tagChips}${addTagBtn}</div>
    ${p.urls[0] ? `<a class="icon-btn program-link" href="${esc(p.urls[0])}" target="_blank" rel="noreferrer" title="Open program page" aria-label="Open program page">${ICONS.externalLink}</a>` : ''}
  </article>`;
}

// --- dynamic scroll-fade helpers --------------------------------------
// Toggle .is-fade-top / .is-fade-bottom on a scroll container so the CSS
// mask gradient only appears on edges that actually have hidden content.
const FADE_SEL = '.settings-body, .entity-body, .facet-options, .pop-list';
function updateScrollFade(el: HTMLElement) {
  el.classList.toggle('is-fade-top', el.scrollTop > 1);
  el.classList.toggle('is-fade-bottom',
    Math.ceil(el.scrollTop + el.clientHeight) < el.scrollHeight - 1);
}
function refreshScrollFades() {
  document.querySelectorAll<HTMLElement>(FADE_SEL).forEach(updateScrollFade);
}

function renderFacets(base: { p: Paper; v: string }[]) {
  const trackCount = new Map<string, number>();
  const eventCount = new Map<string, number>();
  const venueCount = new Map<string, number>();
  for (const { p, v } of base) {
    for (const t of new Set(p.tracks)) trackCount.set(t, (trackCount.get(t) ?? 0) + 1);
    for (const e of new Set(eventList(p))) eventCount.set(e, (eventCount.get(e) ?? 0) + 1);
    venueCount.set(v, (venueCount.get(v) ?? 0) + 1);
  }
  const group = (title: string, counts: Map<string, number>, active: Set<string>, kind: string, label: (id: string) => string) => {
    const opts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!opts.length) return '';
    const collapsed = state.facetCollapsed.has(title);
    const rows = opts.map(([val, n]) =>
      `<label class="facet-option"><input type="checkbox" data-facet="${kind}" value="${esc(val)}" ${active.has(val) ? 'checked' : ''}>
        <span class="facet-label">${esc(label(val))}</span><span class="facet-count">${n}</span></label>`).join('');
    return `<div class="facet-group${collapsed ? ' is-collapsed' : ''}" data-facet-group="${esc(title)}">
      <button class="facet-title" type="button" data-facet-group-toggle aria-expanded="${!collapsed}">
        <span class="facet-caret">▾</span><span class="facet-title-text">${title}</span><span class="facet-group-count">${opts.length}</span>
      </button>
      <div class="facet-collapse"><div class="facet-options">${rows}</div></div>
    </div>`;
  };
  const venueGroup = (state.selected.size > 1 || state.venuesFacet.size > 0)
    ? group('Venue', venueCount, state.venuesFacet, 'venue', (id) => venueById.get(id)?.name ?? id) : '';
  els.facets.innerHTML =
    group('Track', trackCount, state.tracks, 'track', (x) => x) +
    group('Event type', eventCount, state.events, 'event', (x) => x) +
    venueGroup;
  const activeN = state.tracks.size + state.events.size + state.venuesFacet.size;
  els.facetCount.textContent = String(activeN);
  els.facetCount.hidden = activeN === 0;
  requestAnimationFrame(refreshScrollFades);
}

function renderActiveFilters() {
  const chips: string[] = [];
  const add = (kind: string, val: string, label: string) =>
    chips.push(`<span class="filter-chip">${esc(label)}<button data-remove-filter data-kind="${kind}" data-val="${esc(val)}" aria-label="Remove">×</button></span>`);
  if (state.query.trim()) add('query', '', `”${state.query.trim()}”`);
  state.tracks.forEach((t) => add('track', t, t));
  state.events.forEach((e) => add('event', e, e));
  state.venuesFacet.forEach((v) => add('venue', v, venueById.get(v)?.name ?? v));
  state.tagFilter.forEach((t) => add('tagfilter', t, `tag: ${t}`));
  if (state.statusFilter) add('statusfilter', state.statusFilter, `status: ${state.statusFilter}`);
  if (state.notesOnly) add('notesonly', '', 'has notes');
  if (chips.length > 1) {
    chips.push('<button class="filter-clear" data-clear-filters type="button">Clear all</button>');
  }
  els.active.innerHTML = chips.join('');
}

function clearFilters() {
  state.query = '';
  state.tracks.clear();
  state.events.clear();
  state.venuesFacet.clear();
  state.tagFilter.clear();
  state.statusFilter = '';
  state.notesOnly = false;
  state.shown = PAGE;
  writeUrl();
  render();
}

// --- right rail: insights for the current view ------------------------
// Maps a Top-authors bar key (disambiguated) back to a display name for clicks.
let railAuthorName = new Map<string, string>();
// Cached gist revisions keyed by version SHA (lazy-loaded on demand).
const revisionCache = new Map<string, SettingsBundle>();
// Latest topic trend data for the enlarge modal; null when chart is not rendered.
let railTrend: { years: number[]; series: { track: string; counts: number[] }[] } | null = null;
function barChart(
  title: string, counts: Map<string, number>, kind: string, n: number,
  opts: { order?: 'count' | 'key'; label?: (k: string) => string; action?: string } = {},
): string {
  const label = opts.label ?? ((k) => k);
  const entries = [...counts.entries()].sort(opts.order === 'key'
    ? (a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })
    : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = entries.slice(0, n);
  if (!top.length) return '';
  const max = Math.max(...top.map(([, c]) => c)) || 1;
  const rows = top.map(([val, c]) =>
    `<button class="bar-row" data-chart="${kind}" data-val="${esc(val)}" title="${esc(label(val))} — ${c}">
      <span class="bar-top"><span class="bar-label">${esc(label(val))}</span><span class="bar-count">${c}</span></span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, Math.round((c / max) * 100))}%"></span></span>
    </button>`).join('');
  return `<section class="rail-section">
    <div class="rail-section-head"><h3 class="rail-section-title">${title}</h3>${opts.action ?? ''}</div>
    <div class="bar-list">${rows}</div></section>`;
}

function renderRail(filtered: { p: Paper; v: string }[]) {
  if (!filtered.length) {
    els.railBody.innerHTML = `<p class="rail-empty">No papers in view.</p>`;
    return;
  }
  const instCount = new Map<string, number>();
  const authorCount = new Map<string, number>();
  const trackCount = new Map<string, number>();
  const resolveAuthor = authorResolver(filtered);
  railAuthorName = new Map<string, string>();
  for (const { p } of filtered) {
    for (const inst of instList(p)) instCount.set(inst, (instCount.get(inst) ?? 0) + 1);
    const seen = new Set<string>();
    p.authors.forEach((_, i) => {
      const { key, name } = resolveAuthor(p, i);
      if (seen.has(key)) return;
      seen.add(key);
      authorCount.set(key, (authorCount.get(key) ?? 0) + 1);
      const cur = railAuthorName.get(key);
      if (!cur || name.length > cur.length) railAuthorName.set(key, name);
    });
    for (const t of new Set(p.tracks)) trackCount.set(t, (trackCount.get(t) ?? 0) + 1);
  }
  const readingN = filtered.filter((r) => statusOf(key(r.v, r.p.id)) === 'reading').length;
  const doneN = filtered.filter((r) => statusOf(key(r.v, r.p.id)) === 'done').length;
  const stat = (n: number, label: string, cls = '') =>
    `<div class="rail-stat${cls ? ` ${cls}` : ''}"><span class="rail-stat-n">${n.toLocaleString()}</span><span class="rail-stat-l">${label}</span></div>`;
  const summary = `<div class="rail-stats">
    ${stat(filtered.length, plural(filtered.length, 'paper'))}
    ${stat(authorCount.size, plural(authorCount.size, 'author'))}
    ${stat(instCount.size, plural(instCount.size, 'institution'))}
    ${readingN ? stat(readingN, 'reading', 'rail-stat--reading') : ''}
    ${doneN ? stat(doneN, 'done', 'rail-stat--done') : ''}
  </div>`;
  const netBtn = (mode: string, label: string) =>
    `<button class="rail-net-btn" data-open-network="${mode}" title="${label}" aria-label="${label}">${ICONS.network}</button>`;
  railTrend = computeTrend(filtered);
  const trendBtn = railTrend
    ? `<button class="rail-net-btn" data-open-trend title="Topic trends" aria-label="Topic trends">${ICONS.expand}</button>`
    : '';
  els.railBody.innerHTML =
    summary +
    barChart('Top institutions', instCount, 'inst', 8, { action: netBtn('inst', 'Institution network') }) +
    barChart('Top authors', authorCount, 'author', 8, { label: (k) => railAuthorName.get(k) ?? k, action: netBtn('author', 'Co-author network') }) +
    barChart('Top tracks', trackCount, 'track', 6, { action: trendBtn });
}

// --- topic trend chart ---------------------------------------------------
const TREND_PALETTE = ['var(--accent)', '#5a7c5a', '#4a6e8a', '#8c3a52', '#a67a36'];

/** Render an inline SVG line chart for top track counts across years. */
function trendSvg(
  years: number[],
  series: { track: string; counts: number[] }[],
  opts: { big?: boolean } = {},
): string {
  const W = opts.big ? 560 : 220;
  const H = opts.big ? 210 : 105;
  const pad = opts.big
    ? { t: 12, r: 10, b: 28, l: 34 }
    : { t: 8, r: 6, b: 18, l: 26 };
  const iW = W - pad.l - pad.r;
  const iH = H - pad.t - pad.b;
  const n = years.length;
  const allCounts = series.flatMap((s) => s.counts);
  const maxCount = Math.max(...allCounts, 1);

  const xAt = (i: number) => pad.l + (n <= 1 ? iW / 2 : (i / (n - 1)) * iW);
  const yAt = (c: number) => pad.t + iH - (c / maxCount) * iH;

  const gridLines = opts.big
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = (pad.t + iH * (1 - f)).toFixed(1);
        const cnt = Math.round(f * maxCount);
        return `<line x1="${pad.l}" y1="${y}" x2="${(W - pad.r).toFixed(1)}" y2="${y}" stroke="var(--line)" stroke-width="0.5"/>
        <text x="${(pad.l - 4).toFixed(1)}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--faint)">${cnt}</text>`;
      }).join('')
    : '';

  const lines = series.map((s, ci) => {
    if (n < 2) return '';
    const pts = s.counts.map((c, i) => `${xAt(i).toFixed(1)},${yAt(c).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${TREND_PALETTE[ci % TREND_PALETTE.length]}" stroke-width="${opts.big ? 2 : 1.5}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');

  const dots = series.flatMap((s, ci) =>
    s.counts.map((c, i) =>
      `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(c).toFixed(1)}" r="${opts.big ? 3.5 : 2.5}" fill="${TREND_PALETTE[ci % TREND_PALETTE.length]}" stroke="var(--panel)" stroke-width="1.5"/>`
    )
  ).join('');

  const xLabels = years.map((yr, i) =>
    `<text x="${xAt(i).toFixed(1)}" y="${(H - pad.b + (opts.big ? 14 : 11)).toFixed(1)}" text-anchor="middle" font-size="${opts.big ? 9 : 8}" fill="var(--faint)">${yr}</text>`
  ).join('');

  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Topic trends by year">
    ${gridLines}${lines}${dots}${xLabels}
  </svg>`;
}

/** Compute topic trend data (top 5 tracks across years) for the selected papers.
 *  Returns null when fewer than 2 distinct years are present. */
function computeTrend(filtered: { p: Paper; v: string }[]): typeof railTrend {
  const trackYearMap = new Map<string, Map<number, number>>();
  for (const { p, v } of filtered) {
    const yr = venueById.get(v)?.year
      ?? (p.publicationDate ? Number(p.publicationDate.slice(0, 4)) || null : null);
    if (!yr) continue;
    for (const t of new Set(p.tracks)) {
      if (!trackYearMap.has(t)) trackYearMap.set(t, new Map());
      const m = trackYearMap.get(t)!;
      m.set(yr, (m.get(yr) ?? 0) + 1);
    }
  }

  const yearSet = new Set<number>();
  for (const m of trackYearMap.values()) m.forEach((_, yr) => yearSet.add(yr));
  const years = [...yearSet].sort((a, b) => a - b);

  if (years.length < 2) return null;

  // Top 5 tracks by total count
  const totals = [...trackYearMap.entries()]
    .map(([t, m]) => ({ t, total: [...m.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const topTracks = totals.slice(0, 5).map((x) => x.t);

  const series = topTracks.map((t) => ({
    track: t,
    counts: years.map((yr) => trackYearMap.get(t)?.get(yr) ?? 0),
  }));
  return { years, series };
}

/** Open the trend enlarge modal with a bigger SVG chart. */
function openTrend() {
  if (!railTrend) return;
  const body = document.querySelector<HTMLElement>('#trendBody');
  if (!body) return;
  const { years, series } = railTrend;
  const legendItems = series.map((s, i) =>
    `<div class="trend-legend-item"><span class="trend-legend-dot" style="background:${TREND_PALETTE[i % TREND_PALETTE.length]}"></span><span class="trend-legend-label">${esc(s.track)}</span></div>`
  ).join('');
  body.innerHTML = `<div class="trend-modal-chart">${trendSvg(years, series, { big: true })}</div>
    <div class="trend-legend trend-legend--big">${legendItems}</div>`;
  const modal = document.querySelector<HTMLElement>('#trendModal');
  if (modal) modal.hidden = false;
}

// --- similar-papers / recommend modal renderer ---
function miniCardHtml(p: Paper, v: string): string {
  const venue = venueById.get(v)!;
  const k = key(v, p.id);
  const note = noteOf(k);
  const status = statusOf(k);
  const statusCls = status !== 'unread' ? ` mini-card--${status}` : '';
  const collected = collectionsOf(k).length > 0;
  const checked = recPanelState.selected.has(k);
  const authorBtns = p.authors.slice(0, 5).map((a) =>
    `<button class="mini-author" data-mini-author="${esc(a)}" type="button">${esc(a)}</button>`
  ).join(', ') + (p.authors.length > 5 ? ` +${p.authors.length - 5}` : '');
  const tagged = tagsOf(k).length > 0;
  const actions = `<div class="mini-card-actions">
    <button class="icon-btn status-btn status-btn--${status}" data-mini-status="${esc(k)}" type="button" title="${STATUS_TITLE[status]}" aria-label="${STATUS_TITLE[status]}">${STATUS_ICONS[status]}</button>
    <button class="icon-btn note-btn${note ? ' is-on' : ''}" data-mini-note="${esc(k)}" type="button" title="${note ? 'Edit note' : 'Add a note'}" aria-label="Note">${ICONS.pencil}</button>
    <button class="icon-btn collect-btn${collected ? ' is-on' : ''}" data-mini-collect="${esc(k)}" data-pop-anchor type="button" title="${collected ? 'In a collection — edit' : 'Add to collection'}" aria-label="Collection">${collected ? ICONS.bookmarkFilled : ICONS.bookmark}</button>
    <button class="icon-btn tag-btn${tagged ? ' is-on' : ''}" data-mini-tag="${esc(k)}" type="button" title="${tagged ? 'Edit tags' : 'Add a tag'}" aria-label="Tags">${ICONS.tag}</button>
  </div>`;
  return `<div class="mini-card${statusCls}" data-mini-key="${esc(k)}">
    <input class="mini-card-sel" type="checkbox" data-mini-sel="${esc(k)}" ${checked ? 'checked' : ''} aria-label="Select">
    <button class="venue-badge" data-mini-venue="${esc(v)}" type="button">${esc(venue.name)}</button>
    <div class="mini-card-body">
      <button class="mini-card-title-btn" data-mini-search="${esc(p.title)}" type="button" title="${esc(p.title)}">${esc(p.title)}</button>
      <p class="mini-card-authors">${authorBtns}</p>
    </div>
    ${actions}
  </div>`;
}

// --- author co-authorship network (modal, canvas force layout) --------
type NetNode = { key: string; name: string; papers: number; r: number; x: number; y: number; vx: number; vy: number };
type NetEdge = { s: number; t: number; w: number };
const net: {
  raf: number; nodes: NetNode[]; edges: NetEdge[]; hover: number;
  onMove?: (e: MouseEvent) => void; onClick?: (e: MouseEvent) => void; onResize?: () => void;
} = { raf: 0, nodes: [], edges: [], hover: -1 };

function buildNetwork(mode: 'author' | 'inst'): { nodes: NetNode[]; edges: NetEdge[] } {
  const filtered = state.rows.filter(matches);
  const resolve = mode === 'author' ? authorResolver(filtered) : null;
  const itemsOf = (p: Paper): { key: string; name: string }[] => {
    if (mode === 'inst') return instList(p).map((x) => ({ key: x, name: x }));
    const seen = new Map<string, string>();
    p.authors.forEach((_, i) => { const r = resolve!(p, i); if (!seen.has(r.key)) seen.set(r.key, r.name); });
    return [...seen].map(([key, name]) => ({ key, name }));
  };
  const count = new Map<string, number>();
  const nameByKey = new Map<string, string>();
  for (const { p } of filtered) for (const it of itemsOf(p)) {
    count.set(it.key, (count.get(it.key) ?? 0) + 1);
    const cur = nameByKey.get(it.key);
    if (!cur || it.name.length > cur.length) nameByKey.set(it.key, it.name);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 60);
  const idx = new Map(top.map(([k], i) => [k, i]));
  const nodes: NetNode[] = top.map(([key, papers], i) => {
    const ang = (i / top.length) * Math.PI * 2;
    return { key, name: nameByKey.get(key) ?? key, papers, r: 4 + Math.sqrt(papers) * 2.2, x: Math.cos(ang) * 180, y: Math.sin(ang) * 180, vx: 0, vy: 0 };
  });
  const ew = new Map<string, number>();
  for (const { p } of filtered) {
    const ids = [...new Set(itemsOf(p).map((it) => it.key))]
      .map((k) => idx.get(k)).filter((i): i is number => i !== undefined).sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const e = `${ids[i]}-${ids[j]}`; ew.set(e, (ew.get(e) ?? 0) + 1);
    }
  }
  const edges: NetEdge[] = [...ew.entries()].map(([e, w]) => {
    const [s, t] = e.split('-').map(Number); return { s, t, w };
  });
  return { nodes, edges };
}

function openNetwork(mode: 'author' | 'inst') {
  stopNetwork();
  // On mobile the rail is an off-canvas drawer; close it so the modal opens over
  // a clean, full-viewport page (and centers correctly).
  $('#app').classList.remove('rail-open', 'sidebar-open');
  $('#networkModal').hidden = false;
  $('#networkTitle').textContent = mode === 'inst' ? 'Institution network' : 'Co-author network';
  const { nodes, edges } = buildNetwork(mode);
  net.nodes = nodes; net.edges = edges; net.hover = -1;
  const canvas = $<HTMLCanvasElement>('#networkCanvas');
  $('#networkEmpty').hidden = nodes.length >= 2;
  canvas.hidden = nodes.length < 2;
  if (nodes.length < 2) return;
  const ctx = canvas.getContext('2d')!;
  const css = getComputedStyle(document.documentElement);
  const col = {
    node: css.getPropertyValue('--accent').trim() || '#c96442',
    edge: css.getPropertyValue('--line-strong').trim() || '#d9d6ca',
    text: css.getPropertyValue('--text').trim() || '#1a1a18',
    hi: css.getPropertyValue('--accent-dark').trim() || '#b1543a',
  };
  let W = 0, H = 0;
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  for (const n of net.nodes) { n.x += W / 2; n.y += H / 2; }

  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = col.edge;
    for (const e of net.edges) {
      const a = net.nodes[e.s], b = net.nodes[e.t];
      ctx.globalAlpha = Math.min(0.5, 0.1 + e.w * 0.12);
      ctx.lineWidth = Math.min(3, e.w);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < net.nodes.length; i++) {
      const n = net.nodes[i];
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = i === net.hover ? col.hi : col.node;
      ctx.fill();
    }
    ctx.fillStyle = col.text;
    ctx.font = `11px ${css.getPropertyValue('--sans') || 'sans-serif'}`;
    ctx.textAlign = 'center';
    const labeled = new Set<number>(
      [...net.nodes.keys()].sort((a, b) => net.nodes[b].papers - net.nodes[a].papers).slice(0, 10));
    if (net.hover >= 0) labeled.add(net.hover);
    for (const i of labeled) { const n = net.nodes[i]; ctx.fillText(n.name, n.x, n.y - n.r - 3); }
  };
  const tick = () => {
    const ns = net.nodes;
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const dx = ns[i].x - ns[j].x, dy = ns[i].y - ns[j].y;
      const d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2), f = 1400 / d2;
      const ux = dx / d, uy = dy / d;
      ns[i].vx += ux * f; ns[i].vy += uy * f; ns[j].vx -= ux * f; ns[j].vy -= uy * f;
    }
    for (const e of net.edges) {
      const a = ns[e.s], b = ns[e.t];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01, f = (d - 70) * 0.01;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
    }
    for (const n of ns) {
      n.vx += (W / 2 - n.x) * 0.004; n.vy += (H / 2 - n.y) * 0.004;
      n.vx *= 0.86; n.vy *= 0.86; n.x += n.vx; n.y += n.vy;
    }
    draw();
    net.raf = requestAnimationFrame(tick);
  };
  const nodeAt = (mx: number, my: number) => {
    for (let i = net.nodes.length - 1; i >= 0; i--) {
      const n = net.nodes[i], dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return i;
    }
    return -1;
  };
  net.onMove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    net.hover = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    canvas.style.cursor = net.hover >= 0 ? 'pointer' : 'default';
  };
  net.onClick = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const i = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (i >= 0) { const name = net.nodes[i].name; closeModals(); setQuery(`${mode}:"${name}"`); }
  };
  net.onResize = resize;
  canvas.addEventListener('mousemove', net.onMove);
  canvas.addEventListener('click', net.onClick);
  window.addEventListener('resize', net.onResize);
  net.raf = requestAnimationFrame(tick);
}

function stopNetwork() {
  if (net.raf) cancelAnimationFrame(net.raf);
  net.raf = 0;
  const canvas = document.querySelector<HTMLCanvasElement>('#networkCanvas');
  if (canvas && net.onMove) canvas.removeEventListener('mousemove', net.onMove);
  if (canvas && net.onClick) canvas.removeEventListener('click', net.onClick);
  if (net.onResize) window.removeEventListener('resize', net.onResize);
}

function render() {
  state.terms = parseQuery(state.query);
  // a stale collection id (e.g. deleted) falls back to "all"
  if (state.collection && !collectionById(state.collection)) state.collection = '';
  state.colSet = state.collection ? new Set(collectionById(state.collection)!.keys) : null;
  // reflect simple controls (don't overwrite search while user is typing)
  if (els.search !== document.activeElement) {
    els.search.value = state.query;
    renderSearchHL?.();
  }
  els.searchClear.hidden = !state.query.trim();
  reflectSort();
  reflectCollectionFilter();
  reflectTagFilter();
  reflectStatusFilter();
  reflectNotesFilter();

  if (!state.selected.size) {
    els.list.innerHTML = `<div class="empty-state"><h2>No venues selected</h2><p>Pick one or more venues from the left to browse their papers.</p></div>`;
    els.summary.textContent = 'Select a venue to begin.';
    els.facets.innerHTML = '';
    renderRail([]);
    renderActiveFilters();
    updateExportBar();
    els.more.hidden = true;
    return;
  }

  const facetBase = state.rows.filter((r) => {
    if (state.colSet && !state.colSet.has(key(r.v, r.p.id))) return false;
    if (!matchQuery(r, state.terms)) return false;
    return true;
  });
  renderFacets(facetBase);

  const filtered = sortRows(state.rows.filter(matches));
  renderRail(filtered);
  const slice = filtered.slice(0, state.shown);
  els.list.innerHTML = slice.length
    ? slice.map((r) => cardHtml(r.p, r.v)).join('')
    : `<div class="empty-state"><h2>No matching papers</h2><p>Try clearing the search or filters.</p></div>`;

  const venuesShown = new Set(filtered.map((r) => r.v)).size;
  els.summary.textContent = `${filtered.length.toLocaleString()} of ${state.rows.length.toLocaleString()} papers · ${venuesShown} ${plural(venuesShown, 'venue')}`;

  if (filtered.length > state.shown) {
    els.more.hidden = false;
    els.more.innerHTML = `<button class="text-btn" id="showMore">Show ${Math.min(PAGE, filtered.length - state.shown)} more (${filtered.length - state.shown} hidden)</button>`;
  } else {
    els.more.hidden = true;
  }
  renderActiveFilters();
  updateExportBar();
}

function updateExportBar() {
  const n = state.sel.size;
  els.exportBar.hidden = n === 0;
  els.selCount.textContent = `${n} selected`;
}

// --- sidebar -----------------------------------------------------------
function reflectSidebar() {
  document.querySelectorAll<HTMLInputElement>('[data-venue-check]').forEach((cb) => {
    cb.checked = state.selected.has(cb.value);
    cb.closest('.venue-row')?.classList.toggle('is-active', cb.checked);
  });
  // Series "select all" checkbox reflects its years: checked / indeterminate / off.
  document.querySelectorAll<HTMLElement>('.venue-series').forEach((series) => {
    const master = series.querySelector<HTMLInputElement>('[data-series-check]');
    if (!master) return;
    const checks = series.querySelectorAll<HTMLInputElement>('[data-venue-check]');
    const sel = [...checks].filter((c) => c.checked).length;
    master.checked = sel > 0 && sel === checks.length;
    master.indeterminate = sel > 0 && sel < checks.length;
  });
  renderVenueGroups();
}

function setVenue(id: string, on: boolean) {
  setVenues([id], on);
}

function setVenues(ids: string[], on: boolean) {
  for (const id of ids) { if (on) state.selected.add(id); else state.selected.delete(id); }
  state.shown = PAGE;
  reflectSidebar();
  writeUrl();
  ensureLoaded([...state.selected]).then(render);
}

// Make the selection exactly `ids` (deselects everything else). Used by group chips.
function setVenuesExclusive(ids: string[]) {
  state.selected = new Set(ids);
  state.shown = PAGE;
  reflectSidebar();
  writeUrl();
  ensureLoaded([...state.selected]).then(render);
}

// Filter the sidebar by the venue-search text. Expands matching series.
function applyVenueFilter() {
  const q = $<HTMLInputElement>('[data-venue-search]').value.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>('.venue-series').forEach((series) => {
    let anyRow = false;
    series.querySelectorAll<HTMLElement>('[data-venue-row]').forEach((row) => {
      const match = q.length === 0 || (row.dataset.venueName ?? '').includes(q);
      row.hidden = !match;
      if (match) anyRow = true;
    });
    series.hidden = !anyRow;
    const collapsed = q.length === 0 ? true : !anyRow;
    series.classList.toggle('is-collapsed', collapsed);
    series.querySelector('[data-series-toggle]')?.setAttribute('aria-expanded', String(!collapsed));
  });
  document.querySelectorAll<HTMLElement>('.venue-cat').forEach((cat) => {
    cat.hidden = !cat.querySelector('.venue-series:not([hidden])');
  });
}

// --- venue groups (series-level) --------------------------------------
// "My groups" chips above the categories. Clicking a chip toggles selection of
// all venues whose series belongs to the group; ✕ deletes the group.
function renderVenueGroups() {
  const el = $('#venueGroups');
  if (!state.groups.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = state.groups.map((g) => {
    const ids = venuesOfGroup(g);
    // "active" = the selection is exactly this group (matches the click behavior).
    const active = ids.length > 0 && state.selected.size === ids.length && ids.every((id) => state.selected.has(id));
    return `<span class="group-chip${active ? ' is-active' : ''}" data-group="${g.id}">
      <button class="group-chip-main" data-group-select="${g.id}" title="${active ? 'Deselect' : 'Select'} ${esc(g.name)}">${ICONS.layers}<span class="group-chip-name">${esc(g.name)}</span><span class="group-chip-n">${ids.length}</span></button>
      <button class="group-chip-x" data-group-del="${g.id}" aria-label="Delete group" title="Delete group">×</button>
    </span>`;
  }).join('');
}

// Mark each per-series group button as "on" when that series is in ≥1 group.
function reflectSeriesGroup() {
  const inAny = new Set<string>();
  state.groups.forEach((g) => g.series.forEach((s) => inAny.add(s)));
  document.querySelectorAll<HTMLElement>('[data-series-group]').forEach((btn) => {
    const on = inAny.has(btn.dataset.seriesGroup ?? '');
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function deleteGroup(id: string) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  askConfirm({ title: 'Delete group', message: `Delete group “${g.name}”?`, ok: 'Delete', danger: true }).then((ok) => {
    if (!ok) return;
    state.groups = state.groups.filter((x) => x.id !== id);
    saveGroups(); renderVenueGroups(); reflectSeriesGroup(); renderSettings();
  });
}

// --- collection filter (controls) -------------------------------------
function reflectCollectionFilter() {
  const container = document.querySelector<HTMLElement>('#collectionFilter');
  if (!container) return;
  const label = container.querySelector<HTMLElement>('.caret-select-label');
  const menu = container.querySelector<HTMLElement>('.caret-menu');
  if (label && menu) {
    const options = [
      { value: '', text: 'All papers' },
      ...state.collections.map((c) => ({ value: c.id, text: `${esc(c.name)} (${c.keys.length})` })),
    ];
    const cur = options.find((o) => o.value === state.collection) ?? options[0];
    label.textContent = cur.text;
    menu.innerHTML = options.map((o) =>
      `<li class="caret-option${o.value === state.collection ? ' is-on' : ''}" role="option" data-col-val="${esc(o.value)}">${o.text}</li>`
    ).join('');
  }
  container.hidden = state.collections.length === 0;
}

// --- popover menu (shared by collection + group pickers) --------------
// One floating menu reused for the card "add to collection" and per-series
// "add to group" pickers. The opener supplies the body HTML and a click
// handler; the menu re-renders in place so multiple toggles stay open.
const popEl = Object.assign(document.createElement('div'), { className: 'popmenu' });
popEl.hidden = true;
document.body.appendChild(popEl);
let popAnchor: HTMLElement | null = null;
let popRender: (() => string) | null = null;
let popOnPick: ((target: HTMLElement) => void) | null = null;
let popOnInput: ((value: string) => void) | null = null;

function paintPop() {
  if (!popRender) return;
  // Preserve the search input's typed value and cursor position across innerHTML swaps.
  const prevSearch = popEl.querySelector<HTMLInputElement>('.pop-search');
  const prevStart = prevSearch?.selectionStart ?? null;
  const prevEnd = prevSearch?.selectionEnd ?? null;
  const hasFocus = prevSearch === document.activeElement;
  popEl.innerHTML = popRender();
  const newSearch = popEl.querySelector<HTMLInputElement>('.pop-search');
  if (newSearch && hasFocus) {
    newSearch.focus();
    if (prevStart !== null && prevEnd !== null) {
      try { newSearch.setSelectionRange(prevStart, prevEnd); } catch { /* ignore */ }
    }
  }
  requestAnimationFrame(refreshScrollFades);
}
function positionPop(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  popEl.style.visibility = 'hidden';
  popEl.hidden = false;
  const pw = popEl.offsetWidth || 220;
  const ph = popEl.offsetHeight || 120;
  let left = r.left;
  if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  popEl.style.left = `${left + window.scrollX}px`;
  popEl.style.top = `${top + window.scrollY}px`;
  popEl.style.visibility = '';
}
function openPop(anchor: HTMLElement, render: () => string, onPick: (t: HTMLElement) => void, onInput?: (value: string) => void) {
  popAnchor = anchor; popRender = render; popOnPick = onPick; popOnInput = onInput ?? null;
  paintPop();
  positionPop(anchor);
  // (Re)trigger the entrance animation now that the menu is placed.
  popEl.classList.remove('is-in');
  void popEl.offsetWidth;
  popEl.classList.add('is-in');
}
function closePop() {
  popEl.hidden = true; popEl.innerHTML = ''; popEl.classList.remove('is-in');
  popAnchor = null; popRender = null; popOnPick = null; popOnInput = null;
}
popEl.addEventListener('click', (e) => { if (popOnPick) popOnPick(e.target as HTMLElement); });
popEl.addEventListener('input', (e) => {
  // Skip mid-composition events so IME (Chinese/Japanese/etc.) input is not interrupted
  // by paintPop() re-rendering the innerHTML. compositionend fires the update instead.
  if ((e as InputEvent).isComposing) return;
  if (popOnInput) {
    const inp = e.target as HTMLInputElement;
    if (inp.classList.contains('pop-search')) popOnInput(inp.value);
  }
});
popEl.addEventListener('compositionend', (e) => {
  if (popOnInput) {
    const inp = e.target as HTMLInputElement;
    if (inp.classList.contains('pop-search')) popOnInput(inp.value);
  }
});
document.addEventListener('click', (e) => {
  if (popEl.hidden) return;
  const t = e.target as HTMLElement;
  if (popEl.contains(t) || (popAnchor && popAnchor.contains(t))) return;
  closePop();
});

// --- custom text prompt (replaces window.prompt) ----------------------
// A small styled modal that resolves to the entered (sanitized) string, or null
// if cancelled. Only one is ever open; opening another resolves the previous.
let promptResolver: ((value: string | null) => void) | null = null;
function askText(opts: { title: string; value?: string; placeholder?: string; max?: number; ok?: string }): Promise<string | null> {
  closePop();
  if (promptResolver) settlePrompt(null);
  return new Promise((resolve) => {
    promptResolver = resolve;
    $('#promptTitle').textContent = opts.title;
    const input = $<HTMLInputElement>('#promptInput');
    input.maxLength = opts.max ?? NAME_MAX;
    input.value = opts.value ?? '';
    input.placeholder = opts.placeholder ?? '';
    $('#promptOk').textContent = opts.ok ?? 'OK';
    $('#promptModal').hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 20);
  });
}
function settlePrompt(value: string | null) {
  if (!promptResolver) return;
  const resolve = promptResolver;
  promptResolver = null;
  $('#promptModal').hidden = true;
  resolve(value);
}

// --- custom confirm dialog (replaces window.confirm) ------------------
let confirmResolver: ((v: boolean) => void) | null = null;
function askConfirm(opts: { title: string; message: string; ok?: string; danger?: boolean }): Promise<boolean> {
  closePop();
  if (confirmResolver) settleConfirm(false);
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $('#confirmTitle').textContent = opts.title;
    $('#confirmMessage').textContent = opts.message;
    const okBtn = $<HTMLButtonElement>('#confirmOk');
    okBtn.textContent = opts.ok ?? 'OK';
    okBtn.className = `text-btn ${opts.danger ? 'text-btn--danger' : 'text-btn--primary'}`;
    $('#confirmModal').hidden = false;
  });
}
function settleConfirm(value: boolean) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  $('#confirmModal').hidden = true;
  resolve(value);
}

// --- note dialog (custom preview/edit modal for per-paper notes) ------
let noteDlgKey = '';  // paper key currently open in the note dialog

function openNoteDialog(k: string) {
  closePop();
  noteDlgKey = k;
  const note = noteOf(k);
  if (note) {
    showNoteDlgPreview(note);
  } else {
    showNoteDlgEdit('');
  }
  $('#noteDialog').hidden = false;
}

function showNoteDlgPreview(text: string) {
  $('#noteDialogPreview').hidden = false;
  $('#noteDialogEditMode').hidden = true;
  $('#noteDialogText').textContent = text;
}

function showNoteDlgEdit(text: string) {
  $('#noteDialogPreview').hidden = true;
  $('#noteDialogEditMode').hidden = false;
  const ta = $<HTMLTextAreaElement>('#noteDialogTextarea');
  ta.value = text;
  updateNoteDlgChar(text.length);
  setTimeout(() => { ta.focus(); ta.setSelectionRange(text.length, text.length); }, 20);
}

function updateNoteDlgChar(len: number) {
  const el = document.querySelector<HTMLElement>('#noteDialogChar');
  if (el) el.textContent = `${len} / 500`;
}

function updateNoteCardInPlace(k: string, clean: string) {
  const card = document.querySelector<HTMLElement>(`.paper-card[data-key="${CSS.escape(k)}"]`);
  if (!card) return;
  const btn = card.querySelector<HTMLElement>('[data-note-edit]');
  if (btn) {
    btn.classList.toggle('is-on', !!clean);
    btn.title = clean ? `Note: ${clean}` : 'Add a note';
  }
  const discInner = card.querySelector<HTMLElement>('.disc-inner');
  if (discInner) {
    const existing = discInner.querySelector<HTMLElement>('.disc-note');
    if (clean) {
      if (existing) existing.innerHTML = `<strong>Note:</strong> ${esc(clean)}`;
      else {
        const el = document.createElement('p');
        el.className = 'disc-note';
        el.innerHTML = `<strong>Note:</strong> ${esc(clean)}`;
        discInner.insertBefore(el, discInner.firstChild);
      }
    } else if (existing) {
      existing.remove();
    }
  }
}

function settleNoteDlg(action: 'save' | 'delete' | 'cancel' | 'close') {
  const k = noteDlgKey;
  if (!k) { $('#noteDialog').hidden = true; return; }
  if (action === 'save') {
    const ta = $<HTMLTextAreaElement>('#noteDialogTextarea');
    const clean = ta.value.trim();
    if (clean) state.notes.set(k, clean); else state.notes.delete(k);
    saveNotes();
    updateNoteCardInPlace(k, clean);
    reflectNotesFilter();
    noteDlgKey = '';
    $('#noteDialog').hidden = true;
  } else if (action === 'delete') {
    state.notes.delete(k);
    saveNotes();
    updateNoteCardInPlace(k, '');
    reflectNotesFilter();
    noteDlgKey = '';
    $('#noteDialog').hidden = true;
  } else if (action === 'cancel') {
    // If there was a pre-existing note and we're in edit mode, go back to preview
    const note = noteOf(k);
    if (note) { showNoteDlgPreview(note); return; }
    // No pre-existing note → just close
    noteDlgKey = '';
    $('#noteDialog').hidden = true;
  } else {
    // close
    noteDlgKey = '';
    $('#noteDialog').hidden = true;
  }
}

// Collection picker for a paper key.
function openCollectPop(anchor: HTMLElement, k: string) {
  const render = () => {
    const rows = state.collections.map((c) =>
      `<div class="pop-row" data-col-toggle="${c.id}" role="button"><input type="checkbox" tabindex="-1" ${c.keys.includes(k) ? 'checked' : ''}><span class="pop-row-label">${esc(c.name)}</span><span class="pop-row-n">${c.keys.length}</span></div>`).join('');
    return `<div class="pop-title">Save to collection</div><div class="pop-list">${rows || '<p class="pop-empty">No collections yet.</p>'}</div><button class="pop-action" data-col-new type="button">＋ New collection…</button>`;
  };
  openPop(anchor, render, (t) => {
    const toggle = t.closest<HTMLElement>('[data-col-toggle]');
    if (toggle) {
      const c = collectionById(toggle.dataset.colToggle ?? '');
      if (c) {
        const i = c.keys.indexOf(k);
        if (i >= 0) c.keys.splice(i, 1); else c.keys.push(k);
        saveCollections();
        afterCollectionsChange(k);
        paintPop();
      }
      return;
    }
    if (t.closest('[data-col-new]')) {
      askText({ title: 'New collection', placeholder: 'Collection name', max: NAME_MAX }).then((name) => {
        const clean = cleanInput(name ?? '');
        if (!clean) return;
        state.collections.push({ id: uid(), name: clean, keys: [k] });
        saveCollections();
        afterCollectionsChange(k);
      });
    }
  });
}

// Group picker for a series name.
function openGroupPop(anchor: HTMLElement, series: string) {
  const render = () => {
    const rows = state.groups.map((g) =>
      `<div class="pop-row" data-group-toggle="${g.id}" role="button"><input type="checkbox" tabindex="-1" ${g.series.includes(series) ? 'checked' : ''}><span class="pop-row-label">${esc(g.name)}</span><span class="pop-row-n">${g.series.length}</span></div>`).join('');
    return `<div class=”pop-title”>Add “${esc(series)}” to group</div><div class=”pop-list”>${rows || '<p class=”pop-empty”>No groups yet.</p>'}</div><button class=”pop-action” data-group-new type=”button”>＋ New group…</button>`;
  };
  openPop(anchor, render, (t) => {
    const toggle = t.closest<HTMLElement>('[data-group-toggle]');
    if (toggle) {
      const g = state.groups.find((x) => x.id === toggle.dataset.groupToggle);
      if (g) {
        const i = g.series.indexOf(series);
        if (i >= 0) g.series.splice(i, 1); else g.series.push(series);
        saveGroups();
        renderVenueGroups(); reflectSeriesGroup(); renderSettings();
        paintPop();
      }
      return;
    }
    if (t.closest('[data-group-new]')) {
      askText({ title: 'New group', value: series, placeholder: 'Group name', max: NAME_MAX }).then((name) => {
        const clean = cleanInput(name ?? '');
        if (!clean) return;
        state.groups.push({ id: uid(), name: clean, series: [series] });
        saveGroups();
        renderVenueGroups(); reflectSeriesGroup(); renderSettings();
      });
    }
  });
}

// Account menu: avatar button opens a dropdown with View Gist + Sign out.
function openAccountMenu(anchor: HTMLElement) {
  const gistId = localStorage.getItem(K_GIST_ID);
  const render = () => {
    const gistRow = gistId
      ? `<div class="pop-row" data-account-gist role="button">${ICONS.extLink}<span class="pop-row-label">View Gist</span></div>`
      : '';
    return `${gistRow}<div class="pop-row pop-row--danger" data-account-signout role="button">${ICONS.signout}<span class="pop-row-label">Sign out</span></div>`;
  };
  openPop(anchor, render, (t) => {
    if (t.closest('[data-account-gist]')) {
      window.open(`https://gist.github.com/${gistId}`, '_blank', 'noreferrer');
      closePop();
      return;
    }
    if (t.closest('[data-account-signout]')) {
      closePop();
      signOutGitHub();
      return;
    }
  });
}

// Refresh everything that depends on collection membership after an edit.
function afterCollectionsChange(touchedKey?: string) {
  reflectCollectionFilter();
  renderSettings();
  if (touchedKey) {
    const card = els.list.querySelector<HTMLElement>(`.paper-card[data-key="${CSS.escape(touchedKey)}"]`);
    const btn = card?.querySelector<HTMLButtonElement>('[data-collect]');
    if (btn) {
      const on = collectionsOf(touchedKey).length > 0;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.innerHTML = on ? ICONS.bookmarkFilled : ICONS.bookmark;
    }
  }
  // A collection filter in effect may now include/exclude this paper; re-render
  // the list (which detaches the popover's anchor, so close it first).
  if (state.colSet) { closePop(); render(); }
}

// --- tags --------------------------------------------------------------

/** Combobox pop for adding/removing tags on a paper (replaces the plain text-prompt). */
function openTagPop(anchor: HTMLElement, k: string) {
  let filterText = '';
  const buildHtml = () => {
    const allTags = [...tagCounts().entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const cur = new Set(tagsOf(k));
    const lower = filterText.toLowerCase();
    const visible = lower ? allTags.filter(([t]) => t.toLowerCase().includes(lower)) : allTags;
    const rows = visible.map(([t, n]) =>
      `<div class="pop-row" data-tag-toggle="${esc(t)}" role="button"><input type="checkbox" tabindex="-1" ${cur.has(t) ? 'checked' : ''}><span class="pop-row-label">${esc(t)}</span><span class="pop-row-n">${n}</span></div>`
    ).join('');
    const cleanFilter = cleanInput(filterText, TAG_MAX);
    const isNewTag = cleanFilter && !allTags.some(([t]) => t === cleanFilter);
    const newAction = isNewTag
      ? `<button class="pop-action" data-tag-new="${esc(cleanFilter)}" type="button">＋ New "${esc(cleanFilter)}"</button>` : '';
    const empty = !rows && !newAction ? '<p class="pop-empty">No tags yet.</p>' : '';
    return `<div class="pop-title">Tags</div>`
      + `<input class="pop-search" type="text" placeholder="Filter or create…" value="${esc(filterText)}" autocomplete="off" spellcheck="false">`
      + `<div class="pop-list">${rows || empty}</div>` + newAction;
  };
  openPop(anchor, buildHtml, (t) => {
    const toggle = t.closest<HTMLElement>('[data-tag-toggle]');
    if (toggle) {
      const tag = toggle.dataset.tagToggle!;
      const cur = new Set(tagsOf(k));
      if (cur.has(tag)) cur.delete(tag); else cur.add(tag);
      if (cur.size) state.tags.set(k, [...cur]); else state.tags.delete(k);
      saveTags(); refreshCardTags(k); paintPop();
      return;
    }
    const newBtn = t.closest<HTMLElement>('[data-tag-new]');
    if (newBtn) {
      const tag = cleanInput(newBtn.dataset.tagNew ?? '', TAG_MAX);
      if (!tag) return;
      const cur = new Set(tagsOf(k));
      cur.add(tag);
      state.tags.set(k, [...cur]);
      saveTags(); filterText = ''; refreshCardTags(k); paintPop();
      return;
    }
  }, (val) => {
    filterText = val.slice(0, TAG_MAX * 2);
    paintPop();
  });
  // Auto-focus the search input once the pop is placed
  requestAnimationFrame(() => { popEl.querySelector<HTMLInputElement>('.pop-search')?.focus(); });
}

/** Update only the tag chips of a visible card (avoids a full re-render). */
function refreshCardTags(k: string) {
  const card = els.list.querySelector<HTMLElement>(`.paper-card[data-key="${CSS.escape(k)}"]`);
  if (!card) return;
  const chipsDiv = card.querySelector<HTMLElement>('.chips');
  if (!chipsDiv) return;
  const tags = tagsOf(k);
  chipsDiv.querySelectorAll('.chip-tag, .chip-add').forEach((el) => el.remove());
  const tagChips = tags.map((t) =>
    `<button class="chip chip-tag" data-tag="${esc(t)}" title="Filter by tag &quot;${esc(t)}&quot;">${esc(t)}<span class="tag-x" data-tag-del="${esc(t)}" role="button" aria-label="Remove tag" title="Remove tag">×</span></button>`
  ).join('');
  const addBtn = `<button class="chip chip-add" data-tag-add type="button" title="Add a tag" aria-label="Add a tag">+ tag</button>`;
  chipsDiv.insertAdjacentHTML('beforeend', tagChips + addBtn);
  chipsDiv.classList.toggle('has-tags', tags.length > 0);
}

function removeTag(k: string, tag: string) {
  const next = tagsOf(k).filter((t) => t !== tag);
  if (next.length) state.tags.set(k, next); else state.tags.delete(k);
  saveTags();
  render();
}
function tagCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const tags of state.tags.values()) for (const t of tags) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Open a pop for filtering the paper list by tag (multi-select). */
function openTagFilterPop(anchor: HTMLElement) {
  const viewTags = new Map<string, number>();
  for (const { p, v } of state.rows) {
    for (const t of tagsOf(key(v, p.id))) viewTags.set(t, (viewTags.get(t) ?? 0) + 1);
  }
  const buildHtml = () => {
    const entries = [...viewTags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const rows = entries.map(([t, n]) =>
      `<div class="pop-row" data-tag-filter-val="${esc(t)}" role="button"><input type="checkbox" tabindex="-1" ${state.tagFilter.has(t) ? 'checked' : ''}><span class="pop-row-label">${esc(t)}</span><span class="pop-row-n">${n}</span></div>`
    ).join('');
    return `<div class="pop-title">Filter by tag</div><div class="pop-list">${rows || '<p class="pop-empty">No tags yet.</p>'}</div>`;
  };
  openPop(anchor, buildHtml, (t) => {
    const row = t.closest<HTMLElement>('[data-tag-filter-val]');
    if (row) {
      const tag = row.dataset.tagFilterVal!;
      if (state.tagFilter.has(tag)) state.tagFilter.delete(tag); else state.tagFilter.add(tag);
      state.shown = PAGE; writeUrl(); render(); paintPop();
    }
  });
}

/** Sync the Tags pill button (badge count + visibility) with the current view. */
function reflectTagFilter() {
  const btn = document.querySelector<HTMLElement>('#tagFilterBtn');
  if (!btn) return;
  // Compute tags present in the current base rows (before filtering)
  const viewTags = new Set<string>();
  for (const { p, v } of state.rows) {
    for (const t of tagsOf(key(v, p.id))) viewTags.add(t);
  }
  // Prune tagFilter entries no longer in view — but only when rows are loaded.
  // At init, rows are still empty (loaded async), so skip the prune to preserve URL-loaded filters.
  if (state.rows.length) {
    for (const t of [...state.tagFilter]) { if (!viewTags.has(t)) state.tagFilter.delete(t); }
  }
  btn.hidden = viewTags.size === 0;
  btn.setAttribute('aria-expanded', String(!popEl.hidden && popAnchor === btn));
  const countEl = btn.querySelector<HTMLElement>('#tagFilterCount');
  if (countEl) {
    countEl.textContent = String(state.tagFilter.size);
    countEl.hidden = state.tagFilter.size === 0;
  }
}

/** Sync the Status filter pill (visibility + count badge). */
function reflectStatusFilter() {
  const btn = document.querySelector<HTMLElement>('#statusFilterBtn');
  if (!btn) return;
  const hasAny = state.rows.some((r) => {
    const s = statusOf(key(r.v, r.p.id));
    return s === 'toread' || s === 'reading' || s === 'done';
  });
  btn.hidden = !hasAny;
  btn.setAttribute('aria-expanded', String(!popEl.hidden && popAnchor === btn));
  const countEl = btn.querySelector<HTMLElement>('#statusFilterCount');
  if (countEl) {
    const active = state.statusFilter ? '1' : '';
    countEl.textContent = active;
    countEl.hidden = !active;
  }
}

function openStatusFilterPop(anchor: HTMLElement) {
  const counts: Record<string, number> = { toread: 0, reading: 0, done: 0 };
  for (const { p, v } of state.rows) {
    const s = statusOf(key(v, p.id));
    if (s in counts) counts[s]++;
  }
  const buildHtml = () => {
    const opts: { val: string; label: string }[] = [
      { val: 'toread', label: 'To read' },
      { val: 'reading', label: 'Reading' },
      { val: 'done', label: 'Done' },
    ].filter((o) => counts[o.val] > 0);
    const rows = opts.map((o) =>
      `<div class="pop-row" data-status-filter-val="${o.val}" role="button"><input type="checkbox" tabindex="-1" ${state.statusFilter === o.val ? 'checked' : ''}><span class="pop-row-label">${o.label}</span><span class="pop-row-n">${counts[o.val]}</span></div>`
    ).join('');
    return `<div class="pop-title">Filter by status</div><div class="pop-list">${rows || '<p class="pop-empty">No status set.</p>'}</div>`;
  };
  openPop(anchor, buildHtml, (t) => {
    const row = t.closest<HTMLElement>('[data-status-filter-val]');
    if (row) {
      const val = row.dataset.statusFilterVal!;
      state.statusFilter = state.statusFilter === val ? '' : val;
      state.shown = PAGE; writeUrl(); render(); paintPop();
    }
  });
}

/** Sync the Notes filter button (visibility + active state). */
function reflectNotesFilter() {
  const btn = document.querySelector<HTMLElement>('#notesFilterBtn');
  if (!btn) return;
  btn.hidden = state.notes.size === 0;
  btn.classList.toggle('is-active', state.notesOnly);
  btn.setAttribute('aria-pressed', String(state.notesOnly));
}

// --- toast -------------------------------------------------------------
let toastTimer = 0;
// Pending conflict resolution state (set when the conflict modal opens)
let conflictLocal: SettingsBundle | null = null;
let conflictRemote: SettingsBundle | null = null;
let conflictToken = '';
let conflictGistId = '';
// Auto-sync state
const SYNC_QUIET_MS = 5000;               // ms of inactivity before auto-pushing
const SYNC_MAX_WAIT_MS = 30_000;          // maximum ms to defer a push under continuous edits
// Exponential backoff delays for retrying failed auto-pushes (30s → 1m → 2m → 5m cap)
const SYNC_RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;
let autoSyncTimer: number | null = null;  // debounce handle for push
let syncPendingSince = 0;                 // epoch ms when the current pending batch started (0 = idle)
let syncConflictPending = false;          // true → paused, "Sync conflict — review" shown
let lastAutoPullAt = 0;                   // throttle focus-pulls (epoch ms)
let syncRetryTimer: number | null = null; // retry handle after a failed auto-push
let syncRetryAttempt = 0;                 // how many consecutive auto-push failures
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 2200);
}

// --- export & saved searches ------------------------------------------
function currentExportRows(): ExportRow[] {
  const source = state.sel.size
    ? state.rows.filter((r) => state.sel.has(key(r.v, r.p.id)))
    : sortRows(state.rows.filter(matches));
  return source.map((r) => ({ paper: r.p, venue: venueById.get(r.v)! }));
}
async function doExport(format: string) {
  if (format === 'clear') { state.sel.clear(); render(); return; }
  const rows = currentExportRows();
  if (!rows.length) { toast('Nothing to export'); return; }
  if (format === 'bibtex') {
    try { await navigator.clipboard.writeText(toBibtex(rows)); toast(`Copied ${rows.length} ${plural(rows.length, 'BibTeX entry', 'BibTeX entries')}`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'csv') {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'confer-papers.csv' });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Downloaded ${rows.length} ${plural(rows.length, 'row')}`);
  }
}

function renderSaved() {
  const list = $('#savedList');
  if (!state.saved.length) { list.innerHTML = '<p class="saved-empty">No saved searches yet.</p>'; return; }
  list.innerHTML = state.saved.map((s, i) =>
    `<div class="saved-item"><button class="saved-load" data-saved-load="${i}">${esc(s.name)}</button><button class="saved-del" data-saved-del="${i}" aria-label="Delete">×</button></div>`).join('');
}
function saveCurrentSearch() {
  askText({ title: 'Save search', value: state.query || 'My search', placeholder: 'Search name', max: NAME_MAX, ok: 'Save' }).then((name) => {
    const clean = cleanInput(name ?? '');
    if (!clean) return;
    state.saved.push({
      name: clean, query: state.query.trim(), sort: state.sort, collection: state.collection,
      tracks: [...state.tracks], events: [...state.events], venues: [...state.selected],
    });
    writeJson(K_SAVED, state.saved);
    toast('Search saved');
    renderSaved();
    renderSettings();
  });
}
function loadSaved(i: number) {
  const s = state.saved[i];
  if (!s) return;
  state.query = s.query; state.sort = s.sort; state.collection = s.collection ?? '';
  state.tracks = new Set(s.tracks); state.events = new Set(s.events);
  state.selected = new Set(s.venues); state.venuesFacet.clear(); state.shown = PAGE;
  reflectSidebar(); writeUrl(); closeModals();
  ensureLoaded([...state.selected]).then(render);
}

// --- settings modal: sync section (GitHub login / account row) --------
function renderSyncSection(): string {
  // No GitHub App configured — nothing to show here (data actions live in Config)
  if (!GH_CLIENT_ID) return '';

  const token = localStorage.getItem(K_GH_TOKEN);
  const SYNC_TIP = 'Sync your config across devices via a secret GitHub Gist — only accessible with the direct URL.';

  // Logged out
  if (!token) {
    return `<section class="set-section">
      <div class="set-actions">
        <button class="text-btn" data-gh-login type="button">${ICONS.github} Login with GitHub</button>
        <button class="gh-help" title="${esc(SYNC_TIP)}" type="button" aria-label="About sync">${ICONS.help}</button>
      </div>
    </section>`;
  }

  // Logged in
  const user = readJson<GitHubUser | null>(K_GH_USER, null);
  const meta = readJson<SyncMeta | null>(K_SYNC_META, null);
  const initials = user ? (user.name || user.login).slice(0, 2).toUpperCase() : '?';
  const avatarHtml = user?.avatarUrl
    ? `<div class="gh-avatar"><img src="${esc(user.avatarUrl)}" alt="" loading="lazy"></div>`
    : `<div class="gh-avatar">${esc(initials)}</div>`;
  // Name on top, @login below (only if a real name exists)
  const nameHtml = user?.name ? `<span class="gh-name">${esc(user.name)}</span>` : `<span class="gh-name">@${esc(user?.login ?? '')}</span>`;
  const loginHtml = user?.name ? `<span class="gh-login">@${esc(user.login)}</span>` : '';
  // Sync button: icon+text pill reusing .chip-btn; title carries the precise last-sync time.
  // Conflict replaces the pill with a text warning button.
  const syncDisplayTs = meta ? (meta.lastSyncedAt ?? meta.remoteUpdatedAt) : null;
  const isPending = localPending();
  const syncLabel = isPending ? 'Pending' : 'Synced';
  const syncHoverTitle = syncDisplayTs
    ? `Last synced at ${fullTimestamp(syncDisplayTs)}`
    : 'Never synced';
  const syncBtn = syncConflictPending
    ? `<button class="gh-conflict" type="button" title="Local and cloud both changed — click to review and resolve">⚠ Sync conflict — review</button>`
    : `<button class="chip-btn gh-sync-btn" data-sync-now type="button" title="${esc(syncHoverTitle)}" aria-label="Sync now">${ICONS.refresh}<span class="gh-sync-text">${syncLabel}</span></button>`;

  return `<section class="set-section">
    <div class="set-account">
      <button class="gh-account-btn" data-account-menu type="button" aria-label="Account menu">
        ${avatarHtml}
        <div class="gh-identity">
          ${nameHtml}
          ${loginHtml}
        </div>
        <span class="gh-chevron" aria-hidden="true">${ICONS.chevronDown}</span>
      </button>
      ${syncBtn}
    </div>
  </section>`;
}

function renderSettings() {
  const body = document.querySelector<HTMLElement>('#settingsBody');
  if (!body) return;
  const groupsHtml = state.groups.length
    ? state.groups.map((g) =>
        `<div class="set-item" data-set-group="${g.id}">
          <div class="set-item-head">
            <span class="set-item-name">${esc(g.name)}</span>
            <span class="set-item-meta">${venuesOfGroup(g).length} ${plural(venuesOfGroup(g).length, 'venue')}</span>
            <button class="set-mini" data-group-share="${g.id}" type="button" aria-label="Copy share link" title="Copy share link">${ICONS.link}</button>
            <button class="set-mini" data-group-rename="${g.id}" type="button" aria-label="Rename group" title="Rename">${ICONS.pencil}</button>
            <button class="set-mini set-mini-del" data-group-del="${g.id}" type="button" aria-label="Delete group" title="Delete">${ICONS.trash}</button>
          </div>
          <div class="set-chips">${g.series.map((s) => `<span class="chip">${esc(s)}<span class="tag-x" data-group-series-del="${g.id}|${esc(s)}" role="button" aria-label="Remove">×</span></span>`).join('') || '<span class="set-empty">no series</span>'}
            <button class="set-add" data-group-series-add="${g.id}" data-pop-anchor type="button" aria-label="Add series" title="Add series"><svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div>
        </div>`).join('')
    : '<p class="set-empty">No venue groups yet. Use the group icon beside a series in the sidebar to add one.</p>';
  const colsHtml = state.collections.length
    ? state.collections.map((c) =>
        `<div class="set-item" data-set-col="${c.id}">
          <div class="set-item-head">
            <span class="set-item-name">${esc(c.name)}</span>
            <span class="set-item-meta">${c.keys.length} ${plural(c.keys.length, 'paper')}</span>
            <button class="set-mini" data-col-share="${c.id}" type="button" aria-label="Copy share link" title="Copy share link">${ICONS.link}</button>
            <button class="set-mini" data-col-rename="${c.id}" type="button" aria-label="Rename collection" title="Rename">${ICONS.pencil}</button>
            <button class="set-mini set-mini-del" data-col-del="${c.id}" type="button" aria-label="Delete collection" title="Delete">${ICONS.trash}</button>
          </div>
        </div>`).join('')
    : '<p class="set-empty">No collections yet. Use the bookmark on a paper to add one.</p>';
  const tags = [...tagCounts().entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tagsHtml = tags.length
    ? `<div class="set-chips">${tags.map(([t, n]) => `<span class="chip">${esc(t)}<span class="tag-n">${n}</span><span class="tag-x" data-tag-purge="${esc(t)}" role="button" aria-label="Remove from all">×</span></span>`).join('')}</div>`
    : '<p class="set-empty">No tags yet. Add tags on a paper card.</p>';
  const raw: Record<string, unknown> = {};
  for (const k of CONFIG_KEYS) { const v = localStorage.getItem(k); if (!v) continue; try { raw[k] = JSON.parse(v); } catch { raw[k] = v; } }
  const currentAccent = document.documentElement.dataset.accent || 'clay';
  const swatchesHtml = Object.entries(ACCENTS).map(([key, { label, light }]) =>
    `<button class="accent-sw${currentAccent === key ? ' is-on' : ''}" data-accent-pick="${key}" title="${label}" type="button" style="background:${light}"></button>`
  ).join('');

  // Personal stats
  const toreadN = [...state.status.values()].filter((v) => v === 'toread').length;
  const readingN = [...state.status.values()].filter((v) => v === 'reading').length;
  const doneN = [...state.status.values()].filter((v) => v === 'done').length;
  const collectedN = new Set(state.collections.flatMap((c) => c.keys)).size;
  const distinctTags = tagCounts().size;
  const statTile = (n: number, label: string) =>
    `<div class="set-stat"><span class="set-stat-n">${n.toLocaleString()}</span><span class="set-stat-l">${esc(label)}</span></div>`;
  const statsHtml = `<div class="set-stats">
    ${statTile(collectedN, 'collected')}
    ${statTile(state.collections.length, 'collections')}
    ${statTile(state.tags.size, 'tagged papers')}
    ${statTile(distinctTags, 'tags')}
    ${statTile(state.notes.size, 'notes')}
    ${statTile(toreadN, 'to read')}
    ${statTile(readingN, 'reading')}
    ${statTile(doneN, 'done')}
    ${statTile(state.groups.length, 'groups')}
    ${statTile(state.saved.length, 'saved searches')}
  </div>`;

  const hasGist = Boolean(localStorage.getItem(K_GIST_ID));

  body.innerHTML = `
    ${renderSyncSection()}
    <section class="set-section"><h3 class="set-title">Your library</h3>${statsHtml}</section>
    <section class="set-section"><h3 class="set-title">Appearance</h3><div class="accent-swatches">${swatchesHtml}</div></section>
    <section class="set-section"><h3 class="set-title">Venue groups</h3>${groupsHtml}</section>
    <section class="set-section"><h3 class="set-title">Collections</h3>${colsHtml}</section>
    <section class="set-section"><h3 class="set-title">Tags</h3>${tagsHtml}</section>
    <section class="set-section">
      <h3 class="set-title">Saved searches <span class="set-item-meta">${state.saved.length}</span></h3>
      <button class="text-btn" data-open-saved type="button">Open saved searches</button>
    </section>
    <section class="set-section">
      <h3 class="set-title"><span>Config</span><span class="set-item-meta">${formatBytes(configBundleBytes())}</span>
        <button class="set-mini" data-settings-export type="button" aria-label="Export config" title="Export">${ICONS.download}</button>
        <button class="set-mini" data-settings-import type="button" aria-label="Import config" title="Import">${ICONS.upload}</button>
        <button class="set-mini" data-share-full type="button" aria-label="Copy share link" title="Share all">${ICONS.link}</button>
        ${hasGist ? `<button class="set-mini" data-open-history type="button" aria-label="View config history" title="View history">${ICONS.history}</button>` : ''}</h3>
      <p class="set-note">Site config stored in this browser.</p>
      <pre class="set-raw">${esc(JSON.stringify(raw, null, 2))}</pre>
    </section>
    <section class="set-section">
      <h3 class="set-title"><span>Local storage</span><span class="set-item-meta">${formatBytes(localDataBytes())}</span></h3>
      <button class="text-btn text-btn--danger-ghost" data-clear-local type="button">${ICONS.trash} Clear local data</button>
    </section>
    <section class="set-section">
      <h3 class="set-title">Feedback</h3>
      <p class="set-note">Help improve confer — report data issues or suggest new venues.</p>
      <div class="set-actions">
        <button class="text-btn" data-feedback-error type="button">Report a data issue</button>
        <button class="text-btn" data-feedback-venue type="button">Suggest a venue</button>
      </div>
    </section>`;
  requestAnimationFrame(refreshScrollFades);
}

// Size of the exported/synced SettingsBundle JSON.
function configBundleBytes(): number {
  return new TextEncoder().encode(JSON.stringify(serializeSettings())).length;
}

// Total bytes used by this site in localStorage (UTF-16 code units → bytes).
function localDataBytes(): number {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('confer.')) continue;
    total += (k.length + (localStorage.getItem(k) ?? '').length) * 2;
  }
  return total;
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
// Wipe every confer.* key and reset in-memory state (after a confirmation).
function clearLocalData() {
  askConfirm({ title: 'Clear all data', message: 'Erase all confer data stored in this browser — venue groups, collections, tags, saved searches and preferences? This cannot be undone.', ok: 'Clear', danger: true }).then((ok) => { if (!ok) return; clearLocalDataNow(); }); }
function clearLocalDataNow() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('confer.')) keys.push(k); }
  keys.forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
  state.groups = []; state.collections = []; state.tags.clear(); state.saved = [];
  state.notes.clear(); state.status.clear();
  state.collection = ''; state.colSet = null; state.statusFilter = '';
  reflectSidebar(); reflectSeriesGroup(); reflectCollectionFilter(); renderSaved(); renderSettings();
  render();
  toast('Local data cleared');
}
// Picker (popover) to add a series to a group, opened from the "+" in Settings.
function openSeriesAddPop(anchor: HTMLElement, groupId: string) {
  const render = () => {
    const g = state.groups.find((x) => x.id === groupId);
    if (!g) return '';
    const opts = [...new Set(manifest.map((v) => v.series))].sort().filter((s) => !g.series.includes(s));
    const rows = opts.map((s) => `<div class="pop-row" data-series-pick="${esc(s)}" role="button"><span class="pop-row-label">${esc(s)}</span></div>`).join('');
    return `<div class="pop-title">Add series</div><div class="pop-list">${rows || '<p class="pop-empty">All series added.</p>'}</div>`;
  };
  openPop(anchor, render, (t) => {
    const pick = t.closest<HTMLElement>('[data-series-pick]');
    if (!pick) return;
    const g = state.groups.find((x) => x.id === groupId);
    const s = pick.dataset.seriesPick ?? '';
    if (g && s && !g.series.includes(s)) {
      g.series.push(s);
      saveGroups();
      renderVenueGroups(); reflectSeriesGroup(); renderSettings();
    }
    closePop();
  });
}

// --- share-link encode/decode -----------------------------------------
/** Encode a bundle to a base64url string (gzip when available, else raw). */
async function encodeBundle(bundle: SettingsBundle): Promise<string> {
  const json = JSON.stringify(bundle);
  try {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(json));
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return 'z.' + btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return 'r.' + btoa(encodeURIComponent(json)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
/** Decode a base64url string back to a bundle (inverse of encodeBundle). */
async function decodeBundle(raw: string): Promise<SettingsBundle> {
  const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.startsWith('z.')) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes); writer.close();
    const json = await new Response(ds.readable).text();
    return JSON.parse(json) as SettingsBundle;
  }
  return JSON.parse(decodeURIComponent(atob(b64))) as SettingsBundle;
}

/** Build a share URL for a collection (+ its paper tags), a venue group, or the full config. */
async function buildShareUrl(scope: 'collection' | 'group' | 'full', id?: string): Promise<string> {
  let bundle: SettingsBundle;
  if (scope === 'collection' && id) {
    const col = collectionById(id);
    if (!col) throw new Error('collection not found');
    const tags: Record<string, string[]> = {};
    col.keys.forEach((k) => { const t = state.tags.get(k); if (t?.length) tags[k] = t; });
    bundle = { app: 'confer', version: 1, exportedAt: new Date().toISOString(), collections: [col], paperTags: tags };
  } else if (scope === 'group' && id) {
    const grp = state.groups.find((g) => g.id === id);
    if (!grp) throw new Error('group not found');
    bundle = { app: 'confer', version: 1, exportedAt: new Date().toISOString(), venueGroups: [grp] };
  } else {
    bundle = serializeSettings();
  }
  const payload = await encodeBundle(bundle);
  return `${location.origin}${location.pathname}#share=${payload}`;
}

/** Copy a share link to clipboard and toast. */
async function copyShareLink(scope: 'collection' | 'group' | 'full', id?: string) {
  try {
    const url = await buildShareUrl(scope, id);
    await navigator.clipboard.writeText(url);
    toast('Share link copied');
  } catch (e) {
    toast('Could not copy link');
    console.error(e);
  }
}

/** Called on page load: detect #share= hash, prompt, apply if accepted. */
async function handleShareHash() {
  const hash = location.hash;
  if (!hash.startsWith('#share=')) return;
  const payload = hash.slice('#share='.length);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const bundle = await decodeBundle(payload);
    const colCount = bundle.collections?.length ?? 0;
    const colName = bundle.collections?.[0]?.name ?? '';
    const paperCount = bundle.collections?.reduce((s, c) => s + c.keys.length, 0) ?? 0;
    const grpCount = bundle.venueGroups?.length ?? 0;
    const grpName = bundle.venueGroups?.[0]?.name ?? '';
    const isGroupOnly = grpCount > 0 && colCount === 0 && !(bundle.savedSearches?.length);
    const isFullConfig = !isGroupOnly && (grpCount > 0 || (bundle.savedSearches?.length ?? 0) > 0);
    const desc = isFullConfig
      ? 'Import full config (groups, collections, saved searches)?'
      : isGroupOnly
        ? grpCount === 1
          ? `Import venue group "${grpName}"?`
          : `Import ${grpCount} venue groups?`
        : colCount === 1
          ? `Import collection "${colName}" (${paperCount} ${plural(paperCount, 'paper')})?`
          : `Import ${colCount} ${plural(colCount, 'collection')} (${paperCount} ${plural(paperCount, 'paper')})?`;
    const confirmed = await askConfirm({ title: 'Import shared data', message: desc, ok: 'Import' });
    if (confirmed) {
      applySettingsBundle(bundle, { merge: true });
      toast('Imported shared data');
    }
  } catch { toast('Invalid or corrupted share link'); }
}

// --- GitHub Gist sync -------------------------------------------------
/** Start the GitHub OAuth Web Flow (redirects; returns on callback with ?code=). */
function startGitHubLogin() {
  if (!GH_CLIENT_ID) { toast('GitHub client ID not configured'); return; }
  const state = crypto.randomUUID();
  sessionStorage.setItem('gh_oauth_state', state);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', GH_CLIENT_ID);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'gist');
  location.href = url.toString();
}

/** Exchange the ?code= in the URL for a token via the broker; store it. */
async function handleOAuthCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const returnedState = params.get('state');
  if (!code) return;
  // Remove ?code= and ?state= from the URL immediately
  const clean = location.pathname + location.hash;
  history.replaceState(null, '', clean);
  const expected = sessionStorage.getItem('gh_oauth_state');
  sessionStorage.removeItem('gh_oauth_state');
  if (returnedState && expected && returnedState !== expected) { toast('Login failed: state mismatch'); return; }
  try {
    const res = await fetch(OAUTH_BROKER, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!data.access_token) { toast('Login failed: ' + (data.error ?? 'unknown')); return; }
    try { localStorage.setItem(K_GH_TOKEN, data.access_token); } catch { /* ignore */ }
    if (data.refresh_token) { try { localStorage.setItem(K_GH_REFRESH, data.refresh_token); } catch { /* ignore */ } }
    if (data.expires_in) { try { localStorage.setItem(K_GH_EXPIRES, String(Date.now() + data.expires_in * 1000)); } catch { /* ignore */ } }
    toast('Logged in with GitHub ✓');
    void fetchGitHubUser(data.access_token); // async — re-renders when identity arrives
    void autoSync(); // pull remote state right after login
    renderSettings();
    $('#settingsModal').hidden = false; // open settings so user sees the sync section
  } catch { toast('Login failed — network error'); }
}

/** Find or create the user's confer config gist. Uses ghFetch for 401 handling. */
async function ensureGist(token: string, opts?: { silent?: boolean }): Promise<string> {
  const cached = localStorage.getItem(K_GIST_ID);
  if (cached) return cached;
  const listRes = await ghFetch('https://api.github.com/gists?per_page=100', token, undefined, opts);
  if (!listRes.ok) throw new Error('Failed to list gists');
  const gists = await listRes.json() as { id: string; files: Record<string, unknown> }[];
  const existing = gists.find((g) => 'confer-config.json' in g.files);
  if (existing) { try { localStorage.setItem(K_GIST_ID, existing.id); } catch { /* ignore */ } return existing.id; }
  const createRes = await ghFetch('https://api.github.com/gists', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'confer personal config (auto-managed)',
      public: false,
      files: { 'confer-config.json': { content: JSON.stringify({ app: 'confer', version: 1 }, null, 2) } },
    }),
  }, opts);
  if (!createRes.ok) throw new Error('Failed to create gist');
  const gist = await createRes.json() as { id: string };
  try { localStorage.setItem(K_GIST_ID, gist.id); } catch { /* ignore */ }
  return gist.id;
}

/** Low-level: write a bundle to the Gist with a fresh updatedAt, then persist SyncMeta.
 *  The bundle itself is saved as `base` for future 3-way merges. */
async function pushBundle(token: string, gistId: string, bundle: SettingsBundle): Promise<void> {
  const now = new Date().toISOString();
  const withTs: SettingsBundle = { ...bundle, updatedAt: now };
  const res = await ghFetch(`https://api.github.com/gists/${gistId}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'confer-config.json': { content: JSON.stringify(withTs, null, 2) } } }),
  });
  if (!res.ok) throw new Error('Push failed');
  writeJson(K_SYNC_META, { remoteUpdatedAt: now, localFingerprint: bundleFingerprint(bundle), lastSyncedAt: now, base: bundle } satisfies SyncMeta);
}

/** Low-level: apply a remote bundle as the new local state and record the sync point.
 *  The remote bundle is saved as `base` for future 3-way merges. */
function applyRemoteBundle(remote: SettingsBundle): void {
  applySettingsBundle(remote);
  const now = new Date().toISOString();
  const fp = bundleFingerprint(serializeSettings());
  writeJson(K_SYNC_META, { remoteUpdatedAt: remote.updatedAt ?? '', localFingerprint: fp, lastSyncedAt: now, base: remote } satisfies SyncMeta);
}

/** Sign out: confirm, then clear token, identity, gist id, and sync meta. */
function signOutGitHub() {
  askConfirm({ title: 'Sign out', message: 'Sign out of GitHub? Your local config stays in this browser.', ok: 'Sign out', danger: true }).then((ok) => {
    if (!ok) return;
    try { [K_GH_TOKEN, K_GH_REFRESH, K_GH_EXPIRES, K_GH_USER, K_GIST_ID, K_SYNC_META, K_SYNC_ETAG].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    conflictLocal = null; conflictRemote = null; conflictToken = ''; conflictGistId = '';
    syncConflictPending = false;
    if (autoSyncTimer !== null) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
    clearSyncRetry();
    toast('Signed out');
    renderSettings();
  });
}

// --- feedback (GitHub issue prefill) ----------------------------------

/** Open a prefilled GitHub issue for error reporting or venue suggestions. */
function openIssue(kind: 'error' | 'venue') {
  const templates: Record<string, { title: string; labels: string; body: string }> = {
    error: {
      title: 'Data issue: [venue / paper title]',
      labels: 'data',
      body: [
        '**Venue / Year:**\n',
        '**Paper title or ID:**\n',
        '**What\'s wrong:**\n',
        '**Expected:**\n',
        '---',
        '_Tip: you can find a paper\'s ID in its venue badge tooltip._',
      ].join('\n'),
    },
    venue: {
      title: 'Venue request: [name and year]',
      labels: 'venue',
      body: [
        '**Venue name and year(s):**\n',
        '**Official program URL:**\n',
        '**Platform (Researchr / OpenReview / DBLP / other):**\n',
        '**Why include it:**\n',
      ].join('\n'),
    },
  };
  const tmpl = templates[kind]!;
  const url = `${REPO_URL}/issues/new?title=${encodeURIComponent(tmpl.title)}&labels=${encodeURIComponent(tmpl.labels)}&body=${encodeURIComponent(tmpl.body)}`;
  window.open(url, '_blank', 'noreferrer');
}

// --- config version history -------------------------------------------

/** Max revisions shown in the history modal (keeps upfront loading bounded). */
const HIST_LIMIT = 30;

/** A single entry in the GitHub Gist revision history. */
interface HistoryEntry {
  version: string;
  committed_at: string;
}

/** One labelled category of changes between two revisions. */
interface DiffPart { text: string; kind: 'add' | 'del' | 'mod'; }
interface DiffRow { label: string; parts: DiffPart[]; }

/** Semantic diff between two config snapshots. */
interface RevDiff {
  rows: DiffRow[];
  /** Compact one-line summary, e.g. "1 collection · 3 tags". */
  summary: string;
}

/** Empty baseline used as the "previous" for the very first revision, so its
 *  whole contents render as additions. */
const EMPTY_BUNDLE: SettingsBundle = { app: 'confer', version: 2 };

// --- Shared bundle-comparison helpers ------------------------------------
/** Build a Set of string keys from an array. */
function idSet<T>(arr: T[], key: (x: T) => string): Set<string> {
  return new Set(arr.map(key));
}
/** Return items from `arr` whose key is absent from `others`. */
function onlyInA<T>(arr: T[], others: Set<string>, key: (x: T) => string): T[] {
  return arr.filter((x) => !others.has(key(x)));
}

/** Compute a human-readable semantic diff from `prev` → `cur`. Detects adds,
 *  removals, renames, membership and content edits across every config
 *  category. Timestamps (exportedAt/updatedAt) are intentionally ignored, so a
 *  pure resync yields an empty diff rather than a misleading line-count. */
function summarizeRevision(prev: SettingsBundle, cur: SettingsBundle): RevDiff {
  const rows: DiffRow[] = [];
  const counts: string[] = [];
  const add = (text: string): DiffPart => ({ text, kind: 'add' });
  const del = (text: string): DiffPart => ({ text, kind: 'del' });
  const mod = (text: string): DiffPart => ({ text, kind: 'mod' });

  // venue groups (keyed by id): add / remove / rename / membership
  {
    const p = prev.venueGroups ?? [], c = cur.venueGroups ?? [];
    const pById = new Map(p.map((g) => [g.id, g] as const));
    const cById = new Map(c.map((g) => [g.id, g] as const));
    const parts: DiffPart[] = [];
    for (const g of c) if (!pById.has(g.id)) parts.push(add(g.name));
    for (const g of p) if (!cById.has(g.id)) parts.push(del(g.name));
    for (const g of c) {
      const old = pById.get(g.id);
      if (!old) continue;
      if (old.name !== g.name) parts.push(mod(`${old.name} → ${g.name}`));
      else if (old.series.join('|') !== g.series.join('|')) parts.push(mod(`${g.name} (members)`));
    }
    if (parts.length) { rows.push({ label: 'Groups', parts }); counts.push(`${parts.length} ${plural(parts.length, 'group')}`); }
  }

  // collections (keyed by id): add / remove / rename / item count delta
  {
    const p = prev.collections ?? [], c = cur.collections ?? [];
    const pById = new Map(p.map((x) => [x.id, x] as const));
    const cById = new Map(c.map((x) => [x.id, x] as const));
    const parts: DiffPart[] = [];
    for (const x of c) if (!pById.has(x.id)) parts.push(add(x.name));
    for (const x of p) if (!cById.has(x.id)) parts.push(del(x.name));
    for (const x of c) {
      const old = pById.get(x.id);
      if (!old) continue;
      if (old.name !== x.name) { parts.push(mod(`${old.name} → ${x.name}`)); continue; }
      const oldKeys = new Set(old.keys), newKeys = new Set(x.keys);
      const a = x.keys.filter((k) => !oldKeys.has(k)).length;
      const r = old.keys.filter((k) => !newKeys.has(k)).length;
      if (a || r) parts.push(mod(`${x.name} (${[a ? `+${a}` : '', r ? `−${r}` : ''].filter(Boolean).join(' ')})`));
    }
    if (parts.length) { rows.push({ label: 'Collections', parts }); counts.push(`${parts.length} ${plural(parts.length, 'collection')}`); }
  }

  // tags: compare per-paper assignments, keyed by tag label, so re-using an
  // existing label on a new paper still registers as an addition
  {
    const byTag = (m?: Record<string, string[]>) => {
      const t = new Map<string, Set<string>>();
      for (const [k, tags] of Object.entries(m ?? {})) for (const tag of tags) {
        let set = t.get(tag); if (!set) { set = new Set(); t.set(tag, set); }
        set.add(k);
      }
      return t;
    };
    const pm = byTag(prev.paperTags), cm = byTag(cur.paperTags);
    const added = new Map<string, number>(), removed = new Map<string, number>();
    for (const [tag, cset] of cm) { const pset = pm.get(tag); const n = [...cset].filter((k) => !pset?.has(k)).length; if (n) added.set(tag, n); }
    for (const [tag, pset] of pm) { const cset = cm.get(tag); const n = [...pset].filter((k) => !cset?.has(k)).length; if (n) removed.set(tag, n); }
    const parts: DiffPart[] = [];
    for (const [tag, n] of added) parts.push(add(n > 1 ? `${tag} ×${n}` : tag));
    for (const [tag, n] of removed) parts.push(del(n > 1 ? `${tag} ×${n}` : tag));
    if (parts.length) {
      const total = [...added.values()].reduce((a, b) => a + b, 0) + [...removed.values()].reduce((a, b) => a + b, 0);
      rows.push({ label: 'Tags', parts }); counts.push(`${total} ${plural(total, 'tag')}`);
    }
  }

  // saved searches (keyed by name): add / remove / edit
  {
    const p = prev.savedSearches ?? [], c = cur.savedSearches ?? [];
    const pByName = new Map(p.map((s) => [s.name, s] as const));
    const cByName = new Map(c.map((s) => [s.name, s] as const));
    const parts: DiffPart[] = [];
    for (const s of c) if (!pByName.has(s.name)) parts.push(add(s.name));
    for (const s of p) if (!cByName.has(s.name)) parts.push(del(s.name));
    for (const s of c) {
      const old = pByName.get(s.name);
      if (old && JSON.stringify(old) !== JSON.stringify(s)) parts.push(mod(`${s.name} (edited)`));
    }
    if (parts.length) { rows.push({ label: 'Saved searches', parts }); counts.push(`${parts.length} ${plural(parts.length, 'search', 'searches')}`); }
  }

  // notes: content edits matter, so compare values not just keys
  {
    const p = prev.paperNotes ?? {}, c = cur.paperNotes ?? {};
    let a = 0, e = 0, r = 0;
    for (const k of new Set([...Object.keys(p), ...Object.keys(c)])) {
      const ov = p[k], nv = c[k];
      if (!ov && nv) a++; else if (ov && !nv) r++; else if (ov && nv && ov !== nv) e++;
    }
    const parts: DiffPart[] = [];
    if (a) parts.push(add(`${a} added`));
    if (e) parts.push(mod(`${e} edited`));
    if (r) parts.push(del(`${r} removed`));
    if (parts.length) { rows.push({ label: 'Notes', parts }); counts.push(`${a + e + r} ${plural(a + e + r, 'note')}`); }
  }

  // reading status: transitions matter, so compare values not just keys
  {
    const p = prev.readStatus ?? {}, c = cur.readStatus ?? {};
    let a = 0, e = 0, r = 0;
    for (const k of new Set([...Object.keys(p), ...Object.keys(c)])) {
      const ov = p[k], nv = c[k];
      if (!ov && nv) a++; else if (ov && !nv) r++; else if (ov && nv && ov !== nv) e++;
    }
    const parts: DiffPart[] = [];
    if (a) parts.push(add(`${a} set`));
    if (e) parts.push(mod(`${e} changed`));
    if (r) parts.push(del(`${r} cleared`));
    if (parts.length) { rows.push({ label: 'Reading status', parts }); counts.push(`${a + e + r} ${plural(a + e + r, 'paper')}`); }
  }

  return { rows, summary: counts.length ? counts.join(' · ') : 'No content changes' };
}

/** Fetch the revision list (newest first) for the user's config Gist. */
async function fetchGistHistory(): Promise<HistoryEntry[]> {
  const token = await getValidToken();
  if (!token) throw new Error('Not signed in');
  const gistId = localStorage.getItem(K_GIST_ID);
  if (!gistId) throw new Error('No gist found');
  const res = await ghFetch(`https://api.github.com/gists/${gistId}`, token);
  if (!res.ok) throw new Error('Request failed');
  const data = await res.json() as { history?: HistoryEntry[] };
  return data.history ?? [];
}

/** Fetch a specific revision bundle, caching by SHA. */
async function loadRevision(version: string): Promise<SettingsBundle> {
  if (revisionCache.has(version)) return revisionCache.get(version)!;
  const token = await getValidToken();
  if (!token) throw new Error('Not signed in');
  const gistId = localStorage.getItem(K_GIST_ID);
  if (!gistId) throw new Error('No gist found');
  const res = await ghFetch(`https://api.github.com/gists/${gistId}/${version}`, token);
  if (!res.ok) throw new Error('Failed to load revision');
  const data = await res.json() as { files?: { 'confer-config.json'?: { content?: string } } };
  const content = data.files?.['confer-config.json']?.content ?? '{}';
  const bundle = JSON.parse(content) as SettingsBundle;
  revisionCache.set(version, bundle);
  return bundle;
}

/** Render the timeline of revisions into #historyBody. `bundles[i]` is the
 *  snapshot for `entries[i]`; `bundles[i+1]` (if loaded) is the older neighbour
 *  used to diff `entries[i]`. */
function renderHistoryList(entries: HistoryEntry[], bundles: (SettingsBundle | null)[], truncated: boolean) {
  const body = document.querySelector<HTMLElement>('#historyBody');
  if (!body) return;
  const CHIP_CAP = 8;
  const chip = (p: DiffPart) => `<span class="hist-chip hist-chip--${p.kind}">${esc(p.text)}</span>`;
  const detailHtml = (rows: DiffRow[]) => rows.map((r) => {
    const shown = r.parts.slice(0, CHIP_CAP);
    const more = r.parts.length - shown.length;
    return `<div class="hist-cat"><span class="hist-cat-label">${esc(r.label)}</span><div class="hist-cat-chips">${
      shown.map(chip).join('')}${more > 0 ? `<span class="hist-more">+${more} more</span>` : ''}</div></div>`;
  }).join('');

  const items = entries.map((e, i) => {
    const cur = bundles[i];
    // bundles[i+1]: undefined = past the loaded range (oldest revision shown), null = fetch failed
    const olderSlot = bundles[i + 1];
    const diff: RevDiff = cur === null
      ? { rows: [], summary: 'Content unavailable' }
      : olderSlot === null
        ? { rows: [], summary: 'Changes unavailable' }   // older snapshot failed to load
        : summarizeRevision(olderSlot ?? EMPTY_BUNDLE, cur); // undefined → treat as initial revision
    const hasDetail = diff.rows.length > 0;
    const isCurrent = i === 0;
    return `<li class="hist-item${isCurrent ? ' is-current' : ''}">
      <span class="hist-marker" aria-hidden="true"></span>
      <div class="hist-main">
        <div class="hist-head">
          <span class="hist-time" title="${esc(fullTimestamp(e.committed_at))}">${esc(relativeTime(e.committed_at))}</span>
          ${isCurrent ? '<span class="hist-badge">Current</span>' : ''}
          <span class="hist-summary${hasDetail ? '' : ' is-muted'}">${esc(diff.summary)}</span>
          <span class="hist-grow"></span>
          ${isCurrent ? '' : `<button class="text-btn hist-restore" data-hist-restore="${esc(e.version)}" type="button">Restore</button>`}
          ${hasDetail ? `<button class="icon-btn hist-expand" data-hist-toggle type="button" aria-label="Show changes" title="Show changes">${ICONS.chevronDown}</button>` : ''}
        </div>
        ${hasDetail ? `<div class="hist-detail-wrap"><div class="hist-detail">${detailHtml(diff.rows)}</div></div>` : ''}
      </div>
    </li>`;
  }).join('');

  body.innerHTML = `<ol class="hist-list">${items}</ol>${
    truncated ? `<p class="hist-status">Showing the latest ${HIST_LIMIT} revisions.</p>` : ''}`;
  requestAnimationFrame(refreshScrollFades);
}

/** Open the history modal: load the revision list and snapshots, then render
 *  the timeline. Snapshots are loaded upfront (and cached) so every row shows
 *  an accurate summary and expands instantly. */
async function openHistory() {
  const modal = document.querySelector<HTMLElement>('#historyModal');
  if (!modal) return;
  const body = document.querySelector<HTMLElement>('#historyBody');
  modal.hidden = false;
  if (body) body.innerHTML = '<p class="hist-status">Loading history…</p>';
  requestAnimationFrame(refreshScrollFades);
  try {
    const entries = await fetchGistHistory();
    if (!entries.length) {
      if (body) body.innerHTML = '<p class="hist-status">No history yet. Changes you sync will appear here.</p>';
      requestAnimationFrame(refreshScrollFades);
      return;
    }
    const shown = entries.slice(0, HIST_LIMIT);
    // load one extra older revision so the last shown row diffs accurately
    const need = entries.slice(0, Math.min(entries.length, HIST_LIMIT + 1));
    const bundles = await Promise.all(need.map((e) => loadRevision(e.version).catch(() => null)));
    renderHistoryList(shown, bundles, entries.length > HIST_LIMIT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (body) body.innerHTML = `<p class="hist-status hist-status--err">Couldn't load history: ${esc(msg)}</p>`;
    requestAnimationFrame(refreshScrollFades);
  }
}

// --- GitHub API helpers -----------------------------------------------

/** Exchange a stored refresh token for a fresh access token via the broker.
 *  Returns the new access token on success, or null if refresh is impossible
 *  (no refresh token, broker error, or the refresh token itself has expired).
 *  Persists the rotated token set in localStorage on success. */
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem(K_GH_REFRESH);
  if (!refreshToken) return null;
  try {
    const res = await fetch(OAUTH_BROKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!data.access_token) return null;
    try { localStorage.setItem(K_GH_TOKEN, data.access_token); } catch { /* ignore */ }
    if (data.refresh_token) { try { localStorage.setItem(K_GH_REFRESH, data.refresh_token); } catch { /* ignore */ } }
    if (data.expires_in) { try { localStorage.setItem(K_GH_EXPIRES, String(Date.now() + data.expires_in * 1000)); } catch { /* ignore */ } }
    return data.access_token;
  } catch {
    return null;
  }
}

/** Return the stored access token, proactively refreshing it when it is within
 *  5 minutes of expiry (or already expired) and a refresh token is available.
 *  Returns null if the user is not logged in. */
async function getValidToken(): Promise<string | null> {
  const token = localStorage.getItem(K_GH_TOKEN);
  if (!token) return null;
  const expiresStr = localStorage.getItem(K_GH_EXPIRES);
  if (expiresStr) {
    const expiresAt = Number(expiresStr);
    if (Date.now() >= expiresAt - 5 * 60 * 1000) {
      // Proactive refresh before the token dies
      const fresh = await refreshAccessToken();
      if (fresh) return fresh;
      // Refresh failed — fall through and let the caller use the (expired) token;
      // ghFetch's 401 handler will attempt one more refresh on the actual 401.
    }
  }
  return token;
}

/** fetch() wrapper that surfaces 401s cleanly. On a 401 it first attempts a
 *  token refresh via the broker; if that succeeds it retries the request once.
 *  Only if the refresh also fails does it wipe credentials and sign the user out.
 *  Pass `{ silent: true }` for background calls so sign-out happens quietly. */
async function ghFetch(url: string, token: string, init?: RequestInit, opts?: { silent?: boolean }): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...((init?.headers ?? {}) as Record<string, string>),
    },
  });
  if (res.status === 401) {
    // Attempt one silent token refresh before giving up
    const freshToken = await refreshAccessToken();
    if (freshToken) {
      // Retry the original request with the refreshed token
      const retry = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${freshToken}`,
          Accept: 'application/vnd.github+json',
          ...((init?.headers ?? {}) as Record<string, string>),
        },
      });
      if (retry.status !== 401) return retry;
      // Refresh token was also rejected — fall through to sign-out
    }
    try { [K_GH_TOKEN, K_GH_REFRESH, K_GH_EXPIRES, K_GH_USER, K_GIST_ID, K_SYNC_META, K_SYNC_ETAG].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    if (!opts?.silent) toast('GitHub session expired — please log in again');
    renderSettings();
    throw new Error('gh_401');
  }
  return res;
}

/** Fetch GitHub identity for the authed user; cache and re-render. */
async function fetchGitHubUser(token: string): Promise<void> {
  try {
    const res = await ghFetch('https://api.github.com/user', token);
    if (!res.ok) return;
    const d = await res.json() as { login: string; avatar_url: string; name?: string | null; email?: string | null };
    const user: GitHubUser = { login: d.login, avatarUrl: d.avatar_url };
    if (d.name) user.name = d.name;
    if (d.email) user.email = d.email;
    writeJson(K_GH_USER, user);
    renderSettings();
  } catch { /* non-fatal */ }
}

/** Full localized timestamp with timezone, used in hover tooltips. */
function fullTimestamp(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { timeZoneName: 'short' }); } catch { return iso; }
}

/** Human-readable relative time (e.g. "3 min ago", "2 h ago"). */
function relativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
    return `${Math.floor(ms / 86_400_000)} d ago`;
  } catch { return ''; }
}

/** Stable content fingerprint for conflict detection (excludes timestamps). */
function bundleFingerprint(b: Partial<SettingsBundle>): string {
  return JSON.stringify({
    venueGroups: b.venueGroups ?? [],
    collections: b.collections ?? [],
    paperTags: b.paperTags ?? {},
    savedSearches: b.savedSearches ?? [],
    paperNotes: b.paperNotes ?? {},
    readStatus: b.readStatus ?? {},
  });
}

/** 3-way merge of local and remote relative to a shared base.
 *  Returns the merged bundle and a list of human-readable conflict descriptions
 *  (non-empty when the same item was mutated incompatibly on both sides).
 *  Only items whose content changed on exactly one side are auto-resolved; items
 *  changed on both sides (or that can't be matched by id/name) are flagged. */
function mergeThreeWay(
  base: SettingsBundle,
  local: SettingsBundle,
  remote: SettingsBundle,
): { merged: SettingsBundle; conflicts: string[] } {
  const conflicts: string[] = [];

  // Generic merge for id-keyed arrays (VenueGroup, Collection)
  function mergeById<T extends { id: string }>(
    b: T[], l: T[], r: T[],
    label: string,
  ): T[] {
    const allIds = new Set([...b.map((x) => x.id), ...l.map((x) => x.id), ...r.map((x) => x.id)]);
    const result: T[] = [];
    for (const id of allIds) {
      const bItem = b.find((x) => x.id === id);
      const lItem = l.find((x) => x.id === id);
      const rItem = r.find((x) => x.id === id);
      const bSer = JSON.stringify(bItem);
      const lSer = JSON.stringify(lItem);
      const rSer = JSON.stringify(rItem);
      const lChanged = lSer !== bSer;
      const rChanged = rSer !== bSer;
      if (!lChanged && !rChanged) { if (lItem) result.push(lItem); continue; }
      if (lChanged && !rChanged) { if (lItem) result.push(lItem); continue; } // local added/modified/deleted
      if (!lChanged && rChanged) { if (rItem) result.push(rItem); continue; } // remote added/modified/deleted
      // Both changed
      if (lSer === rSer) { if (lItem) result.push(lItem); continue; } // identical result — fine
      // True conflict: both modified the same item differently
      const name = (lItem as unknown as { name?: string })?.name ?? (rItem as unknown as { name?: string })?.name ?? id;
      conflicts.push(`${label} "${name}"`);
      result.push(lItem ?? rItem!); // keep local on conflict
    }
    return result;
  }

  // Merge name-keyed saved searches
  function mergeSavedSearches(b: SavedSearch[], l: SavedSearch[], r: SavedSearch[]): SavedSearch[] {
    const allNames = new Set([...b.map((x) => x.name), ...l.map((x) => x.name), ...r.map((x) => x.name)]);
    const result: SavedSearch[] = [];
    for (const name of allNames) {
      const bItem = b.find((x) => x.name === name);
      const lItem = l.find((x) => x.name === name);
      const rItem = r.find((x) => x.name === name);
      const bSer = JSON.stringify(bItem);
      const lSer = JSON.stringify(lItem);
      const rSer = JSON.stringify(rItem);
      const lChanged = lSer !== bSer;
      const rChanged = rSer !== bSer;
      if (!lChanged && !rChanged) { if (lItem) result.push(lItem); continue; }
      if (lChanged && !rChanged) { if (lItem) result.push(lItem); continue; }
      if (!lChanged && rChanged) { if (rItem) result.push(rItem); continue; }
      if (lSer === rSer) { if (lItem) result.push(lItem); continue; }
      conflicts.push(`Saved search "${name}"`);
      result.push(lItem ?? rItem!);
    }
    return result;
  }

  // Merge per-paper scalar maps (notes: Record<paperKey, string>, status: same)
  function mergeScalarMap(
    b: Record<string, string>,
    l: Record<string, string>,
    r: Record<string, string>,
    label: string,
  ): Record<string, string> {
    const allKeys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
    const result: Record<string, string> = {};
    for (const k of allKeys) {
      const bVal = b[k] ?? '';
      const lVal = l[k] ?? '';
      const rVal = r[k] ?? '';
      const lChanged = lVal !== bVal;
      const rChanged = rVal !== bVal;
      if (!lChanged && !rChanged) { if (lVal) result[k] = lVal; continue; }
      if (lChanged && !rChanged) { if (lVal) result[k] = lVal; continue; }
      if (!lChanged && rChanged) { if (rVal) result[k] = rVal; continue; }
      if (lVal === rVal) { if (lVal) result[k] = lVal; continue; }
      // Both sides changed to different values — flag conflict, keep local
      const paperId = k.split(':').slice(1).join(':');
      conflicts.push(`${label} for paper "${paperId}"`);
      if (lVal) result[k] = lVal;
    }
    return result;
  }

  // Merge per-paper tags (Record<paperKey, string[]>)
  function mergePaperTags(
    b: Record<string, string[]>,
    l: Record<string, string[]>,
    r: Record<string, string[]>,
  ): Record<string, string[]> {
    const allKeys = new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]);
    const result: Record<string, string[]> = {};
    for (const key of allKeys) {
      const bVal = JSON.stringify(b[key] ?? null);
      const lVal = JSON.stringify(l[key] ?? null);
      const rVal = JSON.stringify(r[key] ?? null);
      const lChanged = lVal !== bVal;
      const rChanged = rVal !== bVal;
      if (!lChanged && !rChanged) { if (l[key]?.length) result[key] = l[key]; continue; }
      if (lChanged && !rChanged) { if (l[key]?.length) result[key] = l[key]; continue; }
      if (!lChanged && rChanged) { if (r[key]?.length) result[key] = r[key]; continue; }
      if (lVal === rVal) { if (l[key]?.length) result[key] = l[key]; continue; }
      // Both sides changed the tags for this paper — union them (low-friction resolution)
      result[key] = [...new Set([...(l[key] ?? []), ...(r[key] ?? [])])];
    }
    return result;
  }

  const merged: SettingsBundle = {
    app: 'confer', version: 2,
    venueGroups:   mergeById(base.venueGroups ?? [], local.venueGroups ?? [], remote.venueGroups ?? [], 'Venue group'),
    collections:   mergeById(base.collections  ?? [], local.collections  ?? [], remote.collections  ?? [], 'Collection'),
    savedSearches: mergeSavedSearches(base.savedSearches ?? [], local.savedSearches ?? [], remote.savedSearches ?? []),
    paperTags:     mergePaperTags(base.paperTags ?? {}, local.paperTags ?? {}, remote.paperTags ?? {}),
    paperNotes:    mergeScalarMap(base.paperNotes ?? {}, local.paperNotes ?? {}, remote.paperNotes ?? {}, 'Note'),
    readStatus:    mergeScalarMap(base.readStatus ?? {}, local.readStatus ?? {}, remote.readStatus ?? {}, 'Status'),
  };

  return { merged, conflicts };
}

/** Build HTML showing what's different between two bundles (for the conflict modal). */
function diffBundles(local: SettingsBundle, remote: SettingsBundle): string {
  function chips(items: string[]) {
    if (!items.length) return '<span class="conflict-same">—</span>';
    const shown = items.slice(0, 6);
    const more = items.length - shown.length;
    return shown.map((s) => `<span class="chip">${esc(s)}</span>`).join('') + (more > 0 ? `<span class="set-note" style="margin:0"> +${more}</span>` : '');
  }
  type Row = { label: string; localItems: string[]; remoteItems: string[] };
  const rows: Row[] = [];

  const rGIds = idSet(remote.venueGroups ?? [], (g) => g.id);
  const lGIds = idSet(local.venueGroups ?? [], (g) => g.id);
  const grpLocal = onlyInA(local.venueGroups ?? [], rGIds, (g) => g.id).map((g) => g.name);
  const grpRemote = onlyInA(remote.venueGroups ?? [], lGIds, (g) => g.id).map((g) => g.name);
  if (grpLocal.length || grpRemote.length) rows.push({ label: 'Groups', localItems: grpLocal, remoteItems: grpRemote });

  const rCIds = idSet(remote.collections ?? [], (c) => c.id);
  const lCIds = idSet(local.collections ?? [], (c) => c.id);
  const colLocal = onlyInA(local.collections ?? [], rCIds, (c) => c.id).map((c) => c.name);
  const colRemote = onlyInA(remote.collections ?? [], lCIds, (c) => c.id).map((c) => c.name);
  if (colLocal.length || colRemote.length) rows.push({ label: 'Collections', localItems: colLocal, remoteItems: colRemote });

  const lTags = new Set(Object.keys(local.paperTags ?? {}));
  const rTags = new Set(Object.keys(remote.paperTags ?? {}));
  const tagLocal = [...new Set([...lTags].filter((k) => !rTags.has(k)).flatMap((k) => local.paperTags![k] ?? []))];
  const tagRemote = [...new Set([...rTags].filter((k) => !lTags.has(k)).flatMap((k) => remote.paperTags![k] ?? []))];
  if (tagLocal.length || tagRemote.length) rows.push({ label: 'Tags', localItems: tagLocal, remoteItems: tagRemote });

  const rSNames = idSet(remote.savedSearches ?? [], (s) => s.name);
  const lSNames = idSet(local.savedSearches ?? [], (s) => s.name);
  const ssLocal = onlyInA(local.savedSearches ?? [], rSNames, (s) => s.name).map((s) => s.name);
  const ssRemote = onlyInA(remote.savedSearches ?? [], lSNames, (s) => s.name).map((s) => s.name);
  if (ssLocal.length || ssRemote.length) rows.push({ label: 'Saved searches', localItems: ssLocal, remoteItems: ssRemote });

  const lNKeys = new Set(Object.keys(local.paperNotes ?? {}));
  const rNKeys = new Set(Object.keys(remote.paperNotes ?? {}));
  const noteLocalOnly = [...lNKeys].filter((k) => !rNKeys.has(k)).length;
  const noteRemoteOnly = [...rNKeys].filter((k) => !lNKeys.has(k)).length;
  if (noteLocalOnly || noteRemoteOnly) rows.push({ label: 'Notes', localItems: noteLocalOnly ? [`${noteLocalOnly} new`] : [], remoteItems: noteRemoteOnly ? [`${noteRemoteOnly} new`] : [] });

  const lSKeys = new Set(Object.keys(local.readStatus ?? {}));
  const rSKeys = new Set(Object.keys(remote.readStatus ?? {}));
  const statusLocalOnly = [...lSKeys].filter((k) => !rSKeys.has(k)).length;
  const statusRemoteOnly = [...rSKeys].filter((k) => !lSKeys.has(k)).length;
  if (statusLocalOnly || statusRemoteOnly) rows.push({ label: 'Reading status', localItems: statusLocalOnly ? [`${statusLocalOnly} new`] : [], remoteItems: statusRemoteOnly ? [`${statusRemoteOnly} new`] : [] });

  if (!rows.length) return '<p class="set-note">The content is the same; only timestamps differ.</p>';

  const remoteFmt = remote.updatedAt ? `Cloud · ${relativeTime(remote.updatedAt)}` : 'Cloud';
  const rowsHtml = rows.map((r) => `
    <span class="conflict-cat-name">${esc(r.label)}</span>
    <div class="conflict-cell">${chips(r.localItems)}</div>
    <div class="conflict-cell">${chips(r.remoteItems)}</div>`).join('');

  return `<div class="conflict-table">
    <span></span><strong class="conflict-head">This device</strong><strong class="conflict-head">${esc(remoteFmt)}</strong>
    ${rowsHtml}
  </div>`;
}

/** True when local config has diverged from the last-synced snapshot. */
function localPending(): boolean {
  const meta = readJson<SyncMeta | null>(K_SYNC_META, null);
  if (!meta) return true; // never synced
  return bundleFingerprint(serializeSettings()) !== meta.localFingerprint;
}

/** Update the sync pill button when the Settings modal is open.
 *  'syncing' = icon spins, label "Syncing…"
 *  'pending' = label "Pending", hover = last-sync time
 *  'synced'  = label "Synced",  hover = last-sync time */
function setSyncBtnState(s: 'syncing' | 'pending' | 'synced') {
  const btn = document.querySelector<HTMLElement>('[data-sync-now]');
  if (!btn) return;
  const textEl = btn.querySelector<HTMLElement>('.gh-sync-text');
  // Spin the refresh icon while syncing; stop otherwise
  btn.classList.toggle('is-syncing', s === 'syncing');
  if (s === 'syncing') {
    if (textEl) textEl.textContent = 'Syncing…';
    btn.setAttribute('aria-label', 'Syncing…');
    // Keep existing title (last-sync time) so the tooltip stays informative
  } else {
    const meta = readJson<SyncMeta | null>(K_SYNC_META, null);
    const ts = meta ? (meta.lastSyncedAt ?? meta.remoteUpdatedAt) : null;
    const hoverTitle = ts ? `Last synced at ${fullTimestamp(ts)}` : 'Never synced';
    if (textEl) textEl.textContent = s === 'pending' ? 'Pending' : 'Synced';
    btn.title = hoverTitle;
    btn.setAttribute('aria-label', 'Sync now');
  }
}

/** Schedule an exponential-backoff retry after a failed auto-push.
 *  No-ops if a retry is already pending. */
function scheduleSyncRetry() {
  if (syncRetryTimer !== null) return;
  const delay = SYNC_RETRY_BACKOFF_MS[Math.min(syncRetryAttempt, SYNC_RETRY_BACKOFF_MS.length - 1)];
  syncRetryAttempt++;
  syncRetryTimer = window.setTimeout(() => {
    syncRetryTimer = null;
    if (!localStorage.getItem(K_GH_TOKEN)) return;
    if (syncConflictPending) return;
    if (!localPending()) return;
    void autoSync();
  }, delay);
}

/** Cancel any pending retry and reset the attempt counter. */
function clearSyncRetry() {
  if (syncRetryTimer !== null) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
  syncRetryAttempt = 0;
}

/** Debounced push trigger: called by writeJson (for CONFIG_KEYS).
 *  Coalesces rapid local edits into a single push:
 *  - waits SYNC_QUIET_MS of inactivity before firing (cancels the timer on each new edit),
 *  - but forces a push after SYNC_MAX_WAIT_MS of continuous editing regardless.
 *  Dirty-checks via localPending() before scheduling anything so that net-zero
 *  edits (e.g. add then delete a tag within the debounce window) never trigger
 *  a network push. */
function markLocalChange() {
  if (!localStorage.getItem(K_GH_TOKEN)) return;  // not logged in
  if (syncConflictPending) return;                 // paused until conflict is resolved
  if (!localPending()) {
    // Net state matches the last sync snapshot — nothing real changed.
    // Cancel any queued push and reset the button.
    if (autoSyncTimer !== null) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
    syncPendingSince = 0;
    setSyncBtnState('synced');
    return;
  }
  setSyncBtnState('pending');                      // show queued-upload icon immediately
  const now = Date.now();
  if (syncPendingSince === 0) syncPendingSince = now;
  if (autoSyncTimer !== null) clearTimeout(autoSyncTimer);
  if (now - syncPendingSince >= SYNC_MAX_WAIT_MS) {
    // Forced flush: too long since first pending change — push immediately
    syncPendingSince = 0;
    void autoSync();
    return;
  }
  autoSyncTimer = window.setTimeout(() => {
    autoSyncTimer = null; syncPendingSince = 0;
    // Re-check: state may have reverted since the timer was set (e.g. user
    // deleted the tag they just added). Only push if still dirty.
    if (localPending()) void autoSync(); else setSyncBtnState('synced');
  }, SYNC_QUIET_MS);
}

let syncInFlight = false; // re-entrancy guard: prevents overlapping pushes

/** Shared sync core. `auto:false` = manual (toasts + opens conflict modal);
 *  `auto:true` = silent (no toasts; 401 clears creds quietly; conflict marks pending state).
 *
 *  Rate-saving: sends If-None-Match on the gist GET so an unchanged remote returns 304,
 *  which GitHub does not bill against the rate limit. */
async function runSync({ auto }: { auto: boolean }): Promise<void> {
  if (syncInFlight) { if (!auto) toast('Syncing…'); return; }
  syncInFlight = true;
  setSyncBtnState('syncing');
  // Use getValidToken to proactively refresh if the access token is near expiry
  const token = await getValidToken();
  if (!token) {
    if (!auto) toast('Not logged in');
    setSyncBtnState(localPending() ? 'pending' : 'synced');
    syncInFlight = false; return;
  }
  if (!auto) toast('Syncing…');

  /** Shared success epilogue: settle the button to the appropriate steady state. */
  const onSyncDone = (msg?: string) => {
    clearSyncRetry(); // success — cancel any pending retry
    if (!auto && msg) toast(msg);
    renderSettings();
    setSyncBtnState(localPending() ? 'pending' : 'synced');
  };

  try {
    const gistId = await ensureGist(token, { silent: auto });

    // Conditional GET: send ETag so GitHub can return 304 (not counted against rate limit)
    const storedEtag = localStorage.getItem(K_SYNC_ETAG);
    const gistRes = await ghFetch(
      `https://api.github.com/gists/${gistId}`, token,
      storedEtag ? { headers: { 'If-None-Match': storedEtag } } : undefined,
      { silent: auto },
    );

    // 304: remote is unchanged since our last fetch — check if we need to push
    if (gistRes.status === 304) {
      const local = serializeSettings();
      const meta = readJson<SyncMeta | null>(K_SYNC_META, null);
      const localChanged = meta ? bundleFingerprint(local) !== meta.localFingerprint : true;
      if (!localChanged) {
        // Truly up to date — just bump the "last synced" display
        if (meta) writeJson(K_SYNC_META, { ...meta, lastSyncedAt: new Date().toISOString() } satisfies SyncMeta);
        if (auto) lastAutoPullAt = Date.now();
        onSyncDone(!auto ? 'Already up to date' : undefined);
        return;
      }
      // Local changed but remote same — push
      await pushBundle(token, gistId, local);
      onSyncDone(!auto ? 'Synced ✓' : undefined);
      return;
    }

    if (!gistRes.ok) throw new Error('Fetch gist failed');

    // Save the fresh ETag for the next conditional GET
    const freshEtag = gistRes.headers.get('ETag');
    if (freshEtag) { try { localStorage.setItem(K_SYNC_ETAG, freshEtag); } catch { /* ignore */ } }

    const gist = await gistRes.json() as { files: { 'confer-config.json'?: { content?: string } } };
    const content = gist.files['confer-config.json']?.content;
    const local = serializeSettings();
    const meta = readJson<SyncMeta | null>(K_SYNC_META, null);

    // Parse remote; updatedAt presence marks a real push (vs empty placeholder gist)
    let remote: SettingsBundle | null = null;
    try { if (content) remote = JSON.parse(content) as SettingsBundle; } catch { /* corrupt gist */ }
    const hasRealRemote = !!(remote?.updatedAt);

    if (!hasRealRemote) {
      // Empty or placeholder gist — first push from this device
      await pushBundle(token, gistId, local);
      onSyncDone(!auto ? 'Synced ✓' : undefined);
      return;
    }
    if (!meta) {
      // This device has never synced before but remote exists — pull down
      applyRemoteBundle(remote!);
      onSyncDone(!auto ? 'Synced ✓ — pulled cloud config' : undefined);
      return;
    }

    const localChanged = bundleFingerprint(local) !== meta.localFingerprint;
    const remoteChanged = (remote!.updatedAt ?? '') !== meta.remoteUpdatedAt;

    if (!localChanged && !remoteChanged) {
      // Bump lastSyncedAt to reflect the confirmed-in-sync check time
      writeJson(K_SYNC_META, { ...meta, lastSyncedAt: new Date().toISOString() } satisfies SyncMeta);
      if (auto) lastAutoPullAt = Date.now();
      onSyncDone(!auto ? 'Already up to date' : undefined);
      return;
    }
    if (localChanged && !remoteChanged) {
      await pushBundle(token, gistId, local);
      onSyncDone(!auto ? 'Synced ✓' : undefined);
      return;
    }
    if (!localChanged) {
      applyRemoteBundle(remote!);
      onSyncDone(!auto ? 'Synced ✓' : undefined);
      return;
    }

    // Both sides changed — try to resolve automatically before showing a modal
    //
    // 1. Content-equality short-circuit: if the two sides happen to carry the
    //    same effective content (e.g. a keepalive flush succeeded on another tab),
    //    reconcile silently without a modal.
    if (bundleFingerprint(local) === bundleFingerprint(remote!)) {
      const now = new Date().toISOString();
      writeJson(K_SYNC_META, { ...meta, localFingerprint: bundleFingerprint(local), lastSyncedAt: now, base: local } satisfies SyncMeta);
      if (auto) lastAutoPullAt = Date.now();
      onSyncDone(!auto ? 'Already up to date' : undefined);
      return;
    }

    // 2. 3-way merge: if we have a shared base, attempt an automatic merge.
    //    When every item-level change is unambiguous, apply and push silently.
    //    Only fall through to the stash/modal path for genuine per-item conflicts.
    if (meta.base) {
      const { merged, conflicts: mergeConflicts } = mergeThreeWay(meta.base, local, remote!);
      if (!mergeConflicts.length) {
        applySettingsBundle(merged);
        await pushBundle(token, gistId, serializeSettings());
        if (auto) lastAutoPullAt = Date.now();
        onSyncDone(!auto ? 'Synced ✓ — merged changes' : undefined);
        return;
      }
      // Partial conflicts: update the stashed bundles to the attempted merge result
      // so the conflict modal shows only the genuinely unresolvable items.
    }

    // True conflict — both sides changed and could not be automatically merged
    setSyncBtnState(localPending() ? 'pending' : 'synced');
    if (auto) {
      // Don't pop modal; stash and show passive indicator
      stashConflict(local, remote!, token, gistId);
      syncConflictPending = true;
      renderSettings();
    } else {
      renderConflict(local, remote!, token, gistId);
    }
  } catch (e: unknown) {
    setSyncBtnState(localPending() ? 'pending' : 'synced');
    if ((e as Error).message !== 'gh_401') {
      if (!auto) toast('Sync failed');
      // Silent failure: schedule a retry if there is still something to push
      if (auto && localPending()) scheduleSyncRetry();
    }
    console.error(e);
  } finally {
    syncInFlight = false;
  }
}

/** One-click sync: auto-detect direction, or open conflict modal on true conflict. */
async function syncNow() {
  return runSync({ auto: false });
}

/** Silent background sync triggered by local mutations or tab focus. */
async function autoSync() {
  return runSync({ auto: true });
}

/** Stash conflict state and pre-render the diff body (does not open the modal). */
function stashConflict(local: SettingsBundle, remote: SettingsBundle, token: string, gistId: string) {
  conflictLocal = local; conflictRemote = remote; conflictToken = token; conflictGistId = gistId;
  const body = document.querySelector<HTMLElement>('#conflictBody');
  if (body) body.innerHTML = diffBundles(local, remote);
}

/** Open the conflict resolution modal with a diff of local vs remote. */
function renderConflict(local: SettingsBundle, remote: SettingsBundle, token: string, gistId: string) {
  stashConflict(local, remote, token, gistId);
  $('#conflictModal').hidden = false;
}

/** Close the conflict modal and clear pending state. */
function closeConflictModal() {
  $('#conflictModal').hidden = true;
  // Keep conflict state if the user dismissed without resolving (so the ".gh-conflict"
  // indicator can re-open the modal). Only clear after a resolution or sign-out.
  if (!syncConflictPending) {
    conflictLocal = null; conflictRemote = null; conflictToken = ''; conflictGistId = '';
  }
}

/** Execute the chosen conflict resolution and update sync meta. */
async function resolveSyncConflict(choice: 'local' | 'cloud' | 'merge') {
  const local = conflictLocal, remote = conflictRemote;
  const token = conflictToken, gistId = conflictGistId;
  closeConflictModal();
  if (!local || !remote || !token || !gistId) return;
  try {
    if (choice === 'local') {
      await pushBundle(token, gistId, local);
      toast('Synced ✓ — kept your local changes');
    } else if (choice === 'cloud') {
      applyRemoteBundle(remote);
      toast('Synced ✓ — applied cloud changes');
    } else {
      applySettingsBundle(remote, { merge: true });
      await pushBundle(token, gistId, serializeSettings());
      toast('Synced ✓ — merged both sides');
    }
    syncConflictPending = false; // resume auto-sync after resolution
    renderSettings();
  } catch { toast('Sync failed after resolution'); }
}

/** Snapshot all personal data into a portable bundle. */
function serializeSettings(): SettingsBundle {
  return {
    app: 'confer', version: 2, exportedAt: new Date().toISOString(),
    venueGroups: state.groups,
    collections: state.collections,
    paperTags: Object.fromEntries([...state.tags].filter(([, v]) => v.length)),
    savedSearches: state.saved,
    paperNotes: Object.fromEntries([...state.notes].filter(([, v]) => v)),
    readStatus: Object.fromEntries([...state.status].filter(([, v]) => v && v !== 'unread')),
  };
}

/** Apply a (possibly partial) settings bundle into live state.
 *  `merge: true` unions arrays/maps instead of replacing them — use for
 *  importing a *shared* subset without clobbering the recipient's own data. */
function applySettingsBundle(d: Partial<SettingsBundle>, opts?: { merge?: boolean }) {
  const merge = opts?.merge ?? false;
  if (Array.isArray(d.venueGroups)) {
    state.groups = merge ? [...state.groups, ...d.venueGroups.filter((g) => !state.groups.find((x) => x.id === g.id))] : d.venueGroups;
    saveGroups();
  }
  if (Array.isArray(d.collections)) {
    state.collections = merge ? [...state.collections, ...d.collections.filter((c) => !state.collections.find((x) => x.id === c.id))] : d.collections;
    saveCollections();
  }
  if (d.paperTags && typeof d.paperTags === 'object') {
    if (merge) {
      for (const [k, v] of Object.entries(d.paperTags)) {
        const existing = state.tags.get(k) ?? [];
        state.tags.set(k, [...new Set([...existing, ...v])]);
      }
    } else {
      state.tags = new Map(Object.entries(d.paperTags as Record<string, string[]>));
    }
    saveTags();
  }
  if (Array.isArray(d.savedSearches)) {
    state.saved = merge ? [...state.saved, ...d.savedSearches.filter((s) => !state.saved.find((x) => x.name === s.name))] : d.savedSearches;
    writeJson(K_SAVED, state.saved);
  }
  if (d.paperNotes && typeof d.paperNotes === 'object') {
    if (merge) {
      for (const [k, v] of Object.entries(d.paperNotes)) { if (v && !state.notes.has(k)) state.notes.set(k, v as string); }
    } else {
      state.notes = new Map(Object.entries(d.paperNotes as Record<string, string>));
    }
    saveNotes();
  }
  if (d.readStatus && typeof d.readStatus === 'object') {
    if (merge) {
      for (const [k, v] of Object.entries(d.readStatus)) { if (v && !state.status.has(k)) state.status.set(k, v as string); }
    } else {
      state.status = new Map(Object.entries(d.readStatus as Record<string, string>));
    }
    saveStatus();
  }
  reflectSidebar(); renderVenueGroups(); reflectSeriesGroup(); renderSaved(); renderSettings();
  writeUrl();
  ensureLoaded([...state.selected]).then(render);
}

/** Re-read all CONFIG_KEYS from localStorage into live state and re-render.
 *  Called in response to cross-tab `storage` events so every open tab stays
 *  in sync with whichever tab just mutated shared config. */
function reloadConfigFromStorage() {
  state.groups      = readJson<VenueGroup[]>(K_VGROUPS, []);
  state.collections = readJson<Collection[]>(K_COLLECTIONS, []);
  state.tags        = new Map<string, string[]>(Object.entries(readJson<Record<string, string[]>>(K_TAGS, {})));
  state.saved       = readJson<SavedSearch[]>(K_SAVED, []);
  state.notes       = new Map<string, string>(Object.entries(readJson<Record<string, string>>(K_NOTES, {})));
  state.status      = new Map<string, string>(Object.entries(readJson<Record<string, string>>(K_STATUS, {})));
  reflectSidebar(); renderVenueGroups(); reflectSeriesGroup(); renderSaved();
  reflectCollectionFilter(); reflectTagFilter(); reflectStatusFilter(); renderSettings();
  ensureLoaded([...state.selected]).then(render);
}

function exportSettings() {
  const data = serializeSettings();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'confer-settings.json' });
  a.click(); URL.revokeObjectURL(a.href);
  toast('Exported settings');
}
function importSettings(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applySettingsBundle(JSON.parse(String(reader.result)));
      toast('Imported settings');
    } catch { toast('Invalid settings file'); }
  };
  reader.readAsText(file);
}

// --- sidebar (desktop collapse) ---------------------------------------
function setSidebarCollapsed(on: boolean) {
  document.documentElement.classList.toggle('is-sidebar-collapsed', on);
  try { localStorage.setItem(K_SIDEBAR, on ? '1' : '0'); } catch { /* ignore */ }
}
function setRailCollapsed(on: boolean) {
  document.documentElement.classList.toggle('is-rail-collapsed', on);
  try { localStorage.setItem(K_RAIL, on ? '1' : '0'); } catch { /* ignore */ }
}

// Set the search query and re-render (used by author/inst/chart clicks).
function setQuery(q: string) {
  state.query = q;
  state.shown = PAGE;
  writeUrl();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- modals ------------------------------------------------------------
function closeModals() {
  if (promptResolver) settlePrompt(null);
  if (confirmResolver) settleConfirm(false);
  noteDlgKey = '';
  document.querySelectorAll<HTMLElement>('.modal').forEach((m) => { m.hidden = true; });
  closePop();
  stopNetwork();
}

// --- caret-select (custom dropdown) -----------------------------------
function toggleCaret(btn: HTMLElement) {
  const menu = btn.nextElementSibling as HTMLElement;
  document.querySelectorAll<HTMLElement>('.caret-select-btn[aria-expanded="true"]').forEach((b) => {
    if (b !== btn) { b.setAttribute('aria-expanded', 'false'); (b.nextElementSibling as HTMLElement).hidden = true; }
  });
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
  menu.hidden = open;
}
function closeAllCarets() {
  document.querySelectorAll<HTMLElement>('.caret-select-btn[aria-expanded="true"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false');
    (btn.nextElementSibling as HTMLElement).hidden = true;
  });
}
const SORT_LABELS: Record<string, string> = {
  venue: 'Sort: Venue', date: 'Sort: Date', id: 'Sort: Paper ID',
  title: 'Sort: Title', authors: 'Sort: Authors',
};
function reflectSort() {
  const label = document.querySelector<HTMLElement>('#sortSelect .caret-select-label');
  if (label) label.textContent = SORT_LABELS[state.sort] ?? 'Sort: Venue';
  document.querySelectorAll<HTMLElement>('#sortSelect .caret-option').forEach((opt) => {
    opt.classList.toggle('is-on', opt.dataset.sortVal === state.sort);
  });
}

// --- theme -------------------------------------------------------------
/** Resolve a stored theme choice to the actual CSS value applied to the document. */
function effectiveTheme(choice: string): 'dark' | 'light' {
  if (choice === 'auto') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return choice === 'dark' ? 'dark' : 'light';
}
function reflectTheme() {
  const choice = localStorage.getItem(K_THEME) ?? 'auto';
  const iconMap: Record<string, string> = { light: ICONS.moon, dark: ICONS.sun, auto: ICONS.auto };
  const icon = iconMap[choice] ?? ICONS.auto;
  const titleMap: Record<string, string> = {
    light: 'Theme: light — click to cycle',
    dark: 'Theme: dark — click to cycle',
    auto: 'Theme: auto (follows OS) — click to cycle',
  };
  const titleText = titleMap[choice] ?? 'Toggle theme';
  document.querySelectorAll('[data-theme-icon]').forEach((el) => { el.innerHTML = icon; });
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((btn) => {
    btn.title = titleText;
    btn.setAttribute('aria-label', titleText);
  });
}
function cycleTheme() {
  const current = localStorage.getItem(K_THEME) ?? 'auto';
  const next = current === 'light' ? 'dark' : current === 'dark' ? 'auto' : 'light';
  try { localStorage.setItem(K_THEME, next); } catch { /* ignore */ }
  document.documentElement.dataset.theme = effectiveTheme(next);
  reflectTheme();
  // Theme is not part of the synced bundle; no markLocalChange() needed.
}
function applyAccent(name: string) {
  const key = name in ACCENTS ? name : 'clay';
  if (key === 'clay') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = key;
  try { localStorage.setItem(K_ACCENT, key); } catch { /* ignore */ }
  // Accent is not part of the synced bundle; no markLocalChange() needed.
}

/** Best-effort flush: fire a keepalive PATCH for any pending local changes before
 *  the page unloads. The meta is intentionally NOT updated here — the device stays
 *  "pending" so a dropped keepalive is recovered/reconciled on next startup pull.
 *  (Feature 4's content-equality check makes a successful flush a clean no-op.) */
function flushPendingSync() {
  const token = localStorage.getItem(K_GH_TOKEN);
  if (!token) return;
  if (syncConflictPending) return;
  if (!localPending()) return;
  const gistId = localStorage.getItem(K_GIST_ID);
  if (!gistId) return; // no cached gist id — rely on startup pull for recovery
  if (autoSyncTimer !== null) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
  const now = new Date().toISOString();
  const payload = JSON.stringify({ ...serializeSettings(), updatedAt: now });
  void fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    keepalive: true,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: { 'confer-config.json': { content: payload } } }),
  });
}

// --- events ------------------------------------------------------------
function wire() {
  // sidebar venue checkboxes
  document.querySelectorAll<HTMLInputElement>('[data-venue-check]').forEach((cb) => {
    cb.addEventListener('change', () => setVenue(cb.value, cb.checked));
  });
  // collapse categories (animated via the .is-collapsed grid-rows trick)
  document.querySelectorAll<HTMLButtonElement>('[data-cat-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'false';
      btn.setAttribute('aria-expanded', String(!open));
      btn.closest('.venue-cat')?.classList.toggle('is-collapsed', open);
    });
  });
  // collapse a series (default collapsed) to reveal/hide its year rows
  document.querySelectorAll<HTMLButtonElement>('[data-series-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'false';
      btn.setAttribute('aria-expanded', String(!open));
      btn.closest('.venue-series')?.classList.toggle('is-collapsed', open);
    });
  });
  // series "select all years" checkbox
  document.querySelectorAll<HTMLInputElement>('[data-series-check]').forEach((master) => {
    master.addEventListener('change', () => {
      const series = master.closest('.venue-series');
      const ids = [...(series?.querySelectorAll<HTMLInputElement>('[data-venue-check]') ?? [])].map((c) => c.value);
      setVenues(ids, master.checked);
    });
  });
  // venue filter in sidebar (text)
  $<HTMLInputElement>('[data-venue-search]').addEventListener('input', applyVenueFilter);
  // group chips + per-series group button (delegated within the nav)
  $('.venue-nav').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const groupBtn = target.closest<HTMLElement>('[data-series-group]');
    if (groupBtn) {
      if (popAnchor === groupBtn && !popEl.hidden) closePop();
      else openGroupPop(groupBtn, groupBtn.dataset.seriesGroup ?? '');
      return;
    }
    const selBtn = target.closest<HTMLElement>('[data-group-select]');
    if (selBtn) {
      const g = state.groups.find((x) => x.id === selBtn.dataset.groupSelect);
      if (g) {
        const ids = venuesOfGroup(g);
        // Exact match → clicking again clears the selection; otherwise select
        // exactly this group's venues (deselecting anything outside it).
        const exact = ids.length > 0 && state.selected.size === ids.length && ids.every((id) => state.selected.has(id));
        if (exact) setVenuesExclusive([]); else setVenuesExclusive(ids);
      }
      return;
    }
    const delBtn = target.closest<HTMLElement>('[data-group-del]');
    if (delBtn) { deleteGroup(delBtn.dataset.groupDel ?? ''); return; }
  });
  $('[data-select-all]').addEventListener('click', () => { manifest.forEach((v) => state.selected.add(v.id)); state.shown = PAGE; reflectSidebar(); writeUrl(); ensureLoaded([...state.selected]).then(render); });
  $('[data-select-none]').addEventListener('click', () => { state.selected.clear(); reflectSidebar(); writeUrl(); rebuildRows(); render(); });
  $('[data-collapse-all]').addEventListener('click', () => {
    const btn = $<HTMLButtonElement>('[data-collapse-all]');
    // If any series is currently expanded, collapse all; otherwise expand all.
    const anyExpanded = !!document.querySelector('.venue-series:not(.is-collapsed)');
    document.querySelectorAll<HTMLElement>('.venue-series').forEach((el) => {
      el.classList.toggle('is-collapsed', anyExpanded);
      el.querySelector('[data-series-toggle]')?.setAttribute('aria-expanded', String(!anyExpanded));
    });
    // Flip button state: aria-expanded = whether things are now expanded
    btn.setAttribute('aria-expanded', String(!anyExpanded));
    btn.title = anyExpanded ? 'Expand all venues' : 'Collapse all venues';
    btn.setAttribute('aria-label', btn.title);
    // Swap icon: chevrons-down-up (collapse) vs chevrons-up-down (expand)
    btn.querySelector('svg')!.innerHTML = anyExpanded
      ? '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>'  // expand (chevrons pointing out)
      : '<polyline points="7 11 12 6 17 11"/><polyline points="7 18 12 13 17 18"/>'; // collapse (chevrons pointing in)
  });

  // search — with field-aware highlight overlay, autocomplete, and debounce tuning
  const searchHlEl = document.querySelector<HTMLElement>('.search-hl');
  let searchSuggestion: string | null = null;  // active autocomplete suffix
  let isComposing = false;
  let t = 0;

  renderSearchHL = function () {
    if (!searchHlEl) return;
    const val = els.search.value;
    const caret = els.search.selectionStart ?? val.length;
    const token = activeToken(val, caret);
    searchSuggestion = fieldSuggestion(token);
    searchHlEl.innerHTML = buildSearchHlHtml(val, searchSuggestion, caret);
    // Keep horizontal scroll in sync
    searchHlEl.scrollLeft = els.search.scrollLeft;
  };

  function commitSearchQuery() {
    state.query = els.search.value;
    state.shown = PAGE;
    writeUrl();
    render();
  }

  function onSearchInput() {
    if (!isComposing) {
      // Normalise field prefixes (full-width colon, trailing spaces)
      const before = els.search.value;
      const caret = els.search.selectionStart ?? before.length;
      const after = normalizeFieldTokens(before);
      if (after !== before) {
        // Preserve caret: count how far the normalisation moved the prefix
        const newCaret = normalizeFieldTokens(before.slice(0, caret)).length;
        els.search.value = after;
        els.search.setSelectionRange(newCaret, newCaret);
      }
    }
    renderSearchHL();
    clearTimeout(t);
    // Adaptive debounce: slower while actively typing a field name (suggestion active),
    // medium when a completed field: token is present, fast otherwise.
    const delay = searchSuggestion ? 450 : queryHasFieldToken(els.search.value) ? 350 : 130;
    t = window.setTimeout(commitSearchQuery, delay);
  }

  els.search.addEventListener('compositionstart', () => { isComposing = true; });
  els.search.addEventListener('compositionend', () => { isComposing = false; onSearchInput(); });
  els.search.addEventListener('input', onSearchInput);
  // Keep overlay scroll in sync when the user scrolls a long query
  els.search.addEventListener('scroll', () => { if (searchHlEl) searchHlEl.scrollLeft = els.search.scrollLeft; });
  // Tab key: complete active field suggestion
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && searchSuggestion) {
      e.preventDefault();
      const val = els.search.value;
      const caret = els.search.selectionStart ?? val.length;
      const token = activeToken(val, caret);
      // Replace the token with the full field + colon
      const before = val.slice(0, caret - token.length);
      const after = val.slice(caret);
      const neg = token.startsWith('-') ? '-' : '';
      const rawToken = token.replace(/^-/, '');
      const fullField = neg + rawToken + searchSuggestion;  // e.g. "author:"
      const newVal = before + fullField + after;
      const newCaret = before.length + fullField.length;
      els.search.value = newVal;
      els.search.setSelectionRange(newCaret, newCaret);
      onSearchInput();
    }
  });
  els.searchClear.addEventListener('click', () => {
    state.query = ''; els.search.value = ''; renderSearchHL(); writeUrl(); render(); els.search.focus();
  });
  // Sort caret-select
  $('#sortSelect').addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('[data-sort-val]');
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.caret-select-btn');
    if (opt) { state.sort = opt.dataset.sortVal ?? 'venue'; try { localStorage.setItem(K_SORT, state.sort); } catch { /* ignore */ } closeAllCarets(); reflectSort(); writeUrl(); render(); return; }
    if (btn) toggleCaret(btn);
  });
  // Collection filter caret-select
  document.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('#collectionFilter [data-col-val]');
    const btn = (e.target as HTMLElement).closest<HTMLElement>('#collectionFilter .caret-select-btn');
    if (opt) {
      state.collection = opt.dataset.colVal ?? ''; state.shown = PAGE;
      const c = state.collection ? collectionById(state.collection) : undefined;
      closeAllCarets(); reflectCollectionFilter();
      if (c) {
        const need = [...new Set(c.keys.map((k) => k.split(':')[0]))].filter((id) => venueById.has(id) && !state.selected.has(id));
        need.forEach((id) => state.selected.add(id));
        reflectSidebar();
        ensureLoaded([...state.selected]).then(() => { writeUrl(); render(); });
      } else { writeUrl(); render(); }
      return;
    }
    if (btn) { toggleCaret(btn); return; }
    // close on click outside any caret-select
    if (!(e.target as HTMLElement).closest('.caret-select')) closeAllCarets();
  });

  // Tag filter pill
  const tagFilterBtn = document.querySelector<HTMLElement>('#tagFilterBtn');
  if (tagFilterBtn) {
    tagFilterBtn.addEventListener('click', () => {
      if (popAnchor === tagFilterBtn && !popEl.hidden) closePop();
      else openTagFilterPop(tagFilterBtn);
    });
  }
  const statusFilterBtn = document.querySelector<HTMLElement>('#statusFilterBtn');
  if (statusFilterBtn) {
    statusFilterBtn.addEventListener('click', () => {
      if (popAnchor === statusFilterBtn && !popEl.hidden) closePop();
      else openStatusFilterPop(statusFilterBtn);
    });
  }
  // Notes filter toggle (show only papers with notes)
  const notesFilterBtn = document.querySelector<HTMLElement>('#notesFilterBtn');
  if (notesFilterBtn) {
    notesFilterBtn.addEventListener('click', () => {
      state.notesOnly = !state.notesOnly;
      state.shown = PAGE;
      writeUrl();
      render();
      reflectNotesFilter();
    });
  }
  // "For you" toolbar button — global recommendations
  document.body.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-open-recommend]')) {
      openRecommendLoading('For you — recommended papers');
      ensureAllLoaded().then(() => {
        populateRecommendModal('For you — recommended papers', recommendGlobal(40));
      });
    }
  });

  // Note dialog buttons
  $<HTMLButtonElement>('#noteDialogClose').addEventListener('click', () => settleNoteDlg('close'));
  $<HTMLButtonElement>('#noteDialogEditBtn').addEventListener('click', () => showNoteDlgEdit(noteOf(noteDlgKey)));
  $<HTMLButtonElement>('#noteDialogDeleteBtn').addEventListener('click', () => settleNoteDlg('delete'));
  $<HTMLButtonElement>('#noteDialogSaveBtn').addEventListener('click', () => settleNoteDlg('save'));
  $<HTMLButtonElement>('#noteDialogCancelBtn').addEventListener('click', () => settleNoteDlg('cancel'));
  $<HTMLTextAreaElement>('#noteDialogTextarea').addEventListener('input', (e) => {
    updateNoteDlgChar((e.target as HTMLTextAreaElement).value.length);
  });
  $('#noteDialog').addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') settleNoteDlg('close');
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) settleNoteDlg('save');
  });
  $('#noteDialog').addEventListener('click', (e: MouseEvent) => {
    if (e.target === document.getElementById('noteDialog')) settleNoteDlg('close');
  });

  // facets toggle + changes
  $('[data-facets-toggle]').addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const open = els.facetsWrap.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  });
  els.facets.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement;
    if (!cb.dataset.facet) return;
    const set = cb.dataset.facet === 'track' ? state.tracks : cb.dataset.facet === 'event' ? state.events : state.venuesFacet;
    if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    state.shown = PAGE; writeUrl(); render();
  });
  // collapse individual facet groups (animated; no full re-render needed)
  els.facets.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-facet-group-toggle]');
    if (!btn) return;
    const groupEl = btn.closest<HTMLElement>('[data-facet-group]');
    const title = groupEl?.dataset.facetGroup ?? '';
    const open = btn.getAttribute('aria-expanded') !== 'false';
    if (open) state.facetCollapsed.add(title); else state.facetCollapsed.delete(title);
    btn.setAttribute('aria-expanded', String(!open));
    groupEl?.classList.toggle('is-collapsed', open);
  });
  els.active.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-clear-filters]')) { clearFilters(); return; }
    const btn = target.closest<HTMLElement>('[data-remove-filter]');
    if (!btn) return;
    const kind = btn.dataset.kind;
    if (kind === 'query') { state.query = ''; }
    else if (kind === 'statusfilter') { state.statusFilter = ''; }
    else if (kind === 'notesonly') { state.notesOnly = false; reflectNotesFilter(); }
    else {
      const set = kind === 'track' ? state.tracks : kind === 'event' ? state.events : kind === 'tagfilter' ? state.tagFilter : state.venuesFacet;
      set.delete(btn.dataset.val ?? '');
    }
    state.shown = PAGE; writeUrl(); render();
  });

  // paper list delegation
  els.list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('.paper-card');
    if (!card) return;
    const toggle = target.closest<HTMLButtonElement>('[data-card-toggle]');
    if (toggle) {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      card.classList.toggle('is-open', !open);
      return;
    }
    const k = card.dataset.key ?? '';
    const statusCycle = target.closest<HTMLElement>('[data-status-cycle]');
    const noteEdit = target.closest<HTMLElement>('[data-note-edit]');
    const collectBtn = target.closest<HTMLElement>('[data-collect]');
    const tagDel = target.closest<HTMLElement>('[data-tag-del]');
    if (statusCycle) {
      const cur = statusOf(k);
      const next = STATUS_NEXT[cur] ?? 'reading';
      if (next === 'unread') state.status.delete(k); else state.status.set(k, next);
      saveStatus();
      // Targeted in-place update to avoid full re-render on every status click
      const btn = card.querySelector<HTMLElement>('[data-status-cycle]');
      if (btn) {
        btn.className = `icon-btn status-btn status-btn--${next}`;
        btn.title = STATUS_TITLE[next] ?? '';
        btn.setAttribute('aria-label', STATUS_TITLE[next] ?? '');
        btn.innerHTML = STATUS_ICONS[next] ?? '';
      }
      reflectStatusFilter();
    } else if (noteEdit) {
      openNoteDialog(k);
    } else if (collectBtn) {
      if (popAnchor === collectBtn && !popEl.hidden) closePop();
      else openCollectPop(collectBtn, k);
    } else if (tagDel) {
      removeTag(k, tagDel.dataset.tagDel ?? '');
    } else if (target.closest('[data-tag-add]')) {
      const tagBtn = target.closest<HTMLElement>('[data-tag-add]')!;
      if (popAnchor === tagBtn && !popEl.hidden) closePop();
      else openTagPop(tagBtn, k);
    } else if (target.closest('[data-tag]')) {
      setQuery(`tag:"${(target.closest('[data-tag]') as HTMLElement).dataset.tag!}"`);
    } else if (target.closest('[data-venue-badge]')) {
      const v = k.split(':')[0];
      state.venuesFacet.has(v) ? state.venuesFacet.delete(v) : state.venuesFacet.add(v);
      state.shown = PAGE; writeUrl(); render();
    } else if (target.closest('[data-find-similar]')) {
      const fk = (target.closest('[data-find-similar]') as HTMLElement).dataset.findSimilar!;
      openRecommendLoading('Similar papers');
      ensureAllLoaded().then(() => {
        populateRecommendModal('Similar papers', similarGlobal(fk, 30));
      });
    } else if (target.closest('[data-inst]')) {
      setQuery(`inst:"${(target.closest('[data-inst]') as HTMLElement).dataset.inst!}"`);
    } else if (target.closest('[data-author]')) {
      setQuery(`author:"${(target.closest('[data-author]') as HTMLElement).dataset.author!}"`);
    } else if (target.closest('[data-track]')) {
      const tr = (target.closest('[data-track]') as HTMLElement).dataset.track!;
      state.tracks.has(tr) ? state.tracks.delete(tr) : state.tracks.add(tr);
      state.shown = PAGE; writeUrl(); render();
    }
  });
  els.list.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement;
    if (!cb.matches('[data-sel]')) return;
    const k = cb.closest<HTMLElement>('.paper-card')!.dataset.key ?? '';
    if (cb.checked) state.sel.add(k); else state.sel.delete(k);
    cb.closest('.paper-card')?.classList.toggle('is-selected', cb.checked);
    updateExportBar();
  });
  els.more.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'showMore') { state.shown += PAGE; render(); }
  });

  // export bar
  els.exportBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-export]');
    if (btn) doExport(btn.dataset.export!);
  });

  // saved searches (the toolbar button; a second opener lives in Settings)
  $('[data-save-current]').addEventListener('click', () => saveCurrentSearch());

  // theme, help, modals
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', cycleTheme));
  $('[data-help]').addEventListener('click', () => { $('#helpModal').hidden = false; });
  document.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));
  // [data-open-saved] appears both in the toolbar and inside Settings — closing any
  // open modal first prevents Settings from sitting on top of the Saved dialog.
  document.body.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-open-saved]')) { closeModals(); renderSaved(); $('#savedModal').hidden = false; }
  });
  $('#savedList').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const load = target.closest<HTMLElement>('[data-saved-load]');
    const del = target.closest<HTMLElement>('[data-saved-del]');
    if (load) loadSaved(Number(load.dataset.savedLoad));
    if (del) { state.saved.splice(Number(del.dataset.savedDel), 1); writeJson(K_SAVED, state.saved); renderSaved(); renderSettings(); }
  });

  // custom text prompt (replaces window.prompt)
  $('#promptForm').addEventListener('submit', (e) => { e.preventDefault(); settlePrompt($<HTMLInputElement>('#promptInput').value); });
  document.querySelectorAll('[data-prompt-cancel]').forEach((b) => b.addEventListener('click', () => settlePrompt(null)));

  // custom confirm dialog
  $('#confirmOk').addEventListener('click', () => settleConfirm(true));
  document.querySelectorAll('[data-confirm-cancel]').forEach((b) => b.addEventListener('click', () => settleConfirm(false)));

  // conflict resolution modal
  $('#conflictModal').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-conflict-cancel]')) { closeConflictModal(); return; }
    if (t.closest('[data-conflict-local]')) { void resolveSyncConflict('local'); return; }
    if (t.closest('[data-conflict-cloud]')) { void resolveSyncConflict('cloud'); return; }
    if (t.closest('[data-conflict-merge]')) { void resolveSyncConflict('merge'); return; }
  });

  // settings modal: open + delegated actions + import file picker
  const importInput = $<HTMLInputElement>('#importFile');
  $('[data-settings]').addEventListener('click', () => { renderSettings(); $('#settingsModal').hidden = false; });
  importInput.addEventListener('change', () => { const f = importInput.files?.[0]; if (f) importSettings(f); importInput.value = ''; });
  $('#settingsBody').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-settings-export]')) { exportSettings(); return; }
    if (t.closest('[data-settings-import]')) { importInput.click(); return; }
    if (t.closest('[data-share-full]')) { copyShareLink('full'); return; }
    if (t.closest('[data-gh-login]')) { startGitHubLogin(); return; }
    if (t.closest('[data-sync-now]')) { void syncNow(); return; }
    const acc = t.closest<HTMLElement>('[data-account-menu]');
    if (acc) { if (popAnchor === acc && !popEl.hidden) closePop(); else openAccountMenu(acc); return; }
    if (t.closest('[data-clear-local]')) { clearLocalData(); return; }
    const gShare = t.closest<HTMLElement>('[data-group-share]');
    if (gShare) { copyShareLink('group', gShare.dataset.groupShare); return; }
    const colShare = t.closest<HTMLElement>('[data-col-share]');
    if (colShare) { copyShareLink('collection', colShare.dataset.colShare); return; }
    const accentPick = t.closest<HTMLElement>('[data-accent-pick]');
    if (accentPick) { applyAccent(accentPick.dataset.accentPick!); renderSettings(); return; }
    const gAdd = t.closest<HTMLElement>('[data-group-series-add]');
    if (gAdd) { openSeriesAddPop(gAdd, gAdd.dataset.groupSeriesAdd ?? ''); return; }
    const gRen = t.closest<HTMLElement>('[data-group-rename]');
    if (gRen) { const g = state.groups.find((x) => x.id === gRen.dataset.groupRename); if (g) askText({ title: 'Rename group', value: g.name, max: NAME_MAX, ok: 'Rename' }).then((n) => { const c = cleanInput(n ?? ''); if (c) { g.name = c; saveGroups(); renderVenueGroups(); renderSettings(); } }); return; }
    const gDel = t.closest<HTMLElement>('[data-group-del]');
    if (gDel) { deleteGroup(gDel.dataset.groupDel ?? ''); return; }
    const gsDel = t.closest<HTMLElement>('[data-group-series-del]');
    if (gsDel) { const [id, ...rest] = (gsDel.dataset.groupSeriesDel ?? '').split('|'); const s = rest.join('|'); const g = state.groups.find((x) => x.id === id); if (g) { askConfirm({ title: 'Remove series', message: `Remove ${s} from "${g.name}"?`, ok: 'Remove', danger: false }).then((ok) => { if (!ok) return; g.series = g.series.filter((x) => x !== s); saveGroups(); renderVenueGroups(); reflectSeriesGroup(); renderSettings(); }); } return; }
    const cRen = t.closest<HTMLElement>('[data-col-rename]');
    if (cRen) { const c = collectionById(cRen.dataset.colRename ?? ''); if (c) askText({ title: 'Rename collection', value: c.name, max: NAME_MAX, ok: 'Rename' }).then((n) => { const cl = cleanInput(n ?? ''); if (cl) { c.name = cl; saveCollections(); afterCollectionsChange(); } }); return; }
    const cDel = t.closest<HTMLElement>('[data-col-del]');
    if (cDel) { const c = collectionById(cDel.dataset.colDel ?? ''); if (c) askConfirm({ title: 'Delete collection', message: `Delete collection “${c.name}”?`, ok: 'Delete', danger: true }).then((ok) => { if (!ok) return; state.collections = state.collections.filter((x) => x.id !== c.id); if (state.collection === c.id) state.collection = ''; saveCollections(); afterCollectionsChange(); render(); }); return; }
    const tagPurge = t.closest<HTMLElement>('[data-tag-purge]');
    if (tagPurge) { const tag = tagPurge.dataset.tagPurge ?? ''; const n = tagCounts().get(tag) ?? 0; askConfirm({ title: 'Remove tag', message: `Remove tag "${tag}" from ${n} ${plural(n, 'paper')}? This removes it from all papers.`, ok: 'Remove', danger: true }).then((ok) => { if (!ok) return; for (const [k, tags] of [...state.tags]) { const next = tags.filter((x) => x !== tag); if (next.length) state.tags.set(k, next); else state.tags.delete(k); } saveTags(); renderSettings(); render(); }); return; }
    if (t.closest('[data-open-history]')) { openHistory(); return; }
    if (t.closest('[data-feedback-error]')) { openIssue('error'); return; }
    if (t.closest('[data-feedback-venue]')) { openIssue('venue'); return; }
  });

  // history modal: expand diffs and restore
  const historyBodyEl = document.querySelector<HTMLElement>('#historyBody');
  if (historyBodyEl) {
    historyBodyEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;

      const toggle = t.closest<HTMLElement>('[data-hist-toggle]');
      if (toggle) {
        const item = toggle.closest<HTMLElement>('.hist-item');
        if (!item) return;
        const open = item.classList.toggle('is-open');
        // Swap icon to reflect state — no CSS rotation, matching the sidebar collapse pattern
        toggle.innerHTML = open ? ICONS.chevronUp : ICONS.chevronDown;
        toggle.setAttribute('aria-label', open ? 'Hide changes' : 'Show changes');
        toggle.setAttribute('title', open ? 'Hide changes' : 'Show changes');
        requestAnimationFrame(refreshScrollFades);
        return;
      }

      const restoreBtn = t.closest<HTMLElement>('[data-hist-restore]');
      if (restoreBtn) {
        const version = restoreBtn.dataset.histRestore!;
        void askConfirm({ title: 'Restore version', message: 'Restore this version? Your current config will be overwritten and a new revision will be pushed to the cloud.', ok: 'Restore', danger: true }).then(async (ok) => {
          if (!ok) return;
          const btn = restoreBtn as HTMLButtonElement;
          btn.disabled = true; btn.textContent = 'Restoring…';
          try {
            const bundle = await loadRevision(version);
            applySettingsBundle(bundle);
            const token = await getValidToken();
            if (!token) throw new Error('Not signed in');
            const gistId = localStorage.getItem(K_GIST_ID);
            if (!gistId) throw new Error('No gist');
            await pushBundle(token, gistId, bundle);
            revisionCache.clear();
            toast('Version restored ✓');
            renderSettings();
            openHistory();
          } catch (err) {
            toast(`Restore failed: ${String(err)}`);
            btn.disabled = false; btn.textContent = 'Restore';
          }
        });
        return;
      }
    });
  }

  // similar-papers modal: venue badge on mini-cards filters to that venue;
  // also handles per-row actions (status / note / collect) and bulk selection.
  const entityBodyEl = document.querySelector<HTMLElement>('#entityBody');
  if (entityBodyEl) {
    entityBodyEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;

      // --- Per-row action: status cycle ---
      const miniStatus = t.closest<HTMLElement>('[data-mini-status]');
      if (miniStatus) {
        const k = miniStatus.dataset.miniStatus!;
        const cur = statusOf(k);
        const next = STATUS_NEXT[cur] ?? 'reading';
        if (next === 'unread') state.status.delete(k); else state.status.set(k, next);
        saveStatus();
        // In-place update: button class/icon
        miniStatus.className = `icon-btn status-btn status-btn--${next}`;
        miniStatus.title = STATUS_TITLE[next] ?? '';
        miniStatus.setAttribute('aria-label', STATUS_TITLE[next] ?? '');
        miniStatus.innerHTML = STATUS_ICONS[next] ?? '';
        // Stripe on the row
        const row = miniStatus.closest<HTMLElement>('.mini-card');
        if (row) {
          row.classList.remove('mini-card--toread', 'mini-card--reading', 'mini-card--done');
          if (next !== 'unread') row.classList.add(`mini-card--${next}`);
        }
        reflectStatusFilter();
        return;
      }

      // --- Per-row action: note ---
      const miniNote = t.closest<HTMLElement>('[data-mini-note]');
      if (miniNote) {
        const k = miniNote.dataset.miniNote!;
        openNoteDialog(k);
        // After dialog closes, refresh the note button state in the mini-card
        const refreshNote = () => {
          const noted = !!noteOf(k);
          miniNote.classList.toggle('is-on', noted);
          miniNote.title = noted ? 'Edit note' : 'Add a note';
        };
        // The note dialog uses a custom modal that resolves; hook once on the
        // next mutation or trust the user to re-open the panel (lightweight path).
        const obs = new MutationObserver(() => { refreshNote(); obs.disconnect(); });
        const noteMod = document.querySelector('#noteModal');
        if (noteMod) obs.observe(noteMod, { attributes: true, attributeFilter: ['hidden'] });
        return;
      }

      // --- Per-row action: collect ---
      const miniCollect = t.closest<HTMLElement>('[data-mini-collect]');
      if (miniCollect) {
        const k = miniCollect.dataset.miniCollect!;
        openCollectPop(miniCollect, k);
        // Reflect collect state after pop closes via MutationObserver
        const refreshCollect = () => {
          const on = collectionsOf(k).length > 0;
          miniCollect.classList.toggle('is-on', on);
          miniCollect.setAttribute('aria-pressed', String(on));
          miniCollect.innerHTML = on ? ICONS.bookmarkFilled : ICONS.bookmark;
        };
        const obs2 = new MutationObserver((_, o) => { refreshCollect(); o.disconnect(); });
        obs2.observe(popEl, { attributes: true, attributeFilter: ['hidden'] });
        return;
      }

      // --- Per-row action: tag ---
      const miniTag = t.closest<HTMLElement>('[data-mini-tag]');
      if (miniTag) {
        const k = miniTag.dataset.miniTag!;
        openTagPop(miniTag, k);
        // Reflect tag state after pop closes
        const refreshTag = () => {
          const on = tagsOf(k).length > 0;
          miniTag.classList.toggle('is-on', on);
          miniTag.title = on ? 'Edit tags' : 'Add a tag';
        };
        const obs3 = new MutationObserver((_, o) => { refreshTag(); o.disconnect(); });
        obs3.observe(popEl, { attributes: true, attributeFilter: ['hidden'] });
        return;
      }

      // --- Checkbox selection ---
      const miniSel = t.closest<HTMLInputElement>('[data-mini-sel]');
      if (miniSel) {
        const k = miniSel.dataset.miniSel!;
        if ((miniSel as HTMLInputElement).checked) recPanelState.selected.add(k);
        else recPanelState.selected.delete(k);
        // Update bulk toolbar count in place without full re-render
        const bulkCount = entityBodyEl.querySelector<HTMLElement>('.rec-bulk-count');
        const bulkAdd = entityBodyEl.querySelector<HTMLElement>('[data-rec-add-collection]');
        const n = recPanelState.selected.size;
        if (bulkCount) bulkCount.textContent = `${n} selected`;
        if (n > 0) {
          if (!bulkCount) {
            // Need to add the count + button elements; simplest is a targeted re-render
            renderRecPanel(entityBodyEl);
          } else {
            if (bulkAdd) bulkAdd.textContent = `Add ${n} to collection…`;
          }
        } else {
          // Remove bulk action elements
          bulkCount?.remove();
          bulkAdd?.remove();
        }
        return;
      }

      // --- Bulk: select all ---
      if (t.closest('[data-rec-select-all]')) {
        // Select all currently-filtered rows
        const filtered2 = recPanelState.venueFilter
          ? recPanelState.rows.filter((r) => (venueById.get(r.v)?.series ?? r.v) === recPanelState.venueFilter)
          : recPanelState.rows;
        for (const r of filtered2) recPanelState.selected.add(key(r.v, r.p.id));
        renderRecPanel(entityBodyEl);
        return;
      }

      // --- Bulk: select none ---
      if (t.closest('[data-rec-select-none]')) {
        recPanelState.selected.clear();
        renderRecPanel(entityBodyEl);
        return;
      }

      // --- Bulk: add selected to collection ---
      const addBtn = t.closest<HTMLElement>('[data-rec-add-collection]');
      if (addBtn) {
        const keys = [...recPanelState.selected];
        if (!keys.length) return;
        // Open a pop anchored to the button with all selected keys
        const renderPop = () => {
          const rows2 = state.collections.map((c) =>
            `<div class="pop-row" data-bulk-col-toggle="${c.id}" role="button"><input type="checkbox" tabindex="-1" ${keys.every((k2) => c.keys.includes(k2)) ? 'checked' : ''}><span class="pop-row-label">${esc(c.name)}</span><span class="pop-row-n">${c.keys.length}</span></div>`
          ).join('');
          return `<div class="pop-title">Add ${keys.length} papers to collection</div>${rows2 || '<p class="pop-empty">No collections yet.</p>'}<button class="pop-action" data-bulk-col-new type="button">＋ New collection…</button>`;
        };
        openPop(addBtn, renderPop, (pt) => {
          const toggle = pt.closest<HTMLElement>('[data-bulk-col-toggle]');
          if (toggle) {
            const c = collectionById(toggle.dataset.bulkColToggle ?? '');
            if (c) {
              // Add all missing keys
              for (const k2 of keys) { if (!c.keys.includes(k2)) c.keys.push(k2); }
              saveCollections();
              afterCollectionsChange();
              // Refresh bulk button
              renderRecPanel(entityBodyEl);
            }
            return;
          }
          if (pt.closest('[data-bulk-col-new]')) {
            askText({ title: 'New collection', placeholder: 'Collection name', max: 80 }).then((name) => {
              const clean = (name ?? '').trim();
              if (!clean) return;
              state.collections.push({ id: uid(), name: clean, keys: [...keys] });
              saveCollections();
              afterCollectionsChange();
              renderRecPanel(entityBodyEl);
            });
          }
        });
        return;
      }

      // --- Navigation: venue badge → filter ---
      const miniVenue = t.closest<HTMLElement>('[data-mini-venue]');
      if (miniVenue) {
        const vId = miniVenue.dataset.miniVenue!;
        closeModals();
        const ser = venueById.get(vId)?.series ?? vId;
        setQuery(`venue:"${ser}"`);
        return;
      }
      // --- Navigation: title → search ---
      const titleBtn = t.closest<HTMLElement>('[data-mini-search]');
      if (titleBtn) {
        closeModals();
        setQuery(titleBtn.dataset.miniSearch!);
        return;
      }
      // --- Navigation: author → search ---
      const authorBtn = t.closest<HTMLElement>('[data-mini-author]');
      if (authorBtn) {
        closeModals();
        setQuery(`author:"${authorBtn.dataset.miniAuthor!}"`);
        return;
      }
      // --- Panel controls: venue filter / sort ---
      const venueChip = t.closest<HTMLElement>('[data-rec-venue]');
      if (venueChip) {
        recPanelState.venueFilter = venueChip.dataset.recVenue!;
        renderRecPanel(entityBodyEl);
        return;
      }
      const sortBtn = t.closest<HTMLElement>('[data-rec-sort]');
      if (sortBtn) {
        recPanelState.sort = sortBtn.dataset.recSort as 'sim' | 'year' | 'title';
        renderRecPanel(entityBodyEl);
        return;
      }
    });
  }

  // sidebar: mobile drawer toggle + desktop collapse
  $('[data-sidebar-toggle]').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 860px)').matches) $('#app').classList.add('sidebar-open');
    else setSidebarCollapsed(false);
  });
  $('[data-sidebar-collapse]').addEventListener('click', () => setSidebarCollapsed(true));
  $('#sidebarScrim').addEventListener('click', () => $('#app').classList.remove('sidebar-open'));

  // right rail: collapse / reopen (desktop) or drawer (mobile) + chart drill-down
  $('[data-rail-collapse]').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 1080px)').matches) $('#app').classList.remove('rail-open');
    else setRailCollapsed(true);
  });
  $('[data-rail-toggle]').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 1080px)').matches) $('#app').classList.toggle('rail-open');
    else setRailCollapsed(false);
  });
  $('#railScrim').addEventListener('click', () => $('#app').classList.remove('rail-open'));
  els.railBody.addEventListener('click', (e) => {
    const netBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-open-network]');
    if (netBtn) { openNetwork(netBtn.dataset.openNetwork === 'inst' ? 'inst' : 'author'); return; }
    const trendBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-open-trend]');
    if (trendBtn) { openTrend(); return; }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-chart]');
    if (!btn) return;
    const kind = btn.dataset.chart!;
    const val = btn.dataset.val ?? '';
    if (kind === 'track') {
      state.tracks.has(val) ? state.tracks.delete(val) : state.tracks.add(val);
      state.shown = PAGE; writeUrl(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (kind === 'author') {
      setQuery(`author:"${railAuthorName.get(val) ?? val}"`); // val is a disambiguated key
    } else {
      setQuery(`${kind}:"${val}"`); // inst:"…"
    }
  });

  // auto-sync on tab focus: pull remote changes when switching back to this tab;
  // best-effort flush on tab hide (changes inside the debounce window).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingSync(); // non-blocking keepalive
      return;
    }
    // visible — pull remote
    if (!localStorage.getItem(K_GH_TOKEN)) return;
    if (syncConflictPending) return;
    const now = Date.now();
    if (now - lastAutoPullAt < 30_000) return; // throttle: at most once per 30 s
    lastAutoPullAt = now;
    void autoSync();
  });

  // pagehide fires more reliably than unload; also flush here as a fallback
  window.addEventListener('pagehide', () => { flushPendingSync(); });

  // Live OS theme changes: re-apply only when the user's choice is 'auto'
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem(K_THEME) ?? 'auto') === 'auto') {
      document.documentElement.dataset.theme = effectiveTheme('auto');
    }
  });

  // cross-tab config sync: when another tab writes shared config, mirror it here
  window.addEventListener('storage', (e: StorageEvent) => {
    if (!e.key) return;
    // Another tab mutated user config — reload it into live state
    if ((CONFIG_KEYS as readonly string[]).includes(e.key)) {
      reloadConfigFromStorage();
      setSyncBtnState(localPending() ? 'pending' : 'synced');
      return;
    }
    // Another tab completed a sync — re-evaluate our pending state (may cancel a queued push)
    if (e.key === K_SYNC_META) {
      if (!localPending()) {
        if (autoSyncTimer !== null) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
        syncPendingSince = 0;
        clearSyncRetry();
        setSyncBtnState('synced');
      } else {
        setSyncBtnState('pending');
      }
      return;
    }
    // Another tab signed out
    if (e.key === K_GH_TOKEN && !e.newValue) {
      if (autoSyncTimer !== null) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
      clearSyncRetry();
      renderSettings();
    }
  });

  // clicking the "Sync conflict — review" indicator opens the stashed diff modal
  $('#settingsBody').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.gh-conflict')) {
      $('#conflictModal').hidden = false;
    }
  });

  // dynamic scroll-fade: update edge masks on scroll and resize
  document.addEventListener('scroll', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.nodeType === 1 && (t as HTMLElement).matches?.(FADE_SEL)) updateScrollFade(t as HTMLElement);
  }, { capture: true, passive: true });
  window.addEventListener('resize', refreshScrollFades, { passive: true });

  // back to top
  const back = $('#backToTop');
  back.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => { back.hidden = window.scrollY < 400; }, { passive: true });

  // keyboard shortcuts
  const cards = () => [...els.list.querySelectorAll<HTMLElement>('.paper-card')];
  const focusedCard = () => els.list.querySelector<HTMLElement>('.paper-card.is-focused');
  const moveFocus = (delta: number) => {
    const list = cards();
    if (!list.length) return;
    const cur = list.findIndex((c) => c.classList.contains('is-focused'));
    const i = Math.max(0, Math.min(cur < 0 ? (delta > 0 ? 0 : list.length - 1) : cur + delta, list.length - 1));
    list.forEach((c, j) => c.classList.toggle('is-focused', j === i));
    list[i].scrollIntoView({ block: 'nearest' });
  };
  const toggleHelp = () => { const m = $('#helpModal'); m.hidden = !m.hidden; };
  let lastG = 0;
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    // Available even while typing:
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); els.search.focus(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); toggleHelp(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void syncNow(); return; }
    if (e.key === 'Escape') {
      if (promptResolver) { settlePrompt(null); return; }
      if (document.querySelector('.caret-select-btn[aria-expanded="true"]')) { closeAllCarets(); return; }
      if (!popEl.hidden) { closePop(); return; }
      if (document.activeElement === els.search) {
        if (state.query) { state.query = ''; els.search.value = ''; renderSearchHL?.(); writeUrl(); render(); }
        els.search.blur();
      } else { closeModals(); $('#app').classList.remove('sidebar-open', 'rail-open'); }
      return;
    }
    // Single-key shortcuts: only when not typing and unmodified.
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case '/': e.preventDefault(); els.search.focus(); break;
      case '?': toggleHelp(); break;
      case 'f': { const open = els.facetsWrap.classList.toggle('is-open'); $('[data-facets-toggle]').setAttribute('aria-expanded', String(open)); break; }
      case 't': cycleTheme(); break;
      case '[': setSidebarCollapsed(!document.documentElement.classList.contains('is-sidebar-collapsed')); break;
      case ']': setRailCollapsed(!document.documentElement.classList.contains('is-rail-collapsed')); break;
      case 'j': e.preventDefault(); moveFocus(1); break;
      case 'k': e.preventDefault(); moveFocus(-1); break;
      case 'o': focusedCard()?.querySelector<HTMLButtonElement>('[data-card-toggle]')?.click(); break;
      case 's': focusedCard()?.querySelector<HTMLButtonElement>('[data-collect]')?.click(); break;
      case 'G': window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); break;
      case 'g': {
        const now = Date.now();
        if (now - lastG < 500) { window.scrollTo({ top: 0, behavior: 'smooth' }); lastG = 0; } else lastG = now;
        break;
      }
    }
  });
}

// --- TF-IDF similarity ------------------------------------------------
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','of','in','to','is','are','was','were','be','been',
  'for','on','at','by','with','as','from','this','that','these','those','it','its',
  'we','our','their','they','has','have','had','not','no','can','may','will','more',
  'each','which','when','who','than','other','into','also','such','two','three','use',
  'used','using','show','shows','paper','approach','method','model','results','based',
  'proposed','present','new','large','high','low','set','data','can','work','provide',
]);

function tfidfTokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

let _tfidfBuilt = false;
let _idf = new Map<string, number>();

function buildTfidf() {
  if (_tfidfBuilt) return;
  _tfidfBuilt = true;
  const docCount = state.rows.length;
  if (!docCount) return;
  // Count how many documents each term appears in (df)
  const df = new Map<string, number>();
  for (const { p } of state.rows) {
    const focused = `${p.title} ${p.abstract} ${(p.keywords ?? []).join(' ')} ${p.tracks.join(' ')}`;
    const terms = new Set(tfidfTokenize(focused));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // IDF: log(N / df)  (add-1 smoothing to avoid divide-by-zero)
  _idf = new Map([...df.entries()].map(([t, d]) => [t, Math.log((docCount + 1) / (d + 1))]));
  // Build per-paper TF-IDF vectors (sparse, L2-normalised) — cache on paper._vec
  for (const { p } of state.rows) {
    if ((p as Paper & { _vec?: Map<string, number> })._vec) continue;
    const focused = `${p.title} ${p.abstract} ${(p.keywords ?? []).join(' ')} ${p.tracks.join(' ')}`;
    const tokens = tfidfTokenize(focused);
    if (!tokens.length) { (p as Paper & { _vec?: Map<string, number> })._vec = new Map(); continue; }
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (c / tokens.length) * (_idf.get(t) ?? 0);
      if (w > 0) { vec.set(t, w); norm += w * w; }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    (p as Paper & { _vec?: Map<string, number> })._vec = vec;
  }
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [t, w] of a) { const bw = b.get(t); if (bw) dot += w * bw; }
  return dot; // both are L2-normalised, so |a|=|b|=1 → cosine = dot product
}

function similarTo(paperKey: string, n = 8): { p: Paper; v: string; score: number }[] {
  buildTfidf();
  const target = state.rows.find((r) => key(r.v, r.p.id) === paperKey);
  if (!target) return [];
  const vec = (target.p as Paper & { _vec?: Map<string, number> })._vec;
  if (!vec || !vec.size) return [];
  return state.rows
    .filter((r) => key(r.v, r.p.id) !== paperKey)
    .map((r) => {
      const rv = (r.p as Paper & { _vec?: Map<string, number> })._vec ?? new Map();
      return { ...r, score: cosine(vec, rv) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .filter((x) => x.score > 0);
}

function recommendFromSaved(n = 12): { p: Paper; v: string; score: number }[] {
  buildTfidf();
  // Papers the user has collected, tagged, or marked reading/done
  const savedKeys = new Set<string>();
  for (const c of state.collections) c.keys.forEach((k) => savedKeys.add(k));
  for (const [k] of state.tags) savedKeys.add(k);
  for (const [k] of state.status) savedKeys.add(k);
  if (!savedKeys.size) return [];
  // Build profile vector: average of saved paper vectors
  const profile = new Map<string, number>();
  let savedCount = 0;
  for (const paperKey of savedKeys) {
    const row = state.rows.find((r) => key(r.v, r.p.id) === paperKey);
    if (!row) continue;
    const vec = (row.p as Paper & { _vec?: Map<string, number> })._vec ?? new Map();
    for (const [t, w] of vec) profile.set(t, (profile.get(t) ?? 0) + w);
    savedCount++;
  }
  if (!savedCount) return [];
  // Normalise profile vector
  for (const [t, w] of profile) profile.set(t, w / savedCount);
  let pnorm = 0;
  for (const w of profile.values()) pnorm += w * w;
  pnorm = Math.sqrt(pnorm) || 1;
  for (const [t, w] of profile) profile.set(t, w / pnorm);
  // Score all non-saved papers
  return state.rows
    .filter((r) => !savedKeys.has(key(r.v, r.p.id)))
    .map((r) => {
      const rv = (r.p as Paper & { _vec?: Map<string, number> })._vec ?? new Map();
      return { ...r, score: cosine(profile, rv) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .filter((x) => x.score > 0);
}

function openSimilarModal(title: string, rows: { p: Paper; v: string; score: number }[]) {
  const modal = document.querySelector<HTMLElement>('#entityModal');
  const titleEl = document.querySelector<HTMLElement>('#entityTitle');
  const bodyEl = document.querySelector<HTMLElement>('#entityBody');
  if (!modal || !titleEl || !bodyEl) return;
  titleEl.textContent = title;
  if (!rows.length) {
    bodyEl.innerHTML = '<p class="rail-empty">Not enough text data to compute similarity.</p>';
  } else {
    bodyEl.innerHTML = `<div class="mini-card-list">${rows.map((r) => miniCardHtml(r.p, r.v)).join('')}</div>`;
  }
  modal.hidden = false;
  requestAnimationFrame(refreshScrollFades);
}

// --- global corpus TF-IDF (separate from the in-view index) -----------
// Uses p._gvec instead of p._vec; built lazily after ensureAllLoaded().
let _globalTfidfBuilt = false;
let _globalIdf = new Map<string, number>();

function allLoadedRows(): { p: Paper; v: string }[] {
  const rows: { p: Paper; v: string }[] = [];
  for (const [vid, papers] of state.loaded) {
    const v = venueById.get(vid);
    if (!v) continue;
    for (const p of papers) rows.push({ p, v: vid });
  }
  return rows;
}

async function ensureAllLoaded(): Promise<void> {
  await ensureLoaded(manifest.map((v) => v.id), { silent: true });
  _globalTfidfBuilt = false; // invalidate when corpus grows
}

function buildGlobalTfidf() {
  if (_globalTfidfBuilt) return;
  _globalTfidfBuilt = true;
  const allRows = allLoadedRows();
  const docCount = allRows.length;
  if (!docCount) return;
  const df = new Map<string, number>();
  for (const { p } of allRows) {
    const focused = `${p.title} ${p.abstract} ${(p.keywords ?? []).join(' ')} ${p.tracks.join(' ')}`;
    const terms = new Set(tfidfTokenize(focused));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  _globalIdf = new Map([...df.entries()].map(([t, d]) => [t, Math.log((docCount + 1) / (d + 1))]));
  for (const { p } of allRows) {
    const pp = p as Paper & { _gvec?: Map<string, number> };
    if (pp._gvec) continue;
    const focused = `${p.title} ${p.abstract} ${(p.keywords ?? []).join(' ')} ${p.tracks.join(' ')}`;
    const tokens = tfidfTokenize(focused);
    if (!tokens.length) { pp._gvec = new Map(); continue; }
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (c / tokens.length) * (_globalIdf.get(t) ?? 0);
      if (w > 0) { vec.set(t, w); norm += w * w; }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    pp._gvec = vec;
  }
}

function similarGlobal(paperKey: string, n = 30): { p: Paper; v: string; score: number }[] {
  buildGlobalTfidf();
  const allRows = allLoadedRows();
  const target = allRows.find((r) => key(r.v, r.p.id) === paperKey);
  if (!target) return [];
  const vec = (target.p as Paper & { _gvec?: Map<string, number> })._gvec;
  if (!vec || !vec.size) return [];
  return allRows
    .filter((r) => key(r.v, r.p.id) !== paperKey)
    .map((r) => ({
      ...r,
      score: cosine(vec, (r.p as Paper & { _gvec?: Map<string, number> })._gvec ?? new Map()),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .filter((x) => x.score > 0);
}

function recommendGlobal(n = 40): { p: Paper; v: string; score: number }[] {
  buildGlobalTfidf();
  const savedKeys = new Set<string>();
  for (const c of state.collections) c.keys.forEach((k2) => savedKeys.add(k2));
  for (const [k2] of state.tags) savedKeys.add(k2);
  for (const [k2] of state.status) savedKeys.add(k2);
  for (const [k2] of state.notes) savedKeys.add(k2);
  if (!savedKeys.size) return [];
  const allRows = allLoadedRows();
  const profile = new Map<string, number>();
  let savedCount = 0;
  for (const paperKey of savedKeys) {
    const row = allRows.find((r) => key(r.v, r.p.id) === paperKey);
    if (!row) continue;
    const vec = (row.p as Paper & { _gvec?: Map<string, number> })._gvec ?? new Map();
    for (const [t, w] of vec) profile.set(t, (profile.get(t) ?? 0) + w);
    savedCount++;
  }
  if (!savedCount) return [];
  for (const [t, w] of profile) profile.set(t, w / savedCount);
  let pnorm = 0;
  for (const w of profile.values()) pnorm += w * w;
  pnorm = Math.sqrt(pnorm) || 1;
  for (const [t, w] of profile) profile.set(t, w / pnorm);
  return allRows
    .filter((r) => !savedKeys.has(key(r.v, r.p.id)))
    .map((r) => ({
      ...r,
      score: cosine(profile, (r.p as Paper & { _gvec?: Map<string, number> })._gvec ?? new Map()),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .filter((x) => x.score > 0);
}

// --- global recommend modal (categorised by venue, with filter + sort) ----
const recPanelState = {
  rows: [] as { p: Paper; v: string; score: number }[],
  venueFilter: '',          // series name or '' = all
  sort: 'sim' as 'sim' | 'year' | 'title',
  selected: new Set<string>(), // keys of checked mini-cards
};

function renderRecPanel(bodyEl: HTMLElement) {
  const rows = recPanelState.rows;
  const allSeries = [...new Set(rows.map((r) => venueById.get(r.v)?.series ?? r.v))].sort();
  let filtered = recPanelState.venueFilter
    ? rows.filter((r) => (venueById.get(r.v)?.series ?? r.v) === recPanelState.venueFilter)
    : rows;
  if (recPanelState.sort === 'year') {
    filtered = [...filtered].sort((a, b) => {
      const ya = venueById.get(a.v)?.year ?? 0;
      const yb = venueById.get(b.v)?.year ?? 0;
      return (yb - ya) || b.score - a.score;
    });
  } else if (recPanelState.sort === 'title') {
    filtered = [...filtered].sort((a, b) => a.p.title.localeCompare(b.p.title));
  }
  // Group by venue series (maintain sort order within each group)
  const groups = new Map<string, { p: Paper; v: string; score: number }[]>();
  for (const row of filtered) {
    const series = venueById.get(row.v)?.series ?? row.v;
    if (!groups.has(series)) groups.set(series, []);
    groups.get(series)!.push(row);
  }
  const venueChips = ['', ...allSeries].map((s) =>
    `<button class="rec-venue-chip${recPanelState.venueFilter === s ? ' is-active' : ''}" data-rec-venue="${esc(s)}" type="button">${esc(s || 'All')}</button>`
  ).join('');
  const SORT_LABELS: Record<string, string> = { sim: 'Similarity', year: 'Year', title: 'Title' };
  const sortBtns = (['sim', 'year', 'title'] as const).map((s) =>
    `<button class="rec-sort-opt${recPanelState.sort === s ? ' is-active' : ''}" data-rec-sort="${s}" type="button">${SORT_LABELS[s]}</button>`
  ).join('');
  const groupHtml = [...groups.entries()].map(([series, cards]) =>
    `<div class="rec-venue-group">
      <h3 class="rec-venue-head">${esc(series)} <span class="rec-venue-count">${cards.length}</span></h3>
      <div class="mini-card-list">${cards.map((r) => miniCardHtml(r.p, r.v)).join('')}</div>
    </div>`
  ).join('');
  const selCount = recPanelState.selected.size;
  const filteredKeys = filtered.map((r) => key(r.v, r.p.id));
  const bulkHtml = `<div class="rec-bulk">
    <button class="rec-venue-chip" data-rec-select-all type="button">Select all</button>
    <button class="rec-venue-chip" data-rec-select-none type="button">Select none</button>
    ${selCount > 0 ? `<span class="rec-bulk-count">${selCount} selected</span><button class="rec-bulk-add" data-rec-add-collection data-rec-filter-keys="${esc(filteredKeys.join(','))}" type="button">Add ${selCount} to collection…</button>` : ''}
  </div>`;
  bodyEl.innerHTML = `
    <div class="rec-controls">
      <div class="rec-filter-row">
        <span class="rec-label">Venue</span>
        <div class="rec-venue-chips">${venueChips}</div>
      </div>
      <div class="rec-filter-row">
        <span class="rec-label">Sort</span>
        <div class="rec-sort-opts">${sortBtns}</div>
      </div>
      <div class="rec-filter-row">${bulkHtml}</div>
    </div>
    <div class="rec-results">${groupHtml || '<p class="rail-empty">No papers match the filter.</p>'}</div>`;
  requestAnimationFrame(refreshScrollFades);
}

/** Open #entityModal immediately in a loading state (spinner), before data arrives. */
function openRecommendLoading(title: string) {
  const modal = document.querySelector<HTMLElement>('#entityModal');
  const titleEl = document.querySelector<HTMLElement>('#entityTitle');
  const bodyEl = document.querySelector<HTMLElement>('#entityBody');
  if (!modal || !titleEl || !bodyEl) return;
  titleEl.textContent = title;
  bodyEl.innerHTML = '<div class="rec-loading"><span class="rec-loading-dot"></span><span class="rec-loading-dot"></span><span class="rec-loading-dot"></span></div>';
  modal.hidden = false;
  requestAnimationFrame(refreshScrollFades);
}

/** Populate the already-open #entityModal with recommendation results (with fade-in). */
function populateRecommendModal(title: string, rows: { p: Paper; v: string; score: number }[]) {
  const modal = document.querySelector<HTMLElement>('#entityModal');
  const titleEl = document.querySelector<HTMLElement>('#entityTitle');
  const bodyEl = document.querySelector<HTMLElement>('#entityBody');
  if (!modal || !titleEl || !bodyEl) return;
  // Modal might have been closed while loading; reopen if needed.
  if (modal.hidden) modal.hidden = false;
  titleEl.textContent = title;
  recPanelState.rows = rows;
  recPanelState.venueFilter = '';
  recPanelState.sort = 'sim';
  recPanelState.selected = new Set();
  if (!rows.length) {
    bodyEl.innerHTML = '<p class="rail-empty">No recommendations available. Save or tag some papers first, then try again.</p>';
  } else {
    renderRecPanel(bodyEl);
    bodyEl.querySelector<HTMLElement>('.rec-results')?.classList.add('rec-fade-in');
  }
}

/** Convenience: open + populate synchronously when data is already loaded. */
function openRecommendModal(title: string, rows: { p: Paper; v: string; score: number }[]) {
  openRecommendLoading(title);
  populateRecommendModal(title, rows);
}

// --- init --------------------------------------------------------------
// Fill the footer's "Built … ago" with a relative time computed at view time
// (build-time would freeze it). The exact timestamp stays in the title tooltip.
function relTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const units: [string, number][] = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const s = Math.round(diff / 1000);
  for (const [u, sec] of units) {
    const v = Math.floor(s / sec);
    if (v >= 1) return `${v} ${u}${v > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}
function reflectBuilt() {
  const el = document.querySelector<HTMLElement>('[data-built]');
  const iso = el?.getAttribute('datetime');
  if (!el || !iso) return;
  el.textContent = `Built ${relTime(iso)}`;
  // Tooltip: exact time converted to the viewer's local timezone, with the
  // timezone shown (timeStyle 'long' appends e.g. "GMT+8").
  try {
    el.title = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(iso));
  } catch { /* keep the server-rendered title */ }
}

function init() {
  reflectTheme();
  const savedAccent = localStorage.getItem(K_ACCENT);
  if (savedAccent) applyAccent(savedAccent);
  reflectBuilt();
  observeTopbarHeight();
  const fromUrl = readUrl();
  if (!fromUrl) {
    const stored = readJson<string[]>(K_SELECTED, []);
    const ids = stored.length ? stored : manifest.map((v) => v.id);
    ids.forEach((id) => { if (venueById.has(id)) state.selected.add(id); });
  }
  renderSaved();
  wire();
  handleShareHash();
  handleOAuthCallback();
  // If already logged in: fetch identity if not cached, then pull latest remote state
  const _initToken = localStorage.getItem(K_GH_TOKEN);
  if (_initToken) {
    if (!localStorage.getItem(K_GH_USER)) void fetchGitHubUser(_initToken);
    lastAutoPullAt = Date.now(); // mark startup pull so focus handler doesn't fire immediately
    void autoSync(); // pull on startup; no-op if already up to date
  }
  reflectSidebar();
  reflectSeriesGroup();
  reflectCollectionFilter();
  reflectTagFilter();
  reflectStatusFilter();
  reflectNotesFilter();
  reflectSort();
  renderSettings();
  ensureLoaded([...state.selected]).then(() => { render(); });
}

init();
