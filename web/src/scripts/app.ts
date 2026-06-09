import type { Paper, Venue, SavedSearch, VenueGroup, Collection } from './types';
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
// Keys bundled by the settings export/import.
const PERSONAL_KEYS = [K_VGROUPS, K_COLLECTIONS, K_TAGS, K_SAVED, K_SELECTED, K_THEME];
const PAGE = 200;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Sanitize free-text the user types for names/tags: strip control chars, collapse
// whitespace, trim, and cap length so it can't break the layout. (Output is also
// HTML-escaped via esc() at render time, so this is about tidiness, not safety.)
const NAME_MAX = 40;
const TAG_MAX = 24;
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
  star: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  starFilled: '<svg class="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  bookmark: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  bookmarkFilled: '<svg class="ic ic--fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  layers: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  settings: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  externalLink: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
  network: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="7" r="2"/><circle cx="12" cy="18" r="2"/><line x1="6.8" y1="6.8" x2="10.4" y2="16.2"/><line x1="17.3" y1="8.4" x2="13.3" y2="16.4"/><line x1="6.9" y1="6.2" x2="17" y2="6.8"/></svg>',
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
  facetCollapsed: new Set<string>(),
  sort: 'venue',
  collection: '',                                       // active collection-filter id ('' = all)
  colSet: null as Set<string> | null,                   // memoized keys of the active collection
  groups: readJson<VenueGroup[]>(K_VGROUPS, []),
  collections: readJson<Collection[]>(K_COLLECTIONS, []),
  tags: new Map<string, string[]>(Object.entries(readJson<Record<string, string[]>>(K_TAGS, {}))),
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
  state.sort = q.get('sort') ?? 'venue';
  state.collection = q.get('col') ?? '';
  (q.get('track') ?? '').split(',').filter(Boolean).forEach((t) => state.tracks.add(t));
  (q.get('event') ?? '').split(',').filter(Boolean).forEach((e) => state.events.add(e));
  return !!v || q.has('q') || q.has('track');
}
function writeUrl() {
  const q = new URLSearchParams();
  if (state.selected.size) q.set('v', [...state.selected].join(','));
  if (state.query) q.set('q', state.query);
  if (state.sort !== 'venue') q.set('sort', state.sort);
  if (state.collection) q.set('col', state.collection);
  if (state.tracks.size) q.set('track', [...state.tracks].join(','));
  if (state.events.size) q.set('event', [...state.events].join(','));
  const qs = q.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  writeJson(K_SELECTED, [...state.selected]);
}

// --- data loading ------------------------------------------------------
const loadingBar = Object.assign(document.createElement('div'), { className: 'loading-bar' });
document.body.appendChild(loadingBar);

async function ensureLoaded(ids: string[]) {
  const todo = ids.filter((id) => !state.loaded.has(id) && venueById.has(id));
  if (!todo.length) { rebuildRows(); return; }
  let done = 0;
  loadingBar.classList.remove('done');
  loadingBar.style.width = '8%';
  await Promise.all(
    todo.map(async (id) => {
      try {
        const res = await fetch(`${BASE}data/${id}.json`);
        state.loaded.set(id, res.ok ? await res.json() : []);
      } catch {
        state.loaded.set(id, []);
      }
      done += 1;
      loadingBar.style.width = `${8 + (done / todo.length) * 92}%`;
    }),
  );
  loadingBar.classList.add('done');
  setTimeout(() => { loadingBar.style.width = '0'; }, 320);
  rebuildRows();
}

function rebuildRows() {
  const rows: { p: Paper; v: string }[] = [];
  for (const v of manifest) {
    if (!state.selected.has(v.id)) continue;
    for (const p of state.loaded.get(v.id) ?? []) rows.push({ p, v: v.id });
  }
  state.rows = rows;
}

// --- filtering & sorting ----------------------------------------------
function matches(row: { p: Paper; v: string }): boolean {
  const { p, v } = row;
  if (state.colSet && !state.colSet.has(key(v, p.id))) return false;
  if (state.venuesFacet.size && !state.venuesFacet.has(v)) return false;
  if (state.tracks.size && !p.tracks.some((t) => state.tracks.has(t))) return false;
  if (state.events.size && !eventList(p).some((e) => state.events.has(e))) return false;
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
  sort: $<HTMLSelectElement>('#sortSelect'),
  collectionFilter: $<HTMLSelectElement>('#collectionFilter'),
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
  const addTagBtn = `<button class="chip-add" data-tag-add type="button" title="Add a tag" aria-label="Add a tag">+ tag</button>`;
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
  const discInner = (p.abstract ? `<p class="disc-text">${esc(p.abstract)}</p>` : '') + metaHtml;
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
    <div class="card-head">
      <button class="venue-badge" data-venue-badge title="Filter to ${esc(venue.name)}">${esc(venue.name)}</button>
      <span class="paper-id">${esc(p.id)}</span>
    </div>
    ${titleHtml}
    <p class="paper-authors">${authors}</p>
    <button class="icon-btn collect-btn${collected ? ' is-on' : ''}" data-collect data-pop-anchor aria-pressed="${collected}" title="${collected ? 'In a collection — edit' : 'Add to a collection'}">${collected ? ICONS.bookmarkFilled : ICONS.bookmark}</button>
    ${disc}
    <div class="chips${tags.length ? ' has-tags' : ''}">${tracks}${extra}${tagChips}${addTagBtn}</div>
    ${p.urls[0] ? `<a class="icon-btn program-link" href="${esc(p.urls[0])}" target="_blank" rel="noreferrer" title="Open program page" aria-label="Open program page">${ICONS.externalLink}</a>` : ''}
  </article>`;
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
  const venueGroup = state.selected.size > 1
    ? group('Venue', venueCount, state.venuesFacet, 'venue', (id) => venueById.get(id)?.name ?? id) : '';
  els.facets.innerHTML =
    group('Track', trackCount, state.tracks, 'track', (x) => x) +
    group('Event type', eventCount, state.events, 'event', (x) => x) +
    venueGroup;
  const activeN = state.tracks.size + state.events.size + state.venuesFacet.size;
  els.facetCount.textContent = String(activeN);
  els.facetCount.hidden = activeN === 0;
}

function renderActiveFilters() {
  const chips: string[] = [];
  const add = (kind: string, val: string, label: string) =>
    chips.push(`<span class="filter-chip">${esc(label)}<button data-remove-filter data-kind="${kind}" data-val="${esc(val)}" aria-label="Remove">×</button></span>`);
  if (state.query) add('query', '', `“${state.query}”`);
  state.tracks.forEach((t) => add('track', t, t));
  state.events.forEach((e) => add('event', e, e));
  state.venuesFacet.forEach((v) => add('venue', v, venueById.get(v)?.name ?? v));
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
  state.shown = PAGE;
  writeUrl();
  render();
}

// --- right rail: insights for the current view ------------------------
// Maps a Top-authors bar key (disambiguated) back to a display name for clicks.
let railAuthorName = new Map<string, string>();
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
  const stat = (n: number, label: string) =>
    `<div class="rail-stat"><span class="rail-stat-n">${n.toLocaleString()}</span><span class="rail-stat-l">${label}</span></div>`;
  const summary = `<div class="rail-stats">
    ${stat(filtered.length, 'papers')}
    ${stat(authorCount.size, 'authors')}
    ${stat(instCount.size, 'institutions')}
  </div>`;
  const netBtn = (mode: string, label: string) =>
    `<button class="rail-net-btn" data-open-network="${mode}" title="${label}" aria-label="${label}">${ICONS.network}</button>`;
  els.railBody.innerHTML =
    summary +
    barChart('Top institutions', instCount, 'inst', 8, { action: netBtn('inst', 'Institution network') }) +
    barChart('Top authors', authorCount, 'author', 8, { label: (k) => railAuthorName.get(k) ?? k, action: netBtn('author', 'Co-author network') }) +
    barChart('Top tracks', trackCount, 'track', 6);
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
  // reflect simple controls
  els.search.value = state.query;
  els.searchClear.hidden = !state.query;
  els.sort.value = state.sort;
  reflectCollectionFilter();

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
  els.summary.textContent = `${filtered.length.toLocaleString()} of ${state.rows.length.toLocaleString()} papers · ${venuesShown} venue${venuesShown === 1 ? '' : 's'}`;

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
  if (!window.confirm(`Delete group “${g.name}”?`)) return;
  state.groups = state.groups.filter((x) => x.id !== id);
  saveGroups();
  renderVenueGroups();
  reflectSeriesGroup();
  renderSettings();
}

// --- collection filter (controls) -------------------------------------
function reflectCollectionFilter() {
  const sel = els.collectionFilter;
  sel.innerHTML = `<option value="">All papers</option>` +
    state.collections.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.keys.length})</option>`).join('');
  sel.value = state.collection;
  sel.hidden = state.collections.length === 0;
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

function paintPop() { if (popRender) popEl.innerHTML = popRender(); }
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
function openPop(anchor: HTMLElement, render: () => string, onPick: (t: HTMLElement) => void) {
  popAnchor = anchor; popRender = render; popOnPick = onPick;
  paintPop();
  positionPop(anchor);
}
function closePop() {
  popEl.hidden = true; popEl.innerHTML = '';
  popAnchor = null; popRender = null; popOnPick = null;
}
popEl.addEventListener('click', (e) => { if (popOnPick) popOnPick(e.target as HTMLElement); });
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

// Brief "pop" feedback when a toggle button is clicked.
function animatePop(el: HTMLElement) {
  el.classList.remove('is-pop');
  void el.offsetWidth; // restart the animation
  el.classList.add('is-pop');
  el.addEventListener('animationend', () => el.classList.remove('is-pop'), { once: true });
}

// Collection picker for a paper key.
function openCollectPop(anchor: HTMLElement, k: string) {
  const render = () => {
    const rows = state.collections.map((c) =>
      `<div class="pop-row" data-col-toggle="${c.id}" role="button"><input type="checkbox" tabindex="-1" ${c.keys.includes(k) ? 'checked' : ''}><span class="pop-row-label">${esc(c.name)}</span><span class="pop-row-n">${c.keys.length}</span></div>`).join('');
    return `<div class="pop-title">Save to collection</div>${rows || '<p class="pop-empty">No collections yet.</p>'}<button class="pop-action" data-col-new type="button">＋ New collection…</button>`;
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
    return `<div class="pop-title">Add “${esc(series)}” to group</div>${rows || '<p class="pop-empty">No groups yet.</p>'}<button class="pop-action" data-group-new type="button">＋ New group…</button>`;
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
function addTag(k: string) {
  askText({ title: 'Add tags', placeholder: 'tag, another tag', max: TAG_MAX * 4, ok: 'Add' }).then((raw) => {
    if (!raw) return;
    const cur = new Set(tagsOf(k));
    raw.split(',').map((s) => cleanInput(s, TAG_MAX)).filter(Boolean).forEach((t) => cur.add(t));
    state.tags.set(k, [...cur]);
    saveTags();
    render();
  });
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

// --- toast -------------------------------------------------------------
let toastTimer = 0;
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
    try { await navigator.clipboard.writeText(toBibtex(rows)); toast(`Copied ${rows.length} BibTeX entries`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'csv') {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'confer-papers.csv' });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Downloaded ${rows.length} rows`);
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
      name: clean, query: state.query, sort: state.sort, collection: state.collection,
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

// --- settings modal: view stored data, export / import ----------------
function renderSettings() {
  const body = document.querySelector<HTMLElement>('#settingsBody');
  if (!body) return;
  const groupsHtml = state.groups.length
    ? state.groups.map((g) =>
        `<div class="set-item" data-set-group="${g.id}">
          <div class="set-item-head">
            <span class="set-item-name">${esc(g.name)}</span>
            <span class="set-item-meta">${venuesOfGroup(g).length} venues</span>
            <button class="set-mini" data-group-rename="${g.id}" type="button">Rename</button>
            <button class="set-mini set-mini-del" data-group-del="${g.id}" type="button">Delete</button>
          </div>
          <div class="set-chips">${g.series.map((s) => `<span class="chip">${esc(s)}<span class="tag-x" data-group-series-del="${g.id}|${esc(s)}" role="button" aria-label="Remove">×</span></span>`).join('') || '<span class="set-empty">no series</span>'}
            <button class="set-add" data-group-series-add="${g.id}" data-pop-anchor type="button" aria-label="Add series" title="Add series">+</button></div>
        </div>`).join('')
    : '<p class="set-empty">No venue groups yet. Use the ＋ button next to a series in the sidebar.</p>';
  const colsHtml = state.collections.length
    ? state.collections.map((c) =>
        `<div class="set-item" data-set-col="${c.id}">
          <div class="set-item-head">
            <span class="set-item-name">${esc(c.name)}</span>
            <span class="set-item-meta">${c.keys.length} papers</span>
            <button class="set-mini" data-col-rename="${c.id}" type="button">Rename</button>
            <button class="set-mini set-mini-del" data-col-del="${c.id}" type="button">Delete</button>
          </div>
        </div>`).join('')
    : '<p class="set-empty">No collections yet. Use the bookmark on a paper to add one.</p>';
  const tags = [...tagCounts().entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tagsHtml = tags.length
    ? `<div class="set-chips">${tags.map(([t, n]) => `<span class="chip">${esc(t)} ${n}<span class="tag-x" data-tag-purge="${esc(t)}" role="button" aria-label="Remove from all">×</span></span>`).join('')}</div>`
    : '<p class="set-empty">No tags yet. Add tags on a paper card.</p>';
  const raw: Record<string, unknown> = {};
  for (const k of PERSONAL_KEYS) { try { const v = localStorage.getItem(k); if (v) raw[k] = JSON.parse(v); } catch { /* skip */ } }

  body.innerHTML = `
    <div class="set-actions">
      <button class="text-btn" data-settings-export type="button">⬇ Export all (JSON)</button>
      <button class="text-btn" data-settings-import type="button">⬆ Import…</button>
    </div>
    <section class="set-section"><h3 class="set-title">Venue groups</h3>${groupsHtml}</section>
    <section class="set-section"><h3 class="set-title">Collections</h3>${colsHtml}</section>
    <section class="set-section"><h3 class="set-title">Tags</h3>${tagsHtml}</section>
    <section class="set-section">
      <h3 class="set-title">Saved searches <span class="set-item-meta">${state.saved.length}</span></h3>
      <button class="text-btn" data-open-saved type="button">Open saved searches</button>
    </section>
    <section class="set-section">
      <h3 class="set-title">Stored data</h3>
      <p class="set-note">Everything below lives only in this browser (localStorage).</p>
      <pre class="set-raw">${esc(JSON.stringify(raw, null, 2))}</pre>
    </section>`;
}
// Picker (popover) to add a series to a group, opened from the "+" in Settings.
function openSeriesAddPop(anchor: HTMLElement, groupId: string) {
  const render = () => {
    const g = state.groups.find((x) => x.id === groupId);
    if (!g) return '';
    const opts = [...new Set(manifest.map((v) => v.series))].sort().filter((s) => !g.series.includes(s));
    const rows = opts.map((s) => `<div class="pop-row" data-series-pick="${esc(s)}" role="button"><span class="pop-row-label">${esc(s)}</span></div>`).join('');
    return `<div class="pop-title">Add series</div>${rows || '<p class="pop-empty">All series added.</p>'}`;
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

function exportSettings() {
  const data = {
    app: 'confer', version: 1, exportedAt: new Date().toISOString(),
    venueGroups: state.groups,
    collections: state.collections,
    paperTags: Object.fromEntries([...state.tags].filter(([, v]) => v.length)),
    savedSearches: state.saved,
    selected: [...state.selected],
    theme: localStorage.getItem(K_THEME) ?? '',
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'confer-settings.json' });
  a.click(); URL.revokeObjectURL(a.href);
  toast('Exported settings');
}
function importSettings(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(String(reader.result));
      if (Array.isArray(d.venueGroups)) { state.groups = d.venueGroups; saveGroups(); }
      if (Array.isArray(d.collections)) { state.collections = d.collections; saveCollections(); }
      if (d.paperTags && typeof d.paperTags === 'object') { state.tags = new Map(Object.entries(d.paperTags as Record<string, string[]>)); saveTags(); }
      if (Array.isArray(d.savedSearches)) { state.saved = d.savedSearches; writeJson(K_SAVED, state.saved); }
      if (typeof d.theme === 'string' && d.theme) { document.documentElement.dataset.theme = d.theme; try { localStorage.setItem(K_THEME, d.theme); } catch { /* ignore */ } reflectTheme(); }
      if (Array.isArray(d.selected)) { state.selected = new Set((d.selected as string[]).filter((id) => venueById.has(id))); }
      reflectSidebar(); renderVenueGroups(); reflectSeriesGroup(); renderSaved(); renderSettings();
      writeUrl();
      ensureLoaded([...state.selected]).then(render);
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
  document.querySelectorAll<HTMLElement>('.modal').forEach((m) => { m.hidden = true; });
  closePop();
  stopNetwork();
}

// --- theme -------------------------------------------------------------
function reflectTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('[data-theme-icon]').forEach((el) => { el.innerHTML = dark ? ICONS.sun : ICONS.moon; });
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(K_THEME, dark ? 'light' : 'dark'); } catch { /* ignore */ }
  reflectTheme();
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
      animatePop(groupBtn);
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

  // search
  let t = 0;
  els.search.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(() => { state.query = els.search.value.trim(); state.shown = PAGE; writeUrl(); render(); }, 130);
  });
  els.searchClear.addEventListener('click', () => { state.query = ''; els.search.value = ''; writeUrl(); render(); els.search.focus(); });
  els.sort.addEventListener('change', () => { state.sort = els.sort.value; writeUrl(); render(); });
  // collection filter — narrows the list to a collection (loads its venues)
  els.collectionFilter.addEventListener('change', () => {
    state.collection = els.collectionFilter.value; state.shown = PAGE;
    const c = state.collection ? collectionById(state.collection) : undefined;
    if (c) {
      const need = [...new Set(c.keys.map((k) => k.split(':')[0]))].filter((id) => venueById.has(id) && !state.selected.has(id));
      need.forEach((id) => state.selected.add(id));
      reflectSidebar();
      ensureLoaded([...state.selected]).then(() => { writeUrl(); render(); });
    } else { writeUrl(); render(); }
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
    else {
      const set = kind === 'track' ? state.tracks : kind === 'event' ? state.events : state.venuesFacet;
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
    const collectBtn = target.closest<HTMLElement>('[data-collect]');
    const tagDel = target.closest<HTMLElement>('[data-tag-del]');
    if (collectBtn) {
      animatePop(collectBtn);
      if (popAnchor === collectBtn && !popEl.hidden) closePop();
      else openCollectPop(collectBtn, k);
    } else if (tagDel) {
      removeTag(k, tagDel.dataset.tagDel ?? '');
    } else if (target.closest('[data-tag-add]')) {
      addTag(k);
    } else if (target.closest('[data-tag]')) {
      setQuery(`tag:"${(target.closest('[data-tag]') as HTMLElement).dataset.tag!}"`);
    } else if (target.closest('[data-venue-badge]')) {
      const v = k.split(':')[0];
      state.venuesFacet.has(v) ? state.venuesFacet.delete(v) : state.venuesFacet.add(v);
      state.shown = PAGE; writeUrl(); render();
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
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
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

  // settings modal: open + delegated actions + import file picker
  const importInput = $<HTMLInputElement>('#importFile');
  $('[data-settings]').addEventListener('click', () => { renderSettings(); $('#settingsModal').hidden = false; });
  importInput.addEventListener('change', () => { const f = importInput.files?.[0]; if (f) importSettings(f); importInput.value = ''; });
  $('#settingsBody').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-settings-export]')) { exportSettings(); return; }
    if (t.closest('[data-settings-import]')) { importInput.click(); return; }
    const gAdd = t.closest<HTMLElement>('[data-group-series-add]');
    if (gAdd) { openSeriesAddPop(gAdd, gAdd.dataset.groupSeriesAdd ?? ''); return; }
    const gRen = t.closest<HTMLElement>('[data-group-rename]');
    if (gRen) { const g = state.groups.find((x) => x.id === gRen.dataset.groupRename); if (g) askText({ title: 'Rename group', value: g.name, max: NAME_MAX, ok: 'Rename' }).then((n) => { const c = cleanInput(n ?? ''); if (c) { g.name = c; saveGroups(); renderVenueGroups(); renderSettings(); } }); return; }
    const gDel = t.closest<HTMLElement>('[data-group-del]');
    if (gDel) { deleteGroup(gDel.dataset.groupDel ?? ''); return; }
    const gsDel = t.closest<HTMLElement>('[data-group-series-del]');
    if (gsDel) { const [id, ...rest] = (gsDel.dataset.groupSeriesDel ?? '').split('|'); const s = rest.join('|'); const g = state.groups.find((x) => x.id === id); if (g) { g.series = g.series.filter((x) => x !== s); saveGroups(); renderVenueGroups(); reflectSeriesGroup(); renderSettings(); } return; }
    const cRen = t.closest<HTMLElement>('[data-col-rename]');
    if (cRen) { const c = collectionById(cRen.dataset.colRename ?? ''); if (c) askText({ title: 'Rename collection', value: c.name, max: NAME_MAX, ok: 'Rename' }).then((n) => { const cl = cleanInput(n ?? ''); if (cl) { c.name = cl; saveCollections(); afterCollectionsChange(); } }); return; }
    const cDel = t.closest<HTMLElement>('[data-col-del]');
    if (cDel) { const c = collectionById(cDel.dataset.colDel ?? ''); if (c && window.confirm(`Delete collection “${c.name}”?`)) { state.collections = state.collections.filter((x) => x.id !== c.id); if (state.collection === c.id) state.collection = ''; saveCollections(); afterCollectionsChange(); render(); } return; }
    const tagPurge = t.closest<HTMLElement>('[data-tag-purge]');
    if (tagPurge) { const tag = tagPurge.dataset.tagPurge ?? ''; for (const [k, tags] of [...state.tags]) { const next = tags.filter((x) => x !== tag); if (next.length) state.tags.set(k, next); else state.tags.delete(k); } saveTags(); renderSettings(); render(); return; }
  });

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
    if (e.key === 'Escape') {
      if (promptResolver) { settlePrompt(null); return; }
      if (!popEl.hidden) { closePop(); return; }
      if (document.activeElement === els.search) {
        if (state.query) { state.query = ''; els.search.value = ''; writeUrl(); render(); }
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
      case 't': toggleTheme(); break;
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
  reflectSidebar();
  reflectSeriesGroup();
  reflectCollectionFilter();
  renderSettings();
  ensureLoaded([...state.selected]).then(render);
}

init();
