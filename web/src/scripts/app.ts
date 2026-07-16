import type { Paper, Venue, SavedSearch, VenueGroup, Collection, SettingsBundle, GitHubUser, SyncMeta } from './types';
import { toBibtex, toCsv, toJson, toMarkdown, toRis, toTable, type ExportRow } from './export';
import { paperKey, eventList, authorAff, instList, authorResolver, normalize } from '../core/text';
import { type Term, FIELD_ALIASES, parseQuery, matchQuery, countOcc, relevanceScore, abstractSnippet } from '../core/query';
import { buildTfidfIndex, type TfidfIndex } from '../core/similar';
import { computeInsights } from '../core/insights';
import { createGistSync, type Bundle, type Schema } from '@superpung/gist-sync';

// --- constants & storage keys ------------------------------------------
const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');
const K_SELECTED = 'confer.selected';
const K_THEME = 'confer.theme';
const K_SAVED = 'confer.savedSearches';
const K_SEARCH_HISTORY = 'confer.searchHistory'; // {q,t?}[] (most recent first, max 15; legacy string[] auto-migrated)
const K_SEARCH_HIST_COUNTS = 'confer.searchHistoryCounts'; // Record<query, resultCount>
const K_SIDEBAR = 'confer.sidebarCollapsed';
const K_RAIL = 'confer.railCollapsed';
const K_VGROUPS = 'confer.venueGroups';      // VenueGroup[] (series-level groups)
const K_COLLECTIONS = 'confer.collections';  // Collection[] (paper collections)
const K_TAGS = 'confer.paperTags';           // Record<paperKey, string[]>
const K_NOTES = 'confer.paperNotes';         // Record<paperKey, string> — private notes
const K_STATUS = 'confer.readStatus';        // Record<paperKey, 'toread'|'reading'|'done'> — omit 'unread'
const K_SORT = 'confer.sort';               // last-used sort — local only, never synced
const K_ACCENT = 'confer.accent';            // accent color key (e.g. "sage")
const K_GH_TOKEN = 'confer.ghToken';         // read by the settings UI; written by the sync engine
const K_GH_USER = 'confer.ghUser';           // cached GitHubUser JSON; written by the sync engine
const K_SYNC_META = 'confer.syncMeta';       // SyncMeta JSON; watched cross-tab
// Keys bundled by the settings export/import and Gist sync.
const CONFIG_KEYS = [K_VGROUPS, K_COLLECTIONS, K_TAGS, K_SAVED, K_NOTES, K_STATUS];
// OAuth broker endpoint (Netlify Function — stateless, stores nothing).
const OAUTH_BROKER = '/.netlify/functions/github-oauth';
// GitHub OAuth App client_id (public; the secret lives only in Netlify env).
// Fill this in after registering the OAuth App at github.com/settings/developers.
const GH_CLIENT_ID = import.meta.env.PUBLIC_GH_CLIENT_ID ?? '';
const REPO_URL = 'https://github.com/superpung/confer';

// --- GitHub Gist sync: powered by @superpung/gist-sync --------------------
// The auth + gist + 3-way-merge engine lives in the shared package; this app
// supplies only domain glue (serialize/apply + a merge schema) and renders the
// sync UI. Storage keys, token lifecycle and conflict detection are its concern.
let syncConflictPending = false;                 // true → paused; ".gh-conflict" pill shown

/** How each syncable field of the SettingsBundle merges across devices.
 *  Field order fixes the content fingerprint, so keep it stable. */
const SYNC_SCHEMA: Schema = {
  venueGroups:   { kind: 'idKeyed', key: 'id',   label: 'Venue group' },
  collections:   { kind: 'idKeyed', key: 'id',   label: 'Collection' },
  paperTags:     { kind: 'listMap' },
  savedSearches: { kind: 'idKeyed', key: 'name', label: 'Saved search' },
  paperNotes:    { kind: 'scalarMap', label: 'Note' },
  readStatus:    { kind: 'scalarMap', label: 'Status' },
};

const gistSync = createGistSync({
  config: {
    clientId: GH_CLIENT_ID,
    brokerPath: OAUTH_BROKER,
    gistFilename: 'confer-config.json',
    appMarker: 'confer',
  },
  schema: SYNC_SCHEMA,
  ports: {
    serialize: () => serializeSettings() as Bundle,
    apply: (b, opts) => applySettingsBundle(b as Partial<SettingsBundle>, opts),
    onToast: (m) => toast(m),
    onUser: () => renderSettings(),
    onStatus: (s) => {
      if (s === 'syncing' || s === 'pending' || s === 'synced') setSyncBtnState(s);
      else renderSettings();                       // 'signed-out' | 'conflict'
    },
    onConflict: (c) => {
      if (!c) { syncConflictPending = false; renderSettings(); return; }
      const body = document.querySelector<HTMLElement>('#conflictBody');
      if (body) body.innerHTML = diffBundles(c.local as SettingsBundle, c.remote as SettingsBundle);
      if (c.auto) { syncConflictPending = true; renderSettings(); }
      else { $('#conflictModal').hidden = false; }
    },
  },
});
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
  pdf: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>',
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
  // copy / clipboard icon
  copy: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  // "type" / title icon (a capital T) — used for the copy-title action
  type: '<svg class="ic ic--sm" viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
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
// searchBlob, eventList, parseAff, authorAff, instList, normKey, authorResolver,
// STOP_WORDS, tfidfTokenize, fieldText → imported from ../core/text
// Term, FIELD_ALIASES, parseQuery, matchQuery → imported from ../core/query
// buildTfidfIndex, TfidfIndex → imported from ../core/similar
// computeInsights → imported from ../core/insights
// --- field-search smart input helpers -----------------------------------
/** Module-level ref assigned during init so render() can call it before the search handler is set up. */
let renderSearchHL: () => void = () => {};

/** Field value index — rebuilt lazily when state.rows changes for autocomplete. */
const fieldValueIndex: Record<string, Set<string>> = {
  track: new Set(), keyword: new Set(), inst: new Set(), session: new Set(), event: new Set(),
  container: new Set(), publisher: new Set(), author: new Set(), title: new Set(), location: new Set(), date: new Set(),
};
/** Per-value paper counts — built alongside fieldValueIndex. */
let authorPaperCount = new Map<string, number>();
let keywordPaperCount = new Map<string, number>();
let trackPaperCount = new Map<string, number>();
let instPaperCount = new Map<string, number>();
let sessionPaperCount = new Map<string, number>();
let eventPaperCount = new Map<string, number>();
let fieldValueIndexBuilt = false;
function ensureFieldValueIndex() {
  if (fieldValueIndexBuilt) return;
  fieldValueIndexBuilt = true;
  // Clear stale values so deselected venues don't leak into suggestions
  for (const s of Object.values(fieldValueIndex)) s.clear();
  authorPaperCount = new Map();
  keywordPaperCount = new Map();
  trackPaperCount = new Map();
  instPaperCount = new Map();
  sessionPaperCount = new Map();
  eventPaperCount = new Map();
  for (const { p } of state.rows) {
    p.tracks.forEach((t) => {
      fieldValueIndex.track.add(t);
      trackPaperCount.set(t, (trackPaperCount.get(t) ?? 0) + 1);
    });
    (p.keywords ?? []).forEach((k) => {
      fieldValueIndex.keyword.add(k);
      keywordPaperCount.set(k, (keywordPaperCount.get(k) ?? 0) + 1);
    });
    instList(p).forEach((i) => {
      fieldValueIndex.inst.add(i);
      instPaperCount.set(i, (instPaperCount.get(i) ?? 0) + 1);
    });
    p.sessionTitles.forEach((s) => {
      fieldValueIndex.session.add(s);
      sessionPaperCount.set(s, (sessionPaperCount.get(s) ?? 0) + 1);
    });
    p.eventType.split(';').map((s) => s.trim()).filter(Boolean).forEach((e) => {
      fieldValueIndex.event.add(e);
      eventPaperCount.set(e, (eventPaperCount.get(e) ?? 0) + 1);
    });
    if (p.container) fieldValueIndex.container.add(p.container);
    if (p.publisher) fieldValueIndex.publisher.add(p.publisher);
    if (p.title) fieldValueIndex.title.add(p.title);
    p.locations.forEach((l) => fieldValueIndex.location.add(l));
    p.dates.forEach((d) => fieldValueIndex.date.add(d));
    p.authors.forEach((a) => {
      fieldValueIndex.author.add(a);
      authorPaperCount.set(a, (authorPaperCount.get(a) ?? 0) + 1);
    });
  }
}
function invalidateFieldValueIndex() { fieldValueIndexBuilt = false; }

/** Canonical field names shown in autocomplete (order = priority). */
const SUGGEST_FIELDS = [
  'author', 'title', 'inst', 'abstract', 'track', 'venue', 'event',
  'session', 'keyword', 'doi', 'url', 'location', 'date', 'pubdate', 'pages',
  'container', 'publisher', 'year', 'id', 'tag', 'has', 'oa', 'in', 'group', 'status', 'note', 'samesession', 'kind', 'category', 'recent', 'series',
];
const OA_STATUS_VALUES = ['gold', 'green', 'bronze', 'hybrid', 'any'];
const SUGGEST_FIELD_SET = new Set(SUGGEST_FIELDS);

/** Return the whitespace-delimited token that ends at `caret`. */
function activeToken(value: string, caret: number): string {
  const before = value.slice(0, caret);
  const m = before.match(/\S+$/);
  return m ? m[0] : '';
}

/** Valid values for the `has:` field, in suggestion priority order. */
const HAS_VALUES = ['pdf', 'oa', 'doi', 'keyword', 'artifact', 'abstract', 'inst', 'note', 'status', 'tag', 'collection', 'session', 'date', 'location', 'track', 'url', 'pages', 'pubdate'];

/**
 * If `token` is a prefix of exactly one canonical field (or equals one),
 * return the completion string (the part to append, including the colon).
 * Also handles `has:<value>` — suggests a valid has-value suffix.
 * Returns null when not a field prefix or token already has a colon.
 */
const STATUS_VALUES = ['toread', 'reading', 'done'];
const SORT_VALUES = ['relevance', 'venue', 'year', 'year-asc', 'date', 'date-asc', 'pubdate', 'pubdate-asc', 'title', 'authors', 'track', 'session', 'location', 'status', 'id', 'random', 'oa'];

function fieldSuggestion(token: string): string | null {
  // Value completion for `has:<prefix>`
  const hasMatch = token.match(/^(-?)has:(.*)$/i);
  if (hasMatch) {
    const prefix = hasMatch[2].toLowerCase();
    if (prefix === '') return null;
    const matches = HAS_VALUES.filter((v) => v.startsWith(prefix));
    if (matches.length === 1 && matches[0] !== prefix) return matches[0].slice(prefix.length);
    return null;
  }
  // Value completion for `status:<prefix>`
  const statusMatch = token.match(/^(-?)status:(.*)$/i);
  if (statusMatch) {
    const prefix = statusMatch[2].toLowerCase();
    if (prefix === '') return null;
    const matches = STATUS_VALUES.filter((v) => v.startsWith(prefix));
    if (matches.length === 1 && matches[0] !== prefix) return matches[0].slice(prefix.length);
    return null;
  }
  // Value completion for `sort:<prefix>`
  const sortMatch = token.match(/^sort:(.*)$/i);
  if (sortMatch) {
    const prefix = sortMatch[1].toLowerCase();
    if (prefix === '') return null;
    const matches = SORT_VALUES.filter((v) => v.startsWith(prefix));
    if (matches.length === 1 && matches[0] !== prefix) return matches[0].slice(prefix.length);
    return null;
  }
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

// fieldText → imported from ../core/text
// matchQuery(row, terms, ctx) → imported from ../core/query

// --- state -------------------------------------------------------------
const CURRENT_YEAR = new Date().getFullYear();
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
  yearFilter: new Set<number>(),
  keywordFilter: new Set<string>(),
  keywordFilterMode: 'any' as 'any' | 'all', // 'any' = OR, 'all' = AND
  pdfOnly: false,
  oaOnly: false,
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

const key = paperKey;

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
  state.pdfOnly = q.has('pdf');
  state.oaOnly = q.has('oa');
  (q.get('vf') ?? '').split(',').filter(Boolean).forEach((id) => state.venuesFacet.add(id));
  (q.get('yr') ?? '').split(',').filter(Boolean).map(Number).filter(Boolean).forEach((y) => state.yearFilter.add(y));
  (q.get('kw') ?? '').split('|').filter(Boolean).forEach((k) => state.keywordFilter.add(k));
  if (q.get('kwm') === 'all') state.keywordFilterMode = 'all';
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
  if (state.pdfOnly) q.set('pdf', '1');
  if (state.oaOnly) q.set('oa', '1');
  if (state.venuesFacet.size) q.set('vf', [...state.venuesFacet].join(','));
  if (state.yearFilter.size) q.set('yr', [...state.yearFilter].join(','));
  if (state.keywordFilter.size) q.set('kw', [...state.keywordFilter].join('|'));
  if (state.keywordFilter.size && state.keywordFilterMode === 'all') q.set('kwm', 'all');
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
  _tfidfIndex = null;
  _similarSetsCache.clear();
  _similarScoreMapsCache.clear();
  _shuffleWeights = null;
  invalidateFieldValueIndex();
}

// --- filtering & sorting ----------------------------------------------

/** Returns true if a similar: term value is a numeric threshold (e.g. "30" or "20.5")
 *  rather than a paper key.  Used to distinguish `sim:30` (threshold) from `similar:venue:id`. */
const isSimThreshold = (val: string) => /^\d+(\.\d+)?$/.test(val);

/** similar: terms whose value is a real paper key (not a numeric threshold). */
const properSimTerms = () => state.terms.filter((t) => t.field === 'similar' && !isSimThreshold(t.value));

function matches(row: { p: Paper; v: string }): boolean {
  const { p, v } = row;
  if (state.colSet && !state.colSet.has(key(v, p.id))) return false;
  if (state.venuesFacet.size && !state.venuesFacet.has(v)) return false;
  if (state.tracks.size && !p.tracks.some((t) => state.tracks.has(t))) return false;
  if (state.events.size && !eventList(p).some((e) => state.events.has(e))) return false;
  if (state.tagFilter.size && !tagsOf(key(v, p.id)).some((t) => state.tagFilter.has(t))) return false;
  if (state.statusFilter && statusOf(key(v, p.id)) !== state.statusFilter) return false;
  if (state.notesOnly && !noteOf(key(v, p.id))) return false;
  if (state.pdfOnly && !paperPdf(p)) return false;
  if (state.oaOnly && !paperOa(p)) return false;
  if (state.yearFilter.size) { const yr = venueById.get(v)?.year; if (!yr || !state.yearFilter.has(yr)) return false; }
  if (state.keywordFilter.size) {
    const kws = p.keywords ?? [];
    const ok = state.keywordFilterMode === 'all'
      ? [...state.keywordFilter].every((k) => kws.includes(k))
      : kws.some((k) => state.keywordFilter.has(k));
    if (!ok) return false;
  }
  // Apply in:collectionName filter — check if paper is in any matching collection.
  const inTerms = state.terms.filter((t) => t.field === 'in');
  if (inTerms.length) {
    const paperCollections = collectionsOf(key(v, p.id)).map((c) => c.name.toLowerCase());
    for (const t of inTerms) {
      const altsIn = t.value.includes('|') ? t.value.split('|').filter(Boolean) : [t.value];
      const ok = altsIn.some((alt) => paperCollections.some((n) => n.includes(alt)));
      if (t.neg ? ok : !ok) return false;
    }
  }
  // Apply group:name filter — check if paper's venue belongs to a matching venue group.
  const groupTerms = state.terms.filter((t) => t.field === 'group');
  if (groupTerms.length) {
    for (const t of groupTerms) {
      const altsGrp = t.value.includes('|') ? t.value.split('|').filter(Boolean) : [t.value];
      const groupVenues = new Set(
        altsGrp.flatMap((alt) => state.groups.filter((g) => g.name.toLowerCase().includes(alt)).flatMap((g) => venuesOfGroup(g)))
      );
      const ok = groupVenues.has(v);
      if (t.neg ? ok : !ok) return false;
    }
  }
  // Apply sameSession: filter — match papers sharing a session with the given paper key.
  const sameSessionTerms = state.terms.filter((t) => t.field === 'samesession');
  if (sameSessionTerms.length) {
    for (const t of sameSessionTerms) {
      const seedKeys = t.value.includes('|') ? t.value.split('|').filter(Boolean) : [t.value];
      const targetSessionIds = new Set<string>();
      for (const sk of seedKeys) {
        const [sv, ...sidParts] = sk.split(':');
        const sid = sidParts.join(':');
        const seedRow = state.rows.find((r) => r.v === sv && r.p.id === sid);
        if (seedRow) seedRow.p.sessions?.forEach((s) => targetSessionIds.add(s));
      }
      const ok = targetSessionIds.size > 0 && (p.sessions ?? []).some((s) => targetSessionIds.has(s));
      if (t.neg ? ok : !ok) return false;
    }
  }
  // Exclude numeric sim: threshold terms, in:, group:, and sameSession: terms before passing to matchQuery.
  const matchTerms = state.terms.filter((t) =>
    !(t.field === 'similar' && isSimThreshold(t.value)) && t.field !== 'in' && t.field !== 'group' && t.field !== 'samesession'
  );
  if (!matchQuery(row, matchTerms, { venueById: (id) => venueById.get(id), tagsOf: (k) => tagsOf(k), statusOf: (k) => statusOf(k), noteOf: (k) => noteOf(k), similarOf: (tk) => getSimilarSet(tk), collectionOf: (k) => collectionsOf(k).length > 0, currentYear: CURRENT_YEAR })) return false;
  // Apply numeric sim: as a min-score threshold (only meaningful when proper similar: seeds exist).
  const simThreshTerms = state.terms.filter((t) => !t.neg && t.field === 'similar' && isSimThreshold(t.value));
  if (simThreshTerms.length) {
    const seeds = properSimTerms().filter((t) => !t.neg);
    if (seeds.length) {
      const threshold = Math.max(...simThreshTerms.map((t) => parseFloat(t.value))) / 100;
      const k2 = paperKey(v, p.id);
      const avgScore = seeds.reduce((sum, t) => sum + (getSimilarScoreMap(t.value).get(k2) ?? 0), 0) / seeds.length;
      if (avgScore < threshold) return false;
    }
  }
  return true;
}
function sortRows(rows: { p: Paper; v: string }[]) {
  const s = state.sort;
  const dateKey = (r: { p: Paper; v: string }) =>
    r.p.publicationDate || (venueById.get(r.v)?.year ? String(venueById.get(r.v)!.year) : '');

  // Build a combined cosine-similarity scorer if any proper similar: seed terms are active.
  const simTerms = properSimTerms().filter((t) => !t.neg);
  const simScore = simTerms.length
    ? (key: string) => {
        let total = 0;
        for (const t of simTerms) total += getSimilarScoreMap(t.value).get(key) ?? 0;
        return total;
      }
    : null;

  if (s === 'random') {
    // Assign a stable random weight to each paper key (reset when rows change).
    if (!_shuffleWeights) _shuffleWeights = new Map();
    return rows.sort((a, b) => {
      const ka = paperKey(a.v, a.p.id), kb = paperKey(b.v, b.p.id);
      if (!_shuffleWeights!.has(ka)) _shuffleWeights!.set(ka, Math.random());
      if (!_shuffleWeights!.has(kb)) _shuffleWeights!.set(kb, Math.random());
      return _shuffleWeights!.get(ka)! - _shuffleWeights!.get(kb)!;
    });
  }
  const sortTitle = (title: string) => title.replace(/^(a|an|the)\s+/i, '').trimStart();
  return rows.sort((a, b) => {
    if (s === 'title') return sortTitle(a.p.title).localeCompare(sortTitle(b.p.title));
    if (s === 'authors') {
      const lastName = (name: string) => { const parts = name.trim().split(/\s+/); return parts[parts.length - 1] ?? name; };
      const la = lastName(a.p.authors[0] ?? ''); const lb = lastName(b.p.authors[0] ?? '');
      const cmp = la.localeCompare(lb); if (cmp !== 0) return cmp;
      return (a.p.authors[0] ?? '').localeCompare(b.p.authors[0] ?? '');
    }
    if (s === 'id') return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    if (s === 'date' || s === 'date-asc') {
      const da = dateKey(a); const db = dateKey(b);
      if (da && db && da !== db) return s === 'date-asc' ? da.localeCompare(db) : db.localeCompare(da);
      if (!da !== !db) return da ? -1 : 1;                    // undated last
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'pubdate' || s === 'pubdate-asc') {
      const pa = a.p.publicationDate ?? ''; const pb = b.p.publicationDate ?? '';
      if (pa && pb && pa !== pb) return s === 'pubdate-asc' ? pa.localeCompare(pb) : pb.localeCompare(pa);
      if (!pa !== !pb) return pa ? -1 : 1;                    // no pubdate last
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'location') {
      const la = a.p.locations[0] ?? '';
      const lb = b.p.locations[0] ?? '';
      if (la !== lb) {
        if (!la) return 1;  // no location → last
        if (!lb) return -1;
        return la.localeCompare(lb);
      }
      // within same location, sort by date ascending then id
      const da = dateKey(a); const db = dateKey(b);
      if (da && db && da !== db) return da.localeCompare(db);
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'year' || s === 'year-asc') {
      const ya = venueById.get(a.v)?.year ?? 0;
      const yb = venueById.get(b.v)?.year ?? 0;
      if (ya !== yb) return s === 'year-asc' ? ya - yb : yb - ya;
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'track') {
      const ta2 = a.p.tracks[0] ?? '';
      const tb2 = b.p.tracks[0] ?? '';
      if (ta2 !== tb2) {
        if (!ta2) return 1;
        if (!tb2) return -1;
        return ta2.localeCompare(tb2);
      }
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'session') {
      const sa = a.p.sessionTitles[0] ?? '';
      const sb = b.p.sessionTitles[0] ?? '';
      if (sa !== sb) return sa.localeCompare(sb);
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'status') {
      const STATUS_RANK: Record<string, number> = { toread: 0, reading: 1, done: 2 };
      const rank = (r: { p: Paper; v: string }) => STATUS_RANK[statusOf(paperKey(r.v, r.p.id)) ?? ''] ?? 99;
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'oa') {
      const OA_RANK: Record<string, number> = { gold: 0, green: 1, bronze: 2, hybrid: 3 };
      const oaRank = (r: { p: Paper }) => {
        const oa = (r.p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean; oa_status?: string } | undefined;
        if (!oa?.is_oa) return 99;
        return OA_RANK[oa.oa_status ?? ''] ?? 4;
      };
      const ra = oaRank(a), rb = oaRank(b);
      if (ra !== rb) return ra - rb;
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    if (s === 'relevance') {
      // When similar: terms are active, sort by cosine similarity (highest first).
      // Fall back to keyword relevance when no similar: terms present.
      if (simScore) {
        const ka = paperKey(a.v, a.p.id), kb = paperKey(b.v, b.p.id);
        const sa2 = simScore(ka), sb2 = simScore(kb);
        if (sa2 !== sb2) return sb2 - sa2;
      } else {
        const sa2 = relevanceScore(a, state.terms);
        const sb2 = relevanceScore(b, state.terms);
        if (sa2 !== sb2) return sb2 - sa2;
      }
      return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
    }
    // venue: group by manifest order; within a venue use similarity / relevance tiebreaker
    if (a.v !== b.v) return manifest.findIndex((m) => m.id === a.v) - manifest.findIndex((m) => m.id === b.v);
    if (simScore) {
      const ka = paperKey(a.v, a.p.id), kb = paperKey(b.v, b.p.id);
      const ra = simScore(ka), rb = simScore(kb);
      if (ra !== rb) return rb - ra;
    } else if (state.terms.length) {
      const ra = relevanceScore(a, state.terms), rb = relevanceScore(b, state.terms);
      if (ra !== rb) return rb - ra;
    }
    return a.p.id.localeCompare(b.p.id, undefined, { numeric: true });
  });
}

// DOI duplicate index: doi → [venueId, ...] — built once per render for duplicate badge.
let doiVenueMap = new Map<string, string[]>();

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
// Current filtered result set — updated each render() so doExport('selectall') can use it.
let lastFiltered: { p: Paper; v: string }[] = [];

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

/** Highlight query terms in `text`, returning safe HTML. Terms must be pre-lowercased. */
function highlightText(text: string, terms: string[]): string {
  if (!terms.length) return esc(text);
  // NFC first: ensures each precomposed char is 1 code unit, keeping indices
  // stable after normalize() strips combining marks (NFD → strip → same length).
  const nfcText = text.normalize('NFC');
  const normText = normalize(nfcText);
  const normTerms = terms.map((t) => normalize(t)).filter(Boolean);
  if (!normTerms.length) return esc(text);
  const pattern = normTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(${pattern})`, 'gi');
  let result = '', last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normText)) !== null) {
    result += esc(nfcText.slice(last, m.index)) + `<mark>${esc(nfcText.slice(m.index, m.index + m[0].length))}</mark>`;
    last = m.index + m[0].length;
  }
  return result + esc(nfcText.slice(last));
}

/** Return the best PDF URL for a paper: explicit pdfUrls, then .pdf in urls, then OA url. */
function paperPdf(p: Paper): string {
  if (p.pdfUrls?.[0]) return p.pdfUrls[0];
  const dotPdf = p.urls.find((u) => u.toLowerCase().endsWith('.pdf'));
  if (dotPdf) return dotPdf;
  const oa = (p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean; oa_url?: string } | undefined;
  return (oa?.is_oa && oa.oa_url) ? oa.oa_url : '';
}

function paperOa(p: Paper): { is_oa: boolean; oa_status: string; oa_url?: string } | null {
  const oa = (p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean; oa_status?: string; oa_url?: string } | undefined;
  return oa?.is_oa ? { is_oa: true, oa_status: oa.oa_status ?? '', oa_url: oa.oa_url } : null;
}

function cardHtml(p: Paper, v: string, simPct?: number): string {
  const venue = venueById.get(v)!;
  const k = key(v, p.id);
  const collected = collectionsOf(k).length > 0;
  const tags = tagsOf(k);
  const note = noteOf(k);
  const status = statusOf(k);
  const sel = state.sel.has(k);
  const hlTerms = state.terms
    .filter((t) => !t.neg && (t.field === 'any' || t.field === 'title' || t.field === 'abstract'))
    .map((t) => t.value);
  const hlAuthorTerms = state.terms
    .filter((t) => !t.neg && (t.field === 'any' || t.field === 'author'))
    .map((t) => t.value);
  const hlInstTerms = state.terms
    .filter((t) => !t.neg && (t.field === 'any' || t.field === 'inst'))
    .map((t) => t.value);
  const authors = p.authors.length
    ? authorAff(p).map(({ author, inst }) =>
        `<span class="author${inst ? ' has-inst' : ''}">` +
          `<button class="link-author" data-author="${esc(author)}" title="Search papers by ${esc(author)}">${highlightText(author, hlAuthorTerms)}</button>` +
          (inst
            ? `<span class="author-pop"><button class="author-inst" data-inst="${esc(inst)}" title="Search papers from ${esc(inst)}">${highlightText(inst, hlInstTerms)}</button></span>`
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
  const oaInfo = paperOa(p);
  const oaHtml = oaInfo
    ? `<a class="meta-link oa-badge oa-badge--${esc(oaInfo.oa_status)}" ${oaInfo.oa_url ? `href="${esc(oaInfo.oa_url)}" target="_blank" rel="noreferrer"` : ''} title="Open Access (${esc(oaInfo.oa_status)})">OA</a>`
    : '';
  const artifactHtml = p.artifactUrls?.[0]
    ? `<a class="meta-link" href="${esc(p.artifactUrls[0])}" target="_blank" rel="noreferrer">Artifact</a>`
    : '';
  const hasMeta = p.dates.length || p.locations.length || p.sessionTitles.length ||
    publicationBits.length || p.container || p.publisher || doiHtml || pdfHtml || oaHtml || artifactHtml;
  const metaHtml = hasMeta ? `<div class="compact-meta">
      <span class="meta-item" title="${esc(joinList(p.dates))}"><strong>Date</strong>${esc(shortList(p.dates))}</span>
      <span class="meta-item" title="${esc(joinList(p.locations))}"><strong>Location</strong>${esc(shortList(p.locations))}</span>
      ${p.sessionTitles.length ? `<span class="meta-item"><strong>Session</strong>${p.sessionTitles.slice(0, 2).map((s) => `<button class="meta-session-btn" data-session="${esc(s)}" title="Filter by session">${esc(s)}</button>`).join(', ')}</span>` : ''}
      ${p.container ? `<span class="meta-item" title="${esc(p.container)}"><strong>Published in</strong>${esc(p.container)}</span>` : ''}
      ${publicationBits.length ? `<span class="meta-item"><strong>Publication</strong>${esc(publicationBits.join(' · '))}</span>` : ''}
      ${p.publisher ? `<span class="meta-item"><strong>Publisher</strong>${esc(p.publisher)}</span>` : ''}
      ${doiHtml || pdfHtml || oaHtml || artifactHtml ? `<span class="meta-item meta-links"><strong>Links</strong>${doiHtml}${pdfHtml}${oaHtml}${artifactHtml}</span>` : ''}
    </div>` : '';
  const noteHtml = note ? `<p class="disc-note"><strong>Note:</strong> ${esc(note)}</p>` : '';
  const kws = p.keywords ?? [];
  const kwVisible = kws.slice(0, 10);
  const kwExtra = kws.length > 10 ? kws.length - 10 : 0;
  const kwHtml = kws.length
    ? `<div class="disc-keywords">${kwVisible.map((kw) => `<button class="chip chip-kw${state.keywordFilter.has(kw) ? ' is-active' : ''}" data-kw="${esc(kw)}" title="${state.keywordFilter.has(kw) ? 'Remove keyword filter' : 'Filter by keyword'}">${esc(kw)}</button>`).join('')}${kwExtra ? `<span class="chip">+${kwExtra} more</span>` : ''}</div>`
    : '';
  const similarBtn = `<button class="icon-btn similar-btn" data-find-similar="${esc(k)}" type="button" title="Find similar papers · Shift+click to filter with similar:" aria-label="Find similar papers">${ICONS.similar}</button>`;
  const copyAbsBtn = p.abstract
    ? `<button class="icon-btn" data-copy-abstract="${esc(k)}" type="button" title="Copy abstract" aria-label="Copy abstract">${ICONS.copy}</button>`
    : '';
  const copyCiteBtn = `<button class="icon-btn" data-copy-cite="${esc(k)}" type="button" title="Copy citation" aria-label="Copy citation">${ICONS.link}</button>`;
  const copyTitleBtn = `<button class="icon-btn" data-copy-title="${esc(k)}" type="button" title="Copy title" aria-label="Copy title">${ICONS.type}</button>`;
  const discInner = noteHtml + (p.abstract ? `<p class="disc-text">${highlightText(p.abstract, hlTerms)}</p>` : '') + kwHtml + metaHtml + (p.abstract || hasMeta || kws.length ? `<div class="disc-actions">${copyTitleBtn}${copyAbsBtn}${copyCiteBtn}${similarBtn}</div>` : '');
  // The title is the toggle: clicking it expands the disclosure, and the whole
  // card animates height via the grid-template-rows 0fr↔1fr trick. Papers with
  // nothing to reveal render a plain (non-interactive) title.
  const discId = `disc-${k.replace(/[^a-z0-9_-]/gi, '-')}`;
  const titleHl = highlightText(p.title, hlTerms);
  const titleHtml = discInner
    ? `<h2 class="paper-title"><button class="title-toggle" type="button" data-card-toggle aria-expanded="false" aria-controls="${discId}">${titleHl}<span class="title-caret" aria-hidden="true">▾</span></button></h2>`
    : `<h2 class="paper-title">${titleHl}</h2>`;
  const disc = discInner
    ? `<div class="paper-disc"><div class="disc-collapse" id="${discId}"><div class="disc-inner">${discInner}</div></div></div>`
    : '';
  return `<article class="paper-card${sel ? ' is-selected' : ''}" data-key="${esc(k)}">
    <span class="card-select"><input type="checkbox" data-sel ${sel ? 'checked' : ''} aria-label="Select"></span>
    <div class="card-top">
      <div class="card-head">
        ${oaInfo ? `<a class="oa-dot oa-dot--${esc(oaInfo.oa_status)}"${oaInfo.oa_url ? ` href="${esc(oaInfo.oa_url)}" target="_blank" rel="noreferrer"` : ''} title="Open Access (${esc(oaInfo.oa_status)})" aria-label="Open Access (${esc(oaInfo.oa_status)})"></a>` : ''}
        <button class="venue-badge" data-venue-badge title="Filter results to ${esc(venue.name)} (click to toggle)">${esc(venue.name)}</button>
        <button class="paper-id" data-copy-key="${esc(k)}" type="button" title="Copy paper key to clipboard">${esc(p.id)}</button>
        ${simPct != null ? `<span class="sim-badge" title="Cosine similarity score">${simPct}%</span>` : ''}
      </div>
      <div class="card-actions">
        <button class="icon-btn status-btn status-btn--${status}" data-status-cycle title="${STATUS_TITLE[status]}" aria-label="${STATUS_TITLE[status]}">${STATUS_ICONS[status]}</button>
        <button class="icon-btn note-btn${note ? ' is-on' : ''}" data-note-edit title="${note ? `Note: ${esc(note)}` : 'Add a note'}" aria-label="Note">${ICONS.pencil}</button>
        <button class="icon-btn collect-btn${collected ? ' is-on' : ''}" data-collect data-pop-anchor aria-pressed="${collected}" title="${collected ? 'In a collection — edit' : 'Add to a collection'}">${collected ? ICONS.bookmarkFilled : ICONS.bookmark}</button>
        <button class="icon-btn copy-btn" data-copy-paper="${esc(k)}" type="button" title="Copy BibTeX" aria-label="Copy BibTeX">${ICONS.copy}</button>
      </div>
    </div>
    ${titleHtml}
    <p class="paper-authors">${authors}</p>
    ${(() => {
      const absTerms = state.terms
        .filter((t) => !t.neg && (t.field === 'any' || t.field === 'abstract'))
        .map((t) => t.value);
      if (!p.abstract || !absTerms.length) return '';
      const snip = abstractSnippet(p.abstract, absTerms);
      if (!snip) return '';
      return `<p class="paper-snippet">${highlightText(snip, absTerms)}</p>`;
    })()}
    ${disc}
    <div class="chips${tags.length ? ' has-tags' : ''}">${tracks}${extra}${tagChips}${addTagBtn}${(() => {
      if (!p.doi) return '';
      const otherVenues = (doiVenueMap.get(p.doi) ?? []).filter((vid) => vid !== v);
      if (!otherVenues.length) return '';
      const names = otherVenues.map((vid) => venueById.get(vid)?.name ?? vid).slice(0, 2).join(', ');
      return `<span class="chip chip-dup" title="Same paper also in ${esc(names)}">Also in: ${esc(names)}</span>`;
    })()}</div>
    ${(() => {
      const pdf = paperPdf(p);
      const prog = p.urls[0] ?? '';
      if (!pdf && !prog) return '';
      const pdfBtn = pdf ? `<a class="icon-btn pdf-btn" data-open-pdf href="${esc(pdf)}" target="_blank" rel="noreferrer" title="Open PDF in a new tab" aria-label="Open PDF">${ICONS.pdf}</a>` : '';
      const progLink = prog ? `<a class="icon-btn program-link" href="${esc(prog)}" target="_blank" rel="noreferrer" title="Open program page" aria-label="Open program page">${ICONS.externalLink}</a>` : '';
      return `<div class="card-corner">${pdfBtn}${progLink}</div>`;
    })()}
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
  const yearCount = new Map<number, number>();
  const kwCount = new Map<string, number>();
  for (const { p, v } of base) {
    for (const t of new Set(p.tracks)) trackCount.set(t, (trackCount.get(t) ?? 0) + 1);
    for (const e of new Set(eventList(p))) eventCount.set(e, (eventCount.get(e) ?? 0) + 1);
    venueCount.set(v, (venueCount.get(v) ?? 0) + 1);
    const yr = venueById.get(v)?.year;
    if (yr) yearCount.set(yr, (yearCount.get(yr) ?? 0) + 1);
    for (const kw of new Set(p.keywords ?? [])) kwCount.set(kw, (kwCount.get(kw) ?? 0) + 1);
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
  const yearGroupHtml = (() => {
    if (yearCount.size < 2) return '';
    const title = 'Year';
    const collapsed = state.facetCollapsed.has(title);
    const opts = [...yearCount.entries()].sort((a, b) => b[0] - a[0]);
    const rows = opts.map(([yr, n]) =>
      `<label class="facet-option"><input type="checkbox" data-facet="year" value="${yr}" ${state.yearFilter.has(yr) ? 'checked' : ''}>
        <span class="facet-label">${yr}</span><span class="facet-count">${n}</span></label>`).join('');
    return `<div class="facet-group${collapsed ? ' is-collapsed' : ''}" data-facet-group="${title}">
      <button class="facet-title" type="button" data-facet-group-toggle aria-expanded="${!collapsed}">
        <span class="facet-caret">▾</span><span class="facet-title-text">${title}</span><span class="facet-group-count">${opts.length}</span>
      </button>
      <div class="facet-collapse"><div class="facet-options">${rows}</div></div>
    </div>`;
  })();
  // Keyword facet: show top 50 by count with inline search; collapsed by default
  const kwGroupHtml = (() => {
    if (kwCount.size < 2) return '';
    const title = 'Keyword';
    const collapsed = state.facetCollapsed.has(title);
    const allOpts = [...kwCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // Always include active keywords (even if outside top 50)
    const topSet = new Set(allOpts.slice(0, 50).map(([kw]) => kw));
    for (const kw of state.keywordFilter) topSet.add(kw);
    const opts = allOpts.filter(([kw]) => topSet.has(kw));
    const rows = opts.map(([kw, n]) =>
      `<label class="facet-option" data-kw-label="${esc(kw.toLowerCase())}"><input type="checkbox" data-facet="keyword" value="${esc(kw)}" ${state.keywordFilter.has(kw) ? 'checked' : ''}>
        <span class="facet-label">${esc(kw)}</span><span class="facet-count">${n}</span></label>`).join('');
    return `<div class="facet-group${collapsed ? ' is-collapsed' : ''}" data-facet-group="${title}">
      <button class="facet-title" type="button" data-facet-group-toggle aria-expanded="${!collapsed}">
        <span class="facet-caret">▾</span><span class="facet-title-text">${title}</span><span class="facet-group-count">${opts.length}${kwCount.size > 50 ? '+' : ''}</span>
      </button>
      <div class="facet-collapse"><div class="facet-options">${rows}</div></div>
    </div>`;
  })();
  els.facets.innerHTML =
    group('Track', trackCount, state.tracks, 'track', (x) => x) +
    group('Event type', eventCount, state.events, 'event', (x) => x) +
    yearGroupHtml +
    kwGroupHtml +
    venueGroup;
  const activeN = state.tracks.size + state.events.size + state.venuesFacet.size + state.yearFilter.size + state.keywordFilter.size;
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
  state.yearFilter.forEach((y) => add('yearfilter', String(y), String(y)));
  state.keywordFilter.forEach((kw) => add('keywordfilter', kw, `kw: ${kw}`));
  if (state.statusFilter) add('statusfilter', state.statusFilter, `status: ${state.statusFilter}`);
  if (state.notesOnly) add('notesonly', '', 'has notes');
  if (state.pdfOnly) add('pdfonly', '', 'has PDF');
  if (state.oaOnly) add('oaonly', '', 'Open Access');
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
  state.yearFilter.clear();
  state.keywordFilter.clear();
  state.keywordFilterMode = 'any';
  state.statusFilter = '';
  state.notesOnly = false;
  state.pdfOnly = false;
  state.oaOnly = false;
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
  opts: { order?: 'count' | 'key'; label?: (k: string) => string; action?: string; activeSet?: Set<string> } = {},
): string {
  const label = opts.label ?? ((k) => k);
  const entries = [...counts.entries()].sort(opts.order === 'key'
    ? (a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })
    : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = entries.slice(0, n);
  if (!top.length) return '';
  const max = Math.max(...top.map(([, c]) => c)) || 1;
  const rows = top.map(([val, c]) => {
    const active = opts.activeSet?.has(val) ?? false;
    return `<button class="bar-row${active ? ' is-active' : ''}" data-chart="${kind}" data-val="${esc(val)}" title="${esc(label(val))} — ${c}${active ? ' (active filter)' : ''}">
      <span class="bar-top"><span class="bar-label">${esc(label(val))}</span><span class="bar-count">${c}</span></span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, Math.round((c / max) * 100))}%"></span></span>
    </button>`;
  }).join('');
  return `<section class="rail-section">
    <div class="rail-section-head"><h3 class="rail-section-title">${title}</h3>${opts.action ?? ''}</div>
    <div class="bar-list">${rows}</div></section>`;
}

function renderRail(filtered: { p: Paper; v: string }[]) {
  if (!filtered.length) {
    els.railBody.innerHTML = `<p class="rail-empty">No papers in view.</p>`;
    return;
  }
  const { instCount, authorCount, trackCount, authorNames } = computeInsights(filtered);
  railAuthorName = authorNames;
  const kwCount = new Map<string, number>();
  const yearCount = new Map<string, number>();
  const oaStatusCount = new Map<string, number>();
  const tagCountRail = new Map<string, number>();
  for (const { p, v } of filtered) {
    for (const kw of new Set(p.keywords ?? [])) kwCount.set(kw, (kwCount.get(kw) ?? 0) + 1);
    const yr = venueById.get(v)?.year;
    if (yr) yearCount.set(String(yr), (yearCount.get(String(yr)) ?? 0) + 1);
    const oaData = (p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean; oa_status?: string } | undefined;
    if (oaData?.is_oa && oaData.oa_status) oaStatusCount.set(oaData.oa_status, (oaStatusCount.get(oaData.oa_status) ?? 0) + 1);
    const k2 = key(v, p.id);
    for (const t of tagsOf(k2)) tagCountRail.set(t, (tagCountRail.get(t) ?? 0) + 1);
  }
  const toreadN = filtered.filter((r) => statusOf(key(r.v, r.p.id)) === 'toread').length;
  const readingN = filtered.filter((r) => statusOf(key(r.v, r.p.id)) === 'reading').length;
  const doneN = filtered.filter((r) => statusOf(key(r.v, r.p.id)) === 'done').length;
  const artifactN = filtered.filter((r) => (r.p.artifactUrls?.length ?? 0) > 0).length;
  const notedN = filtered.filter((r) => !!noteOf(key(r.v, r.p.id))).length;
  const taggedN = filtered.filter((r) => tagsOf(key(r.v, r.p.id)).length > 0).length;
  const stat = (n: number, label: string, cls = '') =>
    `<div class="rail-stat${cls ? ` ${cls}` : ''}"><span class="rail-stat-n">${n.toLocaleString()}</span><span class="rail-stat-l">${label}</span></div>`;
  const trackedN = toreadN + readingN + doneN;
  const progressHtml = trackedN > 0
    ? `<div class="rail-progress" title="${doneN} done / ${trackedN} tracked"><div class="rail-progress-track"><div class="rail-progress-fill" style="width:${Math.round((doneN / trackedN) * 100)}%"></div></div><span class="rail-progress-label">${doneN}/${trackedN} done</span></div>`
    : '';
  const summary = `<div class="rail-stats">
    ${stat(filtered.length, plural(filtered.length, 'paper'))}
    ${stat(authorCount.size, plural(authorCount.size, 'author'))}
    ${stat(instCount.size, plural(instCount.size, 'institution'))}
    ${artifactN > 0 ? stat(artifactN, 'with artifact') : ''}
    ${notedN > 0 ? stat(notedN, 'with notes') : ''}
    ${taggedN > 0 ? stat(taggedN, 'tagged') : ''}
    ${toreadN ? stat(toreadN, 'to read', 'rail-stat--toread') : ''}
    ${readingN ? stat(readingN, 'reading', 'rail-stat--reading') : ''}
    ${doneN ? stat(doneN, 'done', 'rail-stat--done') : ''}
  </div>${progressHtml}`;
  const netBtn = (mode: string, label: string) =>
    `<button class="rail-net-btn" data-open-network="${mode}" title="${label}" aria-label="${label}">${ICONS.network}</button>`;
  railTrend = computeTrend(filtered);
  const trendBtn = railTrend
    ? `<button class="rail-net-btn" data-open-trend title="Topic trends" aria-label="Topic trends">${ICONS.expand}</button>`
    : '';
  const yearActiveSet = new Set([...state.yearFilter].map(String));
  els.railBody.innerHTML =
    summary +
    (yearCount.size > 1 ? barChart('By year', yearCount, 'year', 12, { order: 'key', activeSet: yearActiveSet }) : '') +
    barChart('Top institutions', instCount, 'inst', 8, { action: netBtn('inst', 'Institution network') }) +
    barChart('Top authors', authorCount, 'author', 8, { label: (k) => railAuthorName.get(k) ?? k, action: netBtn('author', 'Co-author network') }) +
    barChart('Top tracks', trackCount, 'track', 6, { action: trendBtn, activeSet: state.tracks }) +
    (oaStatusCount.size > 1 ? barChart('Open Access types', oaStatusCount, 'oa', 5, {
      activeSet: new Set(state.terms.filter((t) => t.field === 'oa' && !t.neg).map((t) => t.value)),
    }) : '') +
    barChart('Top keywords', kwCount, 'keyword', 8, {
      activeSet: state.keywordFilter,
      action: state.keywordFilter.size > 1
        ? `<button class="rail-net-btn${state.keywordFilterMode === 'all' ? ' is-on' : ''}" data-kw-mode title="${state.keywordFilterMode === 'all' ? 'Mode: ALL (click for ANY)' : 'Mode: ANY (click for ALL)'}">${state.keywordFilterMode === 'all' ? 'ALL' : 'ANY'}</button>`
        : '',
    }) +
    (tagCountRail.size > 0 ? barChart('Tags', tagCountRail, 'tag', 8, { activeSet: state.tagFilter }) : '');
}

// --- rail: related papers section (updated on card expand) ---
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
      <button class="mini-card-title-btn" data-mini-nav="${esc(k)}" type="button" title="${esc(p.title)} — click to go to paper">${esc(p.title)}</button>
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
  const allTerms = parseQuery(state.query);
  // Intercept sort: directives in the query and apply them as state changes
  const VALID_SORTS = new Set(['venue', 'year', 'year-asc', 'date', 'date-asc', 'pubdate', 'pubdate-asc', 'id', 'title', 'authors', 'track', 'session', 'location', 'status', 'relevance', 'random', 'oa']);
  const sortTerm = allTerms.find((t) => t.field === 'sort' && VALID_SORTS.has(t.value));
  if (sortTerm && state.sort !== sortTerm.value) {
    state.sort = sortTerm.value;
    try { localStorage.setItem(K_SORT, state.sort); } catch { /* ignore */ }
  }
  state.terms = allTerms.filter((t) => t.field !== 'sort');
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
  reflectPdfFilter();
  reflectOaFilter();

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

  // Build DOI duplicate index for the current row set
  doiVenueMap = new Map();
  for (const { p, v } of state.rows) {
    if (!p.doi) continue;
    const existing = doiVenueMap.get(p.doi) ?? [];
    if (!existing.includes(v)) existing.push(v);
    doiVenueMap.set(p.doi, existing);
  }

  const facetBase = state.rows.filter((r) => {
    if (state.colSet && !state.colSet.has(key(r.v, r.p.id))) return false;
    if (!matchQuery(r, state.terms, { venueById: (id) => venueById.get(id), tagsOf: (k) => tagsOf(k), statusOf: (k) => statusOf(k), noteOf: (k) => noteOf(k), currentYear: CURRENT_YEAR })) return false;
    return true;
  });
  renderFacets(facetBase);

  const filtered = sortRows(state.rows.filter(matches));
  lastFiltered = filtered;
  // Update result count for current query in history metadata
  const trimmedQ = state.query.trim();
  if (trimmedQ) {
    try {
      const counts = JSON.parse(localStorage.getItem(K_SEARCH_HIST_COUNTS) ?? '{}') as Record<string, number>;
      counts[trimmedQ] = filtered.length;
      localStorage.setItem(K_SEARCH_HIST_COUNTS, JSON.stringify(counts));
    } catch { /* ignore */ }
  }
  renderRail(filtered);
  const slice = filtered.slice(0, state.shown);
  const emptyHint = (() => {
    if (!state.rows.length) return 'No papers loaded. Select a venue to begin.';
    // Diagnose which layer caused the zero-result
    const hasActiveFilters = state.tracks.size || state.events.size || state.venuesFacet.size ||
      state.yearFilter.size || state.keywordFilter.size || state.tagFilter.size ||
      state.statusFilter || state.notesOnly || state.pdfOnly || state.oaOnly;
    const hasQuery = state.query.trim().length > 0;
    if (!hasQuery && hasActiveFilters) {
      const hints: string[] = [];
      if (state.keywordFilter.size) hints.push('keyword filter');
      if (state.yearFilter.size) hints.push(`year filter (${[...state.yearFilter].join(', ')})`);
      if (state.tracks.size) hints.push('track filter');
      if (state.pdfOnly) hints.push('PDF-only filter');
      if (state.oaOnly) hints.push('Open Access filter');
      if (state.statusFilter) hints.push(`status filter (${state.statusFilter})`);
      return `No papers match the active filters. Try removing the ${hints.join(' or ')}.`;
    }
    if (hasQuery && !hasActiveFilters) {
      // Detect similar: with an unknown key
      const simTerms = state.terms.filter((t) => !t.neg && t.field === 'similar');
      if (simTerms.length) {
        const unknownKeys = simTerms
          .flatMap((t) => t.value.split('|').filter(Boolean))
          .filter((k) => !state.rows.some((r) => paperKey(r.v, r.p.id) === k));
        if (unknownKeys.length) {
          return `Paper key${unknownKeys.length > 1 ? 's' : ''} not found: <code>${esc(unknownKeys.join(', '))}</code>. Shift+click ⊙ on a card to fill <code>similar:</code> automatically.`;
        }
      }
      const hasField = state.terms.some((t) => t.field !== 'any');
      if (hasField) return `No results for <code>${esc(state.query.trim())}</code>. Try removing a field prefix or use broader terms.`;
      return `No results for <em>"${esc(state.query.trim())}"</em>. Try fewer words, or add <code>author:</code>/<code>title:</code> prefixes.`;
    }
    if (hasQuery && hasActiveFilters) {
      // Check if query alone yields results (fast path: run matchQuery without other filters)
      const queryOnlyMatch = (r: { p: Paper; v: string }) =>
        matchQuery(r, state.terms, { venueById: (id) => venueById.get(id), tagsOf: (k) => tagsOf(k), statusOf: (k) => statusOf(k), noteOf: (k) => noteOf(k), similarOf: (tk) => getSimilarSet(tk), currentYear: CURRENT_YEAR });
      const queryHits = state.rows.filter(queryOnlyMatch).length;
      if (queryHits > 0) return `Your search found ${queryHits} ${plural(queryHits, 'paper')} but the active filters exclude them all. Try removing some filters.`;
      return `No results for <em>"${esc(state.query.trim())}"</em> even without filters. Try different terms.`;
    }
    return 'Try removing some filters.';
  })();
  // Pre-compute combined sim score function if similar: terms are active (used for card badge + sort).
  const activeSimTerms = properSimTerms().filter((t) => !t.neg);
  const getSimPct = activeSimTerms.length
    ? (r: { p: Paper; v: string }) => {
        const k2 = paperKey(r.v, r.p.id);
        let total = 0;
        for (const t of activeSimTerms) total += getSimilarScoreMap(t.value).get(k2) ?? 0;
        // Average across seeds, display as integer percentage
        return Math.round((total / activeSimTerms.length) * 100);
      }
    : null;

  els.list.innerHTML = slice.length
    ? (() => {
      if (state.sort === 'session') {
        const parts: string[] = [];
        let lastSession = '';
        for (const r of slice) {
          const sess = r.p.sessionTitles[0] ?? '';
          if (sess !== lastSession) {
            lastSession = sess;
            if (sess) parts.push(`<div class="session-divider"><button class="session-divider-label" data-session="${esc(sess)}" type="button" title="Filter by this session">${esc(sess)}</button></div>`);
          }
          const simPct = getSimPct ? getSimPct(r) : undefined;
          parts.push(cardHtml(r.p, r.v, simPct));
        }
        return parts.join('');
      }
      if (state.sort === 'location') {
        const parts: string[] = [];
        let lastLoc = '';
        for (const r of slice) {
          const loc = r.p.locations[0] ?? '';
          if (loc !== lastLoc) {
            lastLoc = loc;
            if (loc) parts.push(`<div class="session-divider"><button class="session-divider-label" data-location-filter="${esc(loc)}" type="button" title="Filter by room: ${esc(loc)}">${esc(loc)}</button></div>`);
            else parts.push(`<div class="session-divider"><span class="session-divider-label">No location</span></div>`);
          }
          const simPct = getSimPct ? getSimPct(r) : undefined;
          parts.push(cardHtml(r.p, r.v, simPct));
        }
        return parts.join('');
      }
      if (state.sort === 'date' || state.sort === 'date-asc') {
        const parts: string[] = [];
        let lastDate = '';
        for (const r of slice) {
          const dt = r.p.dates[0] ?? r.p.publicationDate ?? '';
          const dateLabel = dt ? dt : '';
          if (dateLabel !== lastDate) {
            lastDate = dateLabel;
            if (dateLabel) parts.push(`<div class="session-divider"><button class="session-divider-label" data-date-filter="${esc(dateLabel)}" type="button" title="Filter to ${esc(dateLabel)}">${esc(dateLabel)}</button></div>`);
          }
          const simPct = getSimPct ? getSimPct(r) : undefined;
          parts.push(cardHtml(r.p, r.v, simPct));
        }
        return parts.join('');
      }
      if (state.sort === 'pubdate' || state.sort === 'pubdate-asc') {
        const multiPubdate = new Set(slice.map((r) => r.p.publicationDate ?? '')).size > 1;
        if (multiPubdate) {
          const parts: string[] = [];
          let lastPubdate = '';
          for (const r of slice) {
            const pd = r.p.publicationDate ?? '';
            if (pd !== lastPubdate) {
              lastPubdate = pd;
              if (pd) parts.push(`<div class="session-divider"><button class="session-divider-label" data-pubdate-filter="${esc(pd)}" type="button" title="Filter to pubdate: ${esc(pd)}">${esc(pd)}</button></div>`);
              else parts.push(`<div class="session-divider"><span class="session-divider-label">No pub date</span></div>`);
            }
            parts.push(cardHtml(r.p, r.v, getSimPct ? getSimPct(r) : undefined));
          }
          return parts.join('');
        }
      }
      if (state.sort === 'status') {
        const STATUS_LABEL: Record<string, string> = { toread: 'To read', reading: 'Reading', done: 'Done' };
        const STATUS_KEY: Record<string, string> = { 'To read': 'toread', 'Reading': 'reading', 'Done': 'done' };
        const parts: string[] = [];
        let lastSt = '';
        for (const r of slice) {
          const st = statusOf(paperKey(r.v, r.p.id)) ?? '';
          const label = STATUS_LABEL[st] ?? 'Unread';
          if (label !== lastSt) {
            lastSt = label;
            const stKey = STATUS_KEY[label];
            const btn = stKey
              ? `<button class="session-divider-label" data-status-filter="${esc(stKey)}" type="button" title="Filter by status: ${esc(label)}">${esc(label)}</button>`
              : `<span class="session-divider-label">${esc(label)}</span>`;
            parts.push(`<div class="session-divider">${btn}</div>`);
          }
          const simPct = getSimPct ? getSimPct(r) : undefined;
          parts.push(cardHtml(r.p, r.v, simPct));
        }
        return parts.join('');
      }
      if (state.sort === 'track') {
        const parts: string[] = [];
        let lastTrack = '';
        for (const r of slice) {
          const tr = r.p.tracks[0] ?? '';
          if (tr !== lastTrack) {
            lastTrack = tr;
            if (tr) { const trActive = state.tracks.has(tr); parts.push(`<div class="session-divider"><button class="session-divider-label${trActive ? ' is-active' : ''}" data-track="${esc(tr)}" type="button" title="${trActive ? 'Remove filter for track:' : 'Filter by track:'} ${esc(tr)}">${esc(tr)}</button></div>`); }
            else parts.push(`<div class="session-divider"><span class="session-divider-label">No track</span></div>`);
          }
          const simPct = getSimPct ? getSimPct(r) : undefined;
          parts.push(cardHtml(r.p, r.v, simPct));
        }
        return parts.join('');
      }
      if (state.sort === 'oa') {
        const OA_LABEL: Record<string, string> = { gold: 'Gold OA', green: 'Green OA', bronze: 'Bronze OA', hybrid: 'Hybrid OA' };
        const OA_KEY: Record<string, string> = { 'Gold OA': 'gold', 'Green OA': 'green', 'Bronze OA': 'bronze', 'Hybrid OA': 'hybrid' };
        const getOaStatus = (r: { p: Paper }) => {
          const oa = (r.p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean; oa_status?: string } | undefined;
          return oa?.is_oa ? (oa.oa_status ?? '') : '';
        };
        const getOaLabel = (r: { p: Paper }) => {
          const st = getOaStatus(r);
          return st ? (OA_LABEL[st] ?? 'Open Access') : 'Closed';
        };
        const parts: string[] = [];
        let lastOa = '';
        for (const r of slice) {
          const oaLabel = getOaLabel(r);
          if (oaLabel !== lastOa) {
            lastOa = oaLabel;
            const oaKey = OA_KEY[oaLabel];
            const btn = oaKey
              ? `<button class="session-divider-label" data-oa-filter="${esc(oaKey)}" type="button" title="Filter to ${esc(oaLabel)}">${esc(oaLabel)}</button>`
              : `<span class="session-divider-label">${esc(oaLabel)}</span>`;
            parts.push(`<div class="session-divider">${btn}</div>`);
          }
          const simPct = getSimPct ? getSimPct(r) : undefined;
          parts.push(cardHtml(r.p, r.v, simPct));
        }
        return parts.join('');
      }
      if (state.sort === 'title') {
        const parts: string[] = [];
        let lastLetter = '';
        for (const r of slice) {
          const sortT = r.p.title.replace(/^(a|an|the)\s+/i, '').trimStart();
          const letter = sortT[0]?.toUpperCase() ?? '#';
          const bucket = /[A-Z]/.test(letter) ? letter : '#';
          if (bucket !== lastLetter) { lastLetter = bucket; parts.push(`<div class="session-divider"><span class="session-divider-label">${esc(bucket)}</span></div>`); }
          parts.push(cardHtml(r.p, r.v, getSimPct ? getSimPct(r) : undefined));
        }
        return parts.join('');
      }
      if (state.sort === 'authors') {
        const lastName = (name: string) => { const parts2 = name.trim().split(/\s+/); return parts2[parts2.length - 1] ?? name; };
        const parts: string[] = [];
        let lastLetter = '';
        for (const r of slice) {
          const first = r.p.authors[0] ?? '';
          const letter = first ? (lastName(first)[0]?.toUpperCase() ?? '#') : '#';
          const bucket = /[A-Z]/.test(letter) ? letter : '#';
          if (bucket !== lastLetter) { lastLetter = bucket; parts.push(`<div class="session-divider"><span class="session-divider-label">${esc(bucket)}</span></div>`); }
          parts.push(cardHtml(r.p, r.v, getSimPct ? getSimPct(r) : undefined));
        }
        return parts.join('');
      }
      if (state.sort === 'year' || state.sort === 'year-asc') {
        const multiYear = new Set(slice.map((r) => venueById.get(r.v)?.year)).size > 1;
        if (multiYear) {
          const parts: string[] = [];
          let lastYear = 0;
          for (const r of slice) {
            const yr = venueById.get(r.v)?.year ?? 0;
            if (yr !== lastYear) {
              lastYear = yr;
              if (yr) parts.push(`<div class="session-divider"><span class="session-divider-label">${yr}</span></div>`);
            }
            parts.push(cardHtml(r.p, r.v, getSimPct ? getSimPct(r) : undefined));
          }
          return parts.join('');
        }
      }
      if (state.sort === 'venue') {
        const multiVenue = new Set(slice.map((r) => r.v)).size > 1;
        if (multiVenue) {
          const parts: string[] = [];
          let lastVenue = '';
          for (const r of slice) {
            if (r.v !== lastVenue) {
              lastVenue = r.v;
              const vname = venueById.get(r.v)?.name ?? r.v;
              const vActive = state.venuesFacet.has(r.v);
              parts.push(`<div class="session-divider"><button class="session-divider-label${vActive ? ' is-active' : ''}" data-divider-venue="${esc(r.v)}" type="button" title="${vActive ? 'Remove filter for' : 'Filter to'} ${esc(vname)}">${esc(vname)}</button></div>`);
            }
            parts.push(cardHtml(r.p, r.v, getSimPct ? getSimPct(r) : undefined));
          }
          return parts.join('');
        }
      }
      return slice.map((r) => cardHtml(r.p, r.v, getSimPct ? getSimPct(r) : undefined)).join('');
    })()
    : `<div class="empty-state"><h2>No matching papers</h2><p>${emptyHint}</p></div>`;

  {
    const summaryText = `${filtered.length.toLocaleString()} of ${state.rows.length.toLocaleString()} papers`;
    // When similar: is active and sort isn't already relevance, offer a quick-switch button
    const hasSim = properSimTerms().some((t) => !t.neg);
    const wantSortHint = hasSim && state.sort !== 'relevance';
    const isRandom = state.sort === 'random';
    if (wantSortHint) {
      els.summary.innerHTML = `${esc(summaryText)} <button class="sort-hint-btn" data-sort-hint type="button" title="Sort by cosine similarity score">Sort by similarity ↑</button>`;
    } else if (isRandom) {
      els.summary.innerHTML = `${esc(summaryText)} <button class="sort-hint-btn" data-reshuffle type="button" title="Shuffle again">Reshuffle ↺</button>`;
    } else {
      els.summary.textContent = summaryText;
    }
  }
  // Update browser tab title to reflect selected venue(s)
  const venueNames = [...state.selected].slice(0, 2).map((id) => venueById.get(id)?.name ?? id);
  const titlePrefix = venueNames.length ? venueNames.join(', ') + (state.selected.size > 2 ? ` +${state.selected.size - 2}` : '') : null;
  document.title = titlePrefix ? `${titlePrefix} — Confer` : 'Confer';

  if (filtered.length > state.shown) {
    els.more.hidden = false;
    els.more.innerHTML = `<button class="text-btn" id="showMore">Show ${Math.min(PAGE, filtered.length - state.shown)} more (${filtered.length - state.shown} hidden)</button>`;
    // Auto-load when button scrolls into view (infinite scroll)
    const moreBtn = document.getElementById('showMore') as HTMLButtonElement | null;
    if (moreBtn) {
      const obs = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting) { obs.disconnect(); state.shown += PAGE; render(); }
      }, { rootMargin: '300px' });
      obs.observe(moreBtn);
    }
  } else {
    els.more.hidden = true;
  }
  renderActiveFilters();
  updateExportBar();
  // Auto-expand when exactly one paper matches an active search query
  if (filtered.length === 1 && state.terms.length > 0) {
    const singleCard = els.list.querySelector<HTMLElement>('.paper-card');
    if (singleCard) {
      const tog = singleCard.querySelector<HTMLButtonElement>('[data-card-toggle]');
      if (tog && tog.getAttribute('aria-expanded') !== 'true') {
        tog.setAttribute('aria-expanded', 'true');
        singleCard.classList.add('is-open');
      }
    }
  }
  // Handle deep-link hash #paper:<key> — expand and scroll to target card
  if (location.hash.startsWith('#paper:')) {
    const targetKey = location.hash.slice('#paper:'.length);
    const targetCard = els.list.querySelector<HTMLElement>(`.paper-card[data-key="${CSS.escape(targetKey)}"]`);
    if (targetCard) {
      const tog = targetCard.querySelector<HTMLButtonElement>('[data-card-toggle]');
      if (tog && tog.getAttribute('aria-expanded') !== 'true') {
        tog.setAttribute('aria-expanded', 'true');
        targetCard.classList.add('is-open');
      }
      requestAnimationFrame(() => targetCard.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }
}

function updateExportBar() {
  const n = state.sel.size;
  els.exportBar.hidden = n === 0;
  els.selCount.textContent = `${n} selected`;
  const selectAllBtn = document.querySelector<HTMLButtonElement>('#selectAllBtn');
  if (selectAllBtn) {
    const total = lastFiltered.length;
    const allSelected = total > 0 && n >= total;
    selectAllBtn.hidden = allSelected;
    selectAllBtn.textContent = `Select all ${total.toLocaleString()} results`;
  }
  const quickExportBtn = document.querySelector<HTMLButtonElement>('#quickExportBtn');
  if (quickExportBtn) {
    quickExportBtn.hidden = lastFiltered.length === 0 || n > 0;
  }
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
  // Keep the anchor's open-state in sync so its caret (e.g. Tags / Status chips)
  // rotates on open, consistent with the Filters button.
  if (anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'true');
  paintPop();
  positionPop(anchor);
  // (Re)trigger the entrance animation now that the menu is placed.
  popEl.classList.remove('is-in');
  void popEl.offsetWidth;
  popEl.classList.add('is-in');
}
function closePop() {
  if (popAnchor?.hasAttribute('aria-expanded')) popAnchor.setAttribute('aria-expanded', 'false');
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
  const gistId = gistSync.gistId();
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

/** Sync the PDF filter button (visibility + active state + count tooltip). */
function reflectPdfFilter() {
  const btn = document.querySelector<HTMLElement>('#pdfFilterBtn');
  if (!btn) return;
  const pdfRows = state.rows.filter((r) => !!paperPdf(r.p));
  btn.hidden = pdfRows.length === 0;
  btn.classList.toggle('is-active', state.pdfOnly);
  btn.setAttribute('aria-pressed', String(state.pdfOnly));
  btn.title = `Show only papers with PDFs (${pdfRows.length.toLocaleString()} available)`;
}

/** Sync the OA filter button (visibility + active state). */
function reflectOaFilter() {
  const btn = document.querySelector<HTMLElement>('#oaFilterBtn');
  if (!btn) return;
  const oaRows = state.rows.filter((r) => !!paperOa(r.p));
  btn.hidden = oaRows.length === 0;
  btn.classList.toggle('is-active', state.oaOnly);
  btn.setAttribute('aria-pressed', String(state.oaOnly));
  btn.title = `Show only Open Access papers (${oaRows.length.toLocaleString()} available)`;
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
  return source.map((r) => {
    const k = key(r.v, r.p.id);
    const note = noteOf(k) || undefined;
    const rs = statusOf(k);
    const readStatus = rs !== 'unread' ? rs : undefined;
    const paperTags = tagsOf(k).length ? tagsOf(k) : undefined;
    return { paper: r.p, venue: venueById.get(r.v)!, note, readStatus, tags: paperTags };
  });
}
/** Build a descriptive filename prefix for exports (venue id or "confer"). */
function exportStem(): string {
  const ids = [...state.selected];
  if (ids.length === 1) return ids[0];
  if (ids.length <= 3) return ids.join('-');
  return 'confer';
}

async function doExport(format: string) {
  if (format === 'clear') { state.sel.clear(); render(); return; }
  if (format === 'findsimilar') {
    if (!state.sel.size) { toast('Select papers first'); return; }
    const keys2 = [...state.sel].slice(0, 10); // cap at 10 seeds to keep query manageable
    const q = `similar:${keys2.join('|')} sort:relevance`;
    state.sel.clear();
    setQuery(q);
    return;
  }
  if (format === 'selectall') {
    for (const r of lastFiltered) state.sel.add(key(r.v, r.p.id));
    render();
    return;
  }
  const rows = currentExportRows();
  if (!rows.length) { toast('Nothing to export'); return; }
  const stem = exportStem();
  if (format === 'urls') {
    const urlRows = rows.filter((r) => r.paper.urls[0] || r.paper.pdfUrls?.[0] || r.paper.doi);
    if (!urlRows.length) { toast('No URLs in selection'); return; }
    const text = urlRows.map((r) => r.paper.urls[0] || r.paper.pdfUrls?.[0] || `https://doi.org/${r.paper.doi}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${urlRows.length} URL${urlRows.length !== 1 ? 's' : ''}`); }
    catch { toast('Clipboard blocked'); }
    return;
  }
  if (format === 'abstracts') {
    const withAbs = rows.filter((r) => r.paper.abstract?.trim());
    if (!withAbs.length) { toast('No abstracts in selection'); return; }
    const text = withAbs.map((r, i) => {
      const { paper, venue } = r;
      const firstAuthor = paper.authors[0] ? paper.authors[0].split(' ').pop() ?? paper.authors[0] : 'Anon';
      const et = paper.authors.length > 1 ? ' et al.' : '';
      const url = paper.urls[0] || paper.pdfUrls?.[0] || (paper.doi ? `https://doi.org/${paper.doi}` : '');
      const urlLine = url ? `\n${url}` : '';
      return `[${i + 1}] ${firstAuthor}${et} (${venue.year ?? venue.name}). ${paper.title}.${urlLine}\n${paper.abstract}`;
    }).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${withAbs.length} ${plural(withAbs.length, 'abstract')}`); }
    catch { toast('Clipboard blocked'); }
    return;
  }
  if (format === 'notes') {
    const noted = rows.filter((r) => r.note);
    if (!noted.length) { toast('No notes in selection'); return; }
    const text = noted.map((r, i) => {
      const { paper, venue } = r;
      const firstAuthor = paper.authors[0] ? paper.authors[0].split(' ').pop() ?? paper.authors[0] : null;
      const authorStr = firstAuthor ? (paper.authors.length > 1 ? `${firstAuthor} et al.` : firstAuthor) : null;
      const meta = [authorStr, venue.year ? String(venue.year) : null, venue.series || venue.name].filter(Boolean).join(', ');
      const url = paper.urls[0] || paper.pdfUrls?.[0] || (paper.doi ? `https://doi.org/${paper.doi}` : '');
      const urlLine = url ? `\n   ${url}` : '';
      return `${i + 1}. ${paper.title}${meta ? ` (${meta})` : ''}${urlLine}\n   ${r.note}`;
    }).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${noted.length} ${plural(noted.length, 'note')}`); }
    catch { toast('Clipboard blocked'); }
    return;
  }
  if (format === 'titles') {
    const text = rows.map((r, i) => `${i + 1}. ${r.paper.title}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${rows.length} ${plural(rows.length, 'title')}`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'dois') {
    const doiRows = rows.filter((r) => r.paper.doi);
    if (!doiRows.length) { toast('No DOIs in selection'); return; }
    const text = doiRows.map((r) => r.paper.doi!).join('\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${doiRows.length} DOI${doiRows.length !== 1 ? 's' : ''}`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'citations') {
    const text = rows.map((r, i) => {
      const { paper, venue } = r;
      const authors = paper.authors.length === 0 ? 'Unknown'
        : paper.authors.length <= 3 ? paper.authors.join(', ')
        : `${paper.authors.slice(0, 3).join(', ')} et al.`;
      const year = venue.year ? ` (${venue.year})` : '';
      const doi = paper.doi ? `. https://doi.org/${paper.doi}` : paper.urls[0] ? `. ${paper.urls[0]}` : '';
      return `[${i + 1}] ${authors}${year}. "${paper.title}." In ${venue.name}${doi}`;
    }).join('\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${rows.length} ${plural(rows.length, 'citation')}`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'bibtex') {
    try { await navigator.clipboard.writeText(toBibtex(rows)); toast(`Copied ${rows.length} ${plural(rows.length, 'BibTeX entry', 'BibTeX entries')}`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'table') {
    try { await navigator.clipboard.writeText(toTable(rows)); toast(`Copied ${rows.length} ${plural(rows.length, 'paper')} as Markdown table`); }
    catch { toast('Clipboard blocked'); }
  } else if (format === 'csv') {
    // When similar: seeds are active, attach cosine similarity scores as an extra column.
    const activeSeeds = properSimTerms().filter((t) => !t.neg);
    let simScores: Map<string, number> | undefined;
    if (activeSeeds.length) {
      simScores = new Map();
      for (const { paper, venue } of rows) {
        const k = key(venue.id, paper.id);
        let total = 0;
        for (const t of activeSeeds) total += getSimilarScoreMap(t.value).get(k) ?? 0;
        if (total > 0) simScores.set(k, total / activeSeeds.length);
      }
    }
    const blob = new Blob([toCsv(rows, { simScores })], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${stem}-papers.csv` });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Downloaded ${rows.length} ${plural(rows.length, 'row')}`);
  } else if (format === 'markdown') {
    const blob = new Blob([toMarkdown(rows)], { type: 'text/markdown' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${stem}-papers.md` });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Downloaded ${rows.length} ${plural(rows.length, 'paper')} as Markdown`);
  } else if (format === 'json') {
    const blob = new Blob([toJson(rows)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${stem}-papers.json` });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Downloaded ${rows.length} ${plural(rows.length, 'paper')} as JSON`);
  } else if (format === 'ris') {
    const blob = new Blob([toRis(rows)], { type: 'application/x-research-info-systems' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${stem}-papers.ris` });
    a.click(); URL.revokeObjectURL(a.href);
    toast(`Downloaded ${rows.length} ${plural(rows.length, 'paper')} as RIS`);
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
      keywords: [...state.keywordFilter], keywordMode: state.keywordFilterMode,
      yearFilter: [...state.yearFilter], statusFilter: state.statusFilter,
      notesOnly: state.notesOnly || undefined, pdfOnly: state.pdfOnly || undefined, oaOnly: state.oaOnly || undefined,
      tagFilter: [...state.tagFilter],
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
  state.selected = new Set(s.venues); state.venuesFacet.clear();
  state.keywordFilter = new Set(s.keywords ?? []); state.keywordFilterMode = s.keywordMode ?? 'any';
  state.yearFilter = new Set(s.yearFilter ?? []); state.statusFilter = s.statusFilter ?? '';
  state.notesOnly = s.notesOnly ?? false; state.pdfOnly = s.pdfOnly ?? false; state.oaOnly = s.oaOnly ?? false;
  state.tagFilter = new Set(s.tagFilter ?? []);
  state.shown = PAGE;
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
            <button class="set-mini" data-col-similar="${c.id}" type="button" aria-label="Find similar to collection" title="Find papers similar to this collection">${ICONS.similar}</button>
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

  const hasGist = Boolean(gistSync.gistId());

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
function startGitHubLogin() { gistSync.login(); }

/** On startup: exchange a ?code= for a token, then reveal the sync UI. */
async function handleOAuthCallback() {
  const hadCode = new URLSearchParams(location.search).has('code');
  await gistSync.handleOAuthCallback();
  if (hadCode) { renderSettings(); $('#settingsModal').hidden = false; }
}

/** Sign out: confirm first, then let the engine clear all credentials. */
function signOutGitHub() {
  askConfirm({ title: 'Sign out', message: 'Sign out of GitHub? Your local config stays in this browser.', ok: 'Sign out', danger: true }).then((ok) => {
    if (!ok) return;
    gistSync.logout();
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
  const gistId = gistSync.gistId();
  if (!gistId) throw new Error('No gist found');
  const res = await gistSync.api(`https://api.github.com/gists/${gistId}`);
  if (!res.ok) throw new Error('Request failed');
  const data = await res.json() as { history?: HistoryEntry[] };
  return data.history ?? [];
}

/** Fetch a specific revision bundle, caching by SHA. */
async function loadRevision(version: string): Promise<SettingsBundle> {
  if (revisionCache.has(version)) return revisionCache.get(version)!;
  const gistId = gistSync.gistId();
  if (!gistId) throw new Error('No gist found');
  const res = await gistSync.api(`https://api.github.com/gists/${gistId}/${version}`);
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

/** True when local content diverges from the last-synced snapshot. */
function localPending(): boolean { return gistSync.isPending(); }

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

/** Notify the sync engine of a local mutation (debounced push). Called by
 *  writeJson for CONFIG_KEYS. */
function markLocalChange() { gistSync.markLocalChange(); }

/** One-click sync: auto-detect direction, or surface a conflict. */
async function syncNow() { await gistSync.syncNow(); }

/** Silent background sync triggered by focus/visibility or local mutations. */
async function autoSync() { await gistSync.autoSync(); }

/** Close the conflict modal. Unresolved conflicts stay stashed so the
 *  ".gh-conflict" pill can reopen the diff. */
function closeConflictModal() { $('#conflictModal').hidden = true; }

/** Execute the chosen conflict resolution via the engine. */
async function resolveSyncConflict(choice: 'local' | 'cloud' | 'merge') {
  $('#conflictModal').hidden = true;
  await gistSync.resolveConflict(choice);
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
  venue: 'Sort: Venue', year: 'Sort: Year', date: 'Sort: Date', pubdate: 'Sort: Pub Date',
  location: 'Sort: Location', status: 'Sort: Read Status', track: 'Sort: Track',
  id: 'Sort: Paper ID', title: 'Sort: Title', authors: 'Sort: Authors', session: 'Sort: Session',
  relevance: 'Sort: Relevance', random: 'Sort: Random', oa: 'Sort: Open Access',
};
// Sorts that support an ascending/descending direction (via a separate toggle button).
const DIRECTIONAL_SORTS = new Set(['year', 'date', 'pubdate']);
const sortBase = (s: string) => (s.endsWith('-asc') ? s.slice(0, -4) : s);
const sortIsAsc = (s: string) => s.endsWith('-asc');
function reflectSort() {
  const base = sortBase(state.sort);
  const label = document.querySelector<HTMLElement>('#sortSelect .caret-select-label');
  if (label) label.textContent = SORT_LABELS[base] ?? 'Sort: Venue';
  document.querySelectorAll<HTMLElement>('#sortSelect .caret-option').forEach((opt) => {
    opt.classList.toggle('is-on', opt.dataset.sortVal === base);
  });
  // Direction toggle: visible only for directional sorts; arrow reflects current direction.
  const dirBtn = document.querySelector<HTMLElement>('#sortDir');
  if (dirBtn) {
    const directional = DIRECTIONAL_SORTS.has(base);
    dirBtn.hidden = !directional;
    const asc = sortIsAsc(state.sort);
    const arrow = dirBtn.querySelector('.sort-dir-arrow');
    if (arrow) arrow.textContent = asc ? '↑' : '↓';
    dirBtn.setAttribute('title', asc ? 'Ascending (oldest first) — click for descending' : 'Descending (newest first) — click for ascending');
  }
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
/** Best-effort keepalive push on pagehide / tab-hide. */
function flushPendingSync() { gistSync.flushPendingSync(); }

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

  // Search history helpers — stored as {q, t}[] (legacy: string[])
  type HistEntry = { q: string; t?: number };
  const SEARCH_HISTORY_MAX = 15;
  function loadSearchHistory(): HistEntry[] {
    try {
      const raw = JSON.parse(localStorage.getItem(K_SEARCH_HISTORY) ?? '[]') as (string | HistEntry)[];
      return raw.map((item) => typeof item === 'string' ? { q: item } : item);
    }
    catch { return []; }
  }
  function saveSearchHistory(q: string) {
    if (!q.trim()) return;
    const hist = loadSearchHistory().filter((h) => h.q !== q);
    hist.unshift({ q: q.trim(), t: Date.now() });
    try { localStorage.setItem(K_SEARCH_HISTORY, JSON.stringify(hist.slice(0, SEARCH_HISTORY_MAX))); }
    catch { /* ignore */ }
  }
  function relTime(t: number): string {
    const secs = Math.floor((Date.now() - t) / 1000);
    if (secs < 60) return 'now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
  }

  function commitSearchQuery() {
    const q = els.search.value;
    if (q.trim() && q.trim() !== state.query) saveSearchHistory(q.trim());
    state.query = q;
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
    // Debounce so the search only fires once the user pauses typing — otherwise
    // partial words (e.g. "si"→"sim"→"simila") each trigger a search. Slightly
    // longer while a field name/token is being typed.
    const delay = searchSuggestion ? 500 : queryHasFieldToken(els.search.value) ? 450 : 350;
    t = window.setTimeout(commitSearchQuery, delay);
  }

  els.search.addEventListener('compositionstart', () => { isComposing = true; });
  els.search.addEventListener('compositionend', () => { isComposing = false; onSearchInput(); });
  // Smart paste: detect DOI strings, DOI URLs, or #paper:key deep links
  els.search.addEventListener('paste', (e) => {
    const text = (e.clipboardData?.getData('text') ?? '').trim();
    if (els.search.value.trim() !== '') return; // only act on empty box
    // Deep link: URL containing #paper:venue:id → similar:venue:id
    const paperHash = text.match(/#paper:([^\s&?#]+:[^\s&?#]+)/);
    if (paperHash) {
      e.preventDefault();
      const simQuery = `similar:${paperHash[1]}`;
      els.search.value = simQuery;
      renderSearchHL();
      clearTimeout(t);
      t = window.setTimeout(commitSearchQuery, 80);
      toast(`Finding papers similar to: ${paperHash[1]}`);
      return;
    }
    const doiMatch = text.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)/);
    if (doiMatch) {
      e.preventDefault();
      const doiQuery = `doi:${doiMatch[1]}`;
      els.search.value = doiQuery;
      renderSearchHL();
      clearTimeout(t);
      t = window.setTimeout(commitSearchQuery, 80);
      toast(`Searching for DOI: ${doiMatch[1]}`);
    }
  });
  els.search.addEventListener('input', onSearchInput);
  // Keep overlay scroll in sync when the user scrolls a long query
  els.search.addEventListener('scroll', () => { if (searchHlEl) searchHlEl.scrollLeft = els.search.scrollLeft; });
  // Tab key: complete active field suggestion
  // Search history dropdown
  const histDrop = document.createElement('div');
  histDrop.className = 'search-history-drop';
  histDrop.hidden = true;
  els.search.parentElement!.appendChild(histDrop);

  let histDropActive = false; // whether dropdown is visible

  /** Returns {field, prefix} if the current token is a field:prefix, else null. */
  function getFieldValueContext(): { field: string; prefix: string; tokenStart: number } | null {
    const val = els.search.value;
    const caret = els.search.selectionStart ?? val.length;
    const before = val.slice(0, caret);
    const m = before.match(/(?:^|\s)(-?)(\w+):(\S*)$/);
    if (!m) return null;
    const field = FIELD_ALIASES[m[2].toLowerCase()];
    if (!['track', 'keyword', 'inst', 'session', 'event', 'container', 'publisher', 'similar', 'status', 'sort', 'has', 'author', 'year', 'venue', 'tag', 'oa', 'in', 'group', 'title', 'doi', 'location', 'date', 'samesession', 'kind', 'category', 'note', 'recent', 'series'].includes(field)) return null;
    const tokenStart = caret - m[0].trimStart().length;
    return { field, prefix: m[3].toLowerCase(), tokenStart };
  }

  function renderHistDrop() {
    // Field value suggestions take priority over history
    const fvc = getFieldValueContext();
    if (fvc) {
      let values: string[];
      if (fvc.field === 'similar') {
        // Numeric prefix → show threshold hints (sim:10, sim:20, …)
        if (/^\d*$/.test(fvc.prefix)) {
          const thresholds = ['10', '20', '30', '50'];
          const matchedT = fvc.prefix ? thresholds.filter((t) => t.startsWith(fvc.prefix)) : thresholds;
          if (matchedT.length) {
            histDrop.innerHTML = matchedT.map((t, i) =>
              `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(t)}" type="button" tabindex="-1">` +
              `<span class="search-hist-field">sim:</span>${esc(t)}% <span class="search-hist-badge">min similarity threshold</span></button>`
            ).join('');
            histDrop.hidden = false; histDropActive = true; return;
          }
        }
        // Build key→title index once for this lookup
        const rowByKey2 = new Map(state.rows.map((r) => [paperKey(r.v, r.p.id), r.p.title]));
        const seen = new Set<string>();
        const candidates: { key: string; title: string }[] = [];
        const addKey2 = (k: string) => {
          if (seen.has(k)) return; seen.add(k);
          candidates.push({ key: k, title: rowByKey2.get(k) ?? k });
        };
        // Priority: selected → saved (status/tags/collections) → focused card
        for (const k of state.sel) addKey2(k);
        for (const [k] of state.status) addKey2(k);
        for (const [k] of state.tags) addKey2(k);
        for (const c of state.collections) for (const k of c.keys) addKey2(k);
        const focused2 = focusedCard()?.dataset.key;
        if (focused2) addKey2(focused2);
        const matchedSim = candidates.filter(({ key, title }) =>
          !fvc.prefix || key.toLowerCase().includes(fvc.prefix) || title.toLowerCase().includes(fvc.prefix)
        ).slice(0, 8);
        if (!matchedSim.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = matchedSim.map(({ key, title }, i) =>
          `<button class="search-hist-item search-hist-item--sim" data-fv-idx="${i}" data-fv="${esc(key)}" type="button" tabindex="-1">` +
          `<span class="search-hist-field">similar:</span>` +
          `<span class="sim-suggest-key">${esc(key)}</span>` +
          `<span class="sim-suggest-title">${esc(title)}</span>` +
          `</button>`
        ).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'samesession') {
        // Suggest papers that have session IDs (i.e., are in a session)
        const hasSessions = state.rows.filter((r) => r.p.sessions && r.p.sessions.length > 0);
        const rowByKey4 = new Map(hasSessions.map((r) => [paperKey(r.v, r.p.id), r.p.title]));
        const candidates4 = [...rowByKey4.entries()].filter(([k, t]) =>
          !fvc.prefix || k.toLowerCase().includes(fvc.prefix) || t.toLowerCase().includes(fvc.prefix)
        ).slice(0, 8);
        // Prioritise focused card and selected papers
        const focused3 = focusedCard()?.dataset.key;
        if (focused3 && rowByKey4.has(focused3)) {
          const idx = candidates4.findIndex(([k]) => k === focused3);
          if (idx > 0) { const [entry] = candidates4.splice(idx, 1); candidates4.unshift(entry); }
          else if (idx === -1) { candidates4.unshift([focused3, rowByKey4.get(focused3) ?? focused3]); candidates4.splice(8); }
        }
        if (!candidates4.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = candidates4.map(([k, t], i) =>
          `<button class="search-hist-item search-hist-item--sim" data-fv-idx="${i}" data-fv="${esc(k)}" type="button" tabindex="-1">` +
          `<span class="search-hist-field">sameSession:</span>` +
          `<span class="sim-suggest-key">${esc(k)}</span>` +
          `<span class="sim-suggest-title">${esc(t)}</span>` +
          `</button>`
        ).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'tag') {
        const tagCounts = new Map<string, number>();
        for (const tags of state.tags.values()) for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
        const tagMatches = [...tagCounts.entries()]
          .filter(([t]) => t.toLowerCase().includes(fvc.prefix))
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 10);
        if (!tagMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = tagMatches.map(([t, n], i) => {
          const badge = n > 1 ? ` <span class="search-hist-badge">${n}</span>` : '';
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(t)}" type="button" tabindex="-1"><span class="search-hist-field">tag:</span>${esc(t)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'has') {
        const hasCounts = new Map<string, number>();
        for (const { p, v: vid } of state.rows) {
          const k2 = paperKey(vid, p.id);
          const oa = (p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean } | undefined;
          if (p.pdfUrls?.[0] || p.urls.some((u) => u.toLowerCase().endsWith('.pdf'))) hasCounts.set('pdf', (hasCounts.get('pdf') ?? 0) + 1);
          if (oa?.is_oa) hasCounts.set('oa', (hasCounts.get('oa') ?? 0) + 1);
          if (p.doi) hasCounts.set('doi', (hasCounts.get('doi') ?? 0) + 1);
          if (p.keywords?.length) hasCounts.set('keyword', (hasCounts.get('keyword') ?? 0) + 1);
          if (p.artifactUrls?.length) hasCounts.set('artifact', (hasCounts.get('artifact') ?? 0) + 1);
          if (p.abstract?.trim()) hasCounts.set('abstract', (hasCounts.get('abstract') ?? 0) + 1);
          if (p.authorInstitutions?.trim()) hasCounts.set('inst', (hasCounts.get('inst') ?? 0) + 1);
          if (noteOf(k2)) hasCounts.set('note', (hasCounts.get('note') ?? 0) + 1);
          const st = statusOf(k2);
          if (st && st !== 'unread') hasCounts.set('status', (hasCounts.get('status') ?? 0) + 1);
          if (tagsOf(k2).length) hasCounts.set('tag', (hasCounts.get('tag') ?? 0) + 1);
          if (collectionsOf(k2).length) hasCounts.set('collection', (hasCounts.get('collection') ?? 0) + 1);
          if (p.sessionTitles?.length) hasCounts.set('session', (hasCounts.get('session') ?? 0) + 1);
          if (p.dates?.length) hasCounts.set('date', (hasCounts.get('date') ?? 0) + 1);
          if (p.locations?.length) hasCounts.set('location', (hasCounts.get('location') ?? 0) + 1);
          if (p.tracks?.length) hasCounts.set('track', (hasCounts.get('track') ?? 0) + 1);
          if (p.urls.length) hasCounts.set('url', (hasCounts.get('url') ?? 0) + 1);
          if (p.pages?.trim()) hasCounts.set('pages', (hasCounts.get('pages') ?? 0) + 1);
          if (p.publicationDate?.trim()) hasCounts.set('pubdate', (hasCounts.get('pubdate') ?? 0) + 1);
        }
        const hasMatches = HAS_VALUES.filter((v) => v.startsWith(fvc.prefix) || fvc.prefix === '').slice(0, 12);
        histDrop.innerHTML = hasMatches.map((v, i) => {
          const n = hasCounts.get(v) ?? 0;
          const badge = n > 0 ? ` <span class="search-hist-badge">${n}</span>` : '';
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(v)}" type="button" tabindex="-1"><span class="search-hist-field">has:</span>${esc(v)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'author') {
        if (/^[\d><=]/.test(fvc.prefix) || fvc.prefix === '') {
          values = ['1', '2', '>=3', '>=5', '2-4'];
        } else {
          ensureFieldValueIndex();
          // Sort by paper count descending so prolific authors appear first
          values = [...(fieldValueIndex['author'] ?? [])].sort(
            (a, b) => (authorPaperCount.get(b) ?? 0) - (authorPaperCount.get(a) ?? 0)
          );
        }
      } else if (fvc.field === 'venue') {
        // Suggest loaded venue IDs and names
        const venueEntries: string[] = [];
        for (const id of state.selected) {
          const v = venueById.get(id);
          if (v) { venueEntries.push(id); if (v.name !== id) venueEntries.push(v.name); if (v.series) venueEntries.push(v.series); }
        }
        values = [...new Set(venueEntries)];
      } else if (fvc.field === 'year') {
        // Collect available years from loaded rows, sorted newest first
        const availYears = [...new Set(state.rows.map((r) => venueById.get(r.v)?.year).filter((y): y is number => !!y))].sort((a, b) => b - a);
        // Prepend comparison/range hints then actual years
        const yearHints = availYears.length >= 2
          ? [`>=${availYears[0]}`, `${availYears[availYears.length - 1]}-${availYears[0]}`]
          : [];
        values = [...yearHints, ...availYears.map(String)];
      } else if (fvc.field === 'in') {
        const colMatches = state.collections
          .filter((c) => c.name.toLowerCase().includes(fvc.prefix))
          .slice(0, 8);
        if (!colMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = colMatches.map((c, i) => {
          const badge = c.keys.length > 0 ? ` <span class="search-hist-badge">${c.keys.length}</span>` : '';
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(c.name)}" type="button" tabindex="-1"><span class="search-hist-field">in:</span>${esc(c.name)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'group') {
        const groupMatches = state.groups
          .filter((g) => g.name.toLowerCase().includes(fvc.prefix))
          .slice(0, 8);
        if (!groupMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = groupMatches.map((g, i) => {
          const n = venuesOfGroup(g).length;
          const badge = n > 0 ? ` <span class="search-hist-badge">${n} ${plural(n, 'venue')}</span>` : '';
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(g.name)}" type="button" tabindex="-1"><span class="search-hist-field">group:</span>${esc(g.name)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'oa') {
        // OA status values — compute from current rows and expose counts via countMap
        const oaStatusCounts = new Map<string, number>();
        for (const { p } of state.rows) {
          const oaData = (p.extra as Record<string, unknown> | undefined)?.openAccess as { is_oa?: boolean; oa_status?: string } | undefined;
          if (oaData?.is_oa && oaData.oa_status) oaStatusCounts.set(oaData.oa_status, (oaStatusCounts.get(oaData.oa_status) ?? 0) + 1);
        }
        const totalOa = [...oaStatusCounts.values()].reduce((s, n) => s + n, 0);
        if (totalOa > 0) oaStatusCounts.set('any', totalOa);
        values = OA_STATUS_VALUES.filter((v) => oaStatusCounts.has(v));
        const matches2 = values.filter((v) => v.toLowerCase().includes(fvc.prefix)).slice(0, 10);
        if (!matches2.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = matches2.map((v, i) => {
          const n = oaStatusCounts.get(v) ?? 0;
          const badge = n > 0 ? ` <span class="search-hist-badge">${n}</span>` : '';
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(v)}" type="button" tabindex="-1"><span class="search-hist-field">oa:</span>${esc(v)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'kind') {
        // Collect venue kinds from loaded venues
        const kindCounts = new Map<string, number>();
        for (const { v: vid } of state.rows) {
          const vk = venueById.get(vid)?.kind;
          if (vk) kindCounts.set(vk, (kindCounts.get(vk) ?? 0) + 1);
        }
        const kindMatches = [...kindCounts.entries()]
          .filter(([k]) => k.includes(fvc.prefix) || fvc.prefix === '')
          .sort((a, b) => b[1] - a[1]);
        if (!kindMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = kindMatches.map(([k, n], i) => {
          const badge = ` <span class="search-hist-badge">${n}</span>`;
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(k)}" type="button" tabindex="-1"><span class="search-hist-field">kind:</span>${esc(k)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'category') {
        // Collect venue categories from loaded venues
        const catCounts = new Map<string, number>();
        for (const { v: vid } of state.rows) {
          const vc = venueById.get(vid)?.category;
          if (vc) catCounts.set(vc, (catCounts.get(vc) ?? 0) + 1);
        }
        const catMatches = [...catCounts.entries()]
          .filter(([c]) => c.toLowerCase().includes(fvc.prefix) || fvc.prefix === '')
          .sort((a, b) => b[1] - a[1]);
        if (!catMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = catMatches.map(([c, n], i) => {
          const badge = ` <span class="search-hist-badge">${n}</span>`;
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(c)}" type="button" tabindex="-1"><span class="search-hist-field">category:</span>${esc(c)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'note') {
        // Note word-count thresholds for papers with notes
        if (!state.notes.size) { histDrop.hidden = true; histDropActive = false; return; }
        const noteHints = ['>10', '>50', '>100', '<10', '1-50'];
        const filteredNoteHints = noteHints.filter((h) => h.includes(fvc.prefix) || fvc.prefix === '');
        if (!filteredNoteHints.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = filteredNoteHints.map((h, i) => {
          const n = state.rows.filter(({ v: vid, p }) => {
            const noteText = state.notes.get(paperKey(vid, p.id)) ?? '';
            const wc = noteText.trim().split(/\s+/).filter(Boolean).length;
            const cM = h.match(/^(>=|<=|>|<)(\d+)$/);
            const rM = h.match(/^(\d+)-(\d+)$/);
            if (cM) { const v2 = Number(cM[2]); return cM[1] === '>' ? wc > v2 : cM[1] === '<' ? wc < v2 : cM[1] === '>=' ? wc >= v2 : wc <= v2; }
            if (rM) return wc >= Number(rM[1]) && wc <= Number(rM[2]);
            return false;
          }).length;
          const badge = ` <span class="search-hist-badge">${n}</span>`;
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(h)}" type="button" tabindex="-1"><span class="search-hist-field">note:</span>${esc(h)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'recent') {
        // Suggest 1, 2, 3, 5 years back, show paper count for each
        const yearHints = ['1', '2', '3', '5'];
        const filteredYearHints = fvc.prefix ? yearHints.filter((h) => h.startsWith(fvc.prefix)) : yearHints;
        if (!filteredYearHints.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = filteredYearHints.map((h, i) => {
          const cutoff = CURRENT_YEAR - Number(h);
          const n = state.rows.filter(({ v: vid }) => (venueById.get(vid)?.year ?? 0) >= cutoff).length;
          const badge = ` <span class="search-hist-badge">${n}</span>`;
          const desc = Number(h) === 1 ? 'this year' : `last ${h} years`;
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(h)}" type="button" tabindex="-1"><span class="search-hist-field">recent:</span>${esc(h)} <span class="search-hist-badge">${esc(desc)}</span>${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'series') {
        // Collect venue series from loaded rows
        const seriesCounts = new Map<string, number>();
        for (const { v: vid } of state.rows) {
          const ser = venueById.get(vid)?.series;
          if (ser) seriesCounts.set(ser, (seriesCounts.get(ser) ?? 0) + 1);
        }
        const seriesMatches = [...seriesCounts.entries()]
          .filter(([s]) => s.toLowerCase().includes(fvc.prefix) || fvc.prefix === '')
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12);
        if (!seriesMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = seriesMatches.map(([s, n], i) => {
          const badge = ` <span class="search-hist-badge">${n}</span>`;
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(s)}" type="button" tabindex="-1"><span class="search-hist-field">series:</span>${esc(s)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'doi') {
        // Suggest common DOI prefixes or collect unique DOI prefixes from current rows
        const doiPrefixHints = ['10.1145/', '10.1109/', '10.1007/', '10.1016/', '10.18653/', '10.48550/'];
        const doiPrefixMatches = doiPrefixHints.filter((p2) => p2.startsWith(fvc.prefix) || fvc.prefix === '');
        const PUBLISHER_NAMES: Record<string, string> = {
          '10.1145/': 'ACM', '10.1109/': 'IEEE', '10.1007/': 'Springer', '10.1016/': 'Elsevier',
          '10.18653/': 'ACL Anthology', '10.48550/': 'arXiv',
        };
        histDrop.innerHTML = doiPrefixMatches.map((p2, i) =>
          `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(p2)}" type="button" tabindex="-1">` +
          `<span class="search-hist-field">doi:</span>${esc(p2)}<span class="search-hist-badge">${esc(PUBLISHER_NAMES[p2] ?? '')}</span></button>`
        ).join('');
        if (!doiPrefixMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'status') {
        const statusCounts = new Map<string, number>();
        for (const { v: vid, p } of state.rows) {
          const st = statusOf(paperKey(vid, p.id));
          if (st && st !== 'unread') statusCounts.set(st, (statusCounts.get(st) ?? 0) + 1);
        }
        const statusMatches = STATUS_VALUES.filter((v) => v.startsWith(fvc.prefix) || fvc.prefix === '');
        if (!statusMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = statusMatches.map((v, i) => {
          const n = statusCounts.get(v) ?? 0;
          const badge = n > 0 ? ` <span class="search-hist-badge">${n}</span>` : '';
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(v)}" type="button" tabindex="-1"><span class="search-hist-field">status:</span>${esc(v)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'date' || fvc.field === 'pubdate') {
        // Show comparison hints when prefix looks like an operator or is empty
        if (/^[><]?=?$/.test(fvc.prefix) || fvc.prefix === '') {
          const allDates = [...new Set(
            fvc.field === 'date'
              ? state.rows.flatMap((r) => r.p.dates)
              : state.rows.map((r) => r.p.publicationDate).filter((d): d is string => !!d)
          )].sort().reverse().slice(0, 5);
          const dateHints = allDates.length
            ? [`>=${allDates[allDates.length - 1]}`, `<=${allDates[0]}`, ...allDates]
            : [];
          if (!dateHints.length) { histDrop.hidden = true; histDropActive = false; return; }
          const matchedHints = dateHints.filter((h) => h.toLowerCase().startsWith(fvc.prefix)).slice(0, 8);
          if (!matchedHints.length) { histDrop.hidden = true; histDropActive = false; return; }
          histDrop.innerHTML = matchedHints.map((h, i) =>
            `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(h)}" type="button" tabindex="-1"><span class="search-hist-field">${esc(fvc.field)}:</span>${esc(h)}</button>`
          ).join('');
          histDrop.hidden = false; histDropActive = true; return;
        }
        ensureFieldValueIndex();
        values = [...(fieldValueIndex[fvc.field] ?? [])];
      } else if (fvc.field === 'sort') {
        const SORT_DESCS: Record<string, string> = {
          venue: 'by venue', year: 'newest first', 'year-asc': 'oldest first',
          date: 'presentation date ↓', 'date-asc': 'presentation date ↑',
          pubdate: 'publication date ↓', 'pubdate-asc': 'publication date ↑',
          len: 'longest abstract first', 'len-asc': 'shortest abstract first',
          keywords: 'most keywords first',
          location: 'by room', track: 'by topic track', session: 'by session',
          status: 'to-read → done → unread', title: 'A–Z (ignores A/An/The)',
          authors: 'by first author last name', id: 'by paper ID',
          relevance: 'query relevance score', random: 'shuffle', oa: 'open access first',
        };
        const sortMatches = SORT_VALUES.filter((v) => v.toLowerCase().startsWith(fvc.prefix) || fvc.prefix === '');
        if (!sortMatches.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = sortMatches.map((v, i) => {
          const desc = SORT_DESCS[v] ? ` <span class="search-hist-badge">${esc(SORT_DESCS[v])}</span>` : '';
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(v)}" type="button" tabindex="-1"><span class="search-hist-field">sort:</span>${esc(v)}${desc}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'keyword' && (/^[\d><=]/.test(fvc.prefix) || fvc.prefix === '')) {
        // Count-based hints for keyword:>=N
        const kwCountHints = ['>=1', '>=3', '>=5', '>=10', '1-5'];
        const filtered = kwCountHints.filter((h) => h.includes(fvc.prefix) || fvc.prefix === '');
        if (!filtered.length) { histDrop.hidden = true; histDropActive = false; return; }
        histDrop.innerHTML = filtered.map((h, i) => {
          const n = state.rows.filter(({ p }) => {
            const cnt = p.keywords?.length ?? 0;
            const cM = h.match(/^(>=|<=|>|<)(\d+)$/);
            const rM = h.match(/^(\d+)-(\d+)$/);
            if (cM) { const v2 = Number(cM[2]); return cM[1] === '>=' ? cnt >= v2 : cM[1] === '<=' ? cnt <= v2 : cM[1] === '>' ? cnt > v2 : cnt < v2; }
            if (rM) return cnt >= Number(rM[1]) && cnt <= Number(rM[2]);
            return false;
          }).length;
          const badge = ` <span class="search-hist-badge">${n}</span>`;
          return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(h)}" type="button" tabindex="-1"><span class="search-hist-field">keyword:</span>${esc(h)}${badge}</button>`;
        }).join('');
        histDrop.hidden = false; histDropActive = true; return;
      } else if (fvc.field === 'title') {
        if (fvc.prefix.length < 3) { histDrop.hidden = true; histDropActive = false; return; }
        ensureFieldValueIndex();
        values = [...fieldValueIndex.title].filter((t) => t.toLowerCase().includes(fvc.prefix));
      } else {
        ensureFieldValueIndex();
        const countMap: Map<string, number> | null =
          fvc.field === 'keyword' ? keywordPaperCount  :
          fvc.field === 'track'   ? trackPaperCount    :
          fvc.field === 'inst'    ? instPaperCount     :
          fvc.field === 'session' ? sessionPaperCount  :
          fvc.field === 'event'   ? eventPaperCount    : null;
        values = [...(fieldValueIndex[fvc.field] ?? [])];
        if (countMap) values.sort((a, b) => (countMap.get(b) ?? 0) - (countMap.get(a) ?? 0));
      }
      const matches = (fvc.field === 'title' ? values : values.filter((v) => v.toLowerCase().includes(fvc.prefix))).slice(0, 10);
      if (!matches.length) { histDrop.hidden = true; histDropActive = false; return; }
      histDrop.innerHTML = matches.map((v, i) => {
        const count =
          fvc.field === 'author'  ? (authorPaperCount.get(v)  ?? 0) :
          fvc.field === 'keyword' ? (keywordPaperCount.get(v) ?? 0) :
          fvc.field === 'track'   ? (trackPaperCount.get(v)   ?? 0) :
          fvc.field === 'inst'    ? (instPaperCount.get(v)    ?? 0) :
          fvc.field === 'session' ? (sessionPaperCount.get(v) ?? 0) :
          fvc.field === 'event'   ? (eventPaperCount.get(v)   ?? 0) : 0;
        const badge = count > 1 ? ` <span class="search-hist-badge">${count}</span>` : '';
        const display = fvc.field === 'title' && v.length > 60 ? v.slice(0, 60) + '…' : v;
        return `<button class="search-hist-item" data-fv-idx="${i}" data-fv="${esc(v)}" type="button" tabindex="-1"><span class="search-hist-field">${esc(fvc.field)}:</span>${esc(display)}${badge}</button>`;
      }).join('');
      histDrop.hidden = false;
      histDropActive = true;
      return;
    }
    const typed = els.search.value.trim().toLowerCase();
    const hist = loadSearchHistory();
    const filteredHist = typed
      ? hist.filter((h) => h.q.toLowerCase().includes(typed)).slice(0, 5)
      : hist;
    const saved = state.saved;
    const filteredSaved = typed
      ? saved.filter((s) => s.name.toLowerCase().includes(typed) || s.query?.toLowerCase().includes(typed)).slice(0, 3)
      : saved.slice(0, 5);
    if (!filteredHist.length && !filteredSaved.length) { histDrop.hidden = true; histDropActive = false; return; }
    // For readability, replace similar:key with similar:"title" in displayed history
    const rowByKey3 = state.rows.length
      ? new Map(state.rows.map((r) => [paperKey(r.v, r.p.id), r.p.title]))
      : new Map<string, string>();
    const humanizeQuery = (q: string) =>
      q.replace(/\bsimilar:([^\s|]+(?:\|[^\s|]+)*)/g, (_m, keys: string) => {
        const titles = keys.split('|').map((k: string) => {
          const t = rowByKey3.get(k);
          return t ? `"${t.slice(0, 40)}${t.length > 40 ? '…' : ''}"` : k;
        });
        return `similar:${titles.join('|')}`;
      });
    let histCounts: Record<string, number> = {};
    try { histCounts = JSON.parse(localStorage.getItem(K_SEARCH_HIST_COUNTS) ?? '{}') as Record<string, number>; } catch { /* ignore */ }
    const histHtml = filteredHist.map((entry) => {
      const realIdx = hist.indexOf(entry);
      const display = humanizeQuery(entry.q);
      const count = histCounts[entry.q];
      const countBadge = count !== undefined ? ` <span class="search-hist-badge">${count.toLocaleString()}</span>` : '';
      const timeBadge = entry.t ? ` <span class="search-hist-time">${relTime(entry.t)}</span>` : '';
      return `<button class="search-hist-item" data-hist-idx="${realIdx}" type="button" tabindex="-1" title="${esc(entry.q)}"><span class="search-hist-q">${esc(display)}</span>${countBadge}${timeBadge}<button class="search-hist-del" data-hist-del="${realIdx}" type="button" title="Remove" tabindex="-1">×</button></button>`;
    }).join('');
    const savedHtml = filteredSaved.length
      ? (filteredHist.length ? `<div class="search-hist-section">Saved</div>` : '') +
        filteredSaved.map((s) => {
          const si = saved.indexOf(s);
          return `<button class="search-hist-item search-hist-item--saved" data-saved-idx="${si}" type="button" tabindex="-1">${ICONS.star}<span>${esc(s.name)}</span></button>`;
        }).join('')
      : '';
    histDrop.innerHTML = histHtml + savedHtml;
    histDrop.hidden = false;
    histDropActive = true;
  }

  function hideHistDrop() { histDrop.hidden = true; histDropActive = false; }

  els.search.addEventListener('focus', () => { renderHistDrop(); });

  els.search.addEventListener('input', () => { renderHistDrop(); });

  histDrop.addEventListener('mousedown', (e) => {
    e.preventDefault(); // prevent blur
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-hist-idx]');
    const del = (e.target as HTMLElement).closest<HTMLElement>('[data-hist-del]');
    const fvItem = (e.target as HTMLElement).closest<HTMLElement>('[data-fv]');
    if (del) {
      const idx = Number(del.dataset.histDel);
      const hist = loadSearchHistory();
      hist.splice(idx, 1);
      try { localStorage.setItem(K_SEARCH_HISTORY, JSON.stringify(hist)); } catch { /* ignore */ }
      renderHistDrop();
      return;
    }
    if (fvItem) {
      const fvc = getFieldValueContext();
      const val = fvItem.dataset.fv ?? '';
      if (fvc && val) {
        const cur = els.search.value;
        const caret = els.search.selectionStart ?? cur.length;
        const tokenEnd = caret;
        // Find start of the token (include field: part)
        const before = cur.slice(0, caret);
        const m = before.match(/(\w+:\S*)$/);
        const tokLen = m ? m[0].length : 0;
        const replaced = cur.slice(0, caret - tokLen) + fvc.field + ':"' + val + '" ' + cur.slice(tokenEnd);
        els.search.value = replaced;
        const newCaret = (caret - tokLen) + fvc.field.length + 3 + val.length + 2;
        els.search.setSelectionRange(newCaret, newCaret);
        hideHistDrop();
        renderSearchHL();
        clearTimeout(t);
        t = window.setTimeout(commitSearchQuery, 80);
      }
      return;
    }
    if (item) {
      const idx = Number(item.dataset.histIdx);
      const entry = loadSearchHistory()[idx];
      const q = entry?.q ?? '';
      els.search.value = q;
      hideHistDrop();
      renderSearchHL();
      state.query = q;
      state.shown = PAGE;
      writeUrl();
      render();
    }
    const savedItem = (e.target as HTMLElement).closest<HTMLElement>('[data-saved-idx]');
    if (savedItem) {
      const idx = Number(savedItem.dataset.savedIdx);
      loadSaved(idx);
      hideHistDrop();
    }
  });

  document.addEventListener('click', (e) => {
    if (histDropActive && !els.search.contains(e.target as Node) && !histDrop.contains(e.target as Node)) {
      hideHistDrop();
    }
  });

  els.search.addEventListener('keydown', (e) => {
    if (histDropActive && (e.key === 'Escape' || e.key === 'Enter')) hideHistDrop();
    if (e.key === 'Tab' && searchSuggestion) {
      e.preventDefault();
      hideHistDrop();
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
    renderHistDrop();
  });
  // Sort caret-select
  const applySort = (s: string) => {
    state.sort = s;
    try { localStorage.setItem(K_SORT, state.sort); } catch { /* ignore */ }
    reflectSort(); writeUrl(); render();
  };
  $('#sortSelect').addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('[data-sort-val]');
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.caret-select-btn');
    if (opt) {
      const base = opt.dataset.sortVal ?? 'venue';
      // Preserve the current asc/desc direction when switching between directional sorts.
      const keepAsc = DIRECTIONAL_SORTS.has(base) && sortIsAsc(state.sort);
      closeAllCarets();
      applySort(keepAsc ? `${base}-asc` : base);
      return;
    }
    if (btn) toggleCaret(btn);
  });
  // Sort direction toggle (only meaningful for directional sorts)
  document.querySelector<HTMLElement>('#sortDir')?.addEventListener('click', () => {
    const base = sortBase(state.sort);
    if (!DIRECTIONAL_SORTS.has(base)) return;
    applySort(sortIsAsc(state.sort) ? base : `${base}-asc`);
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
  // PDF filter toggle (show only papers with a PDF link)
  const pdfFilterBtn = document.querySelector<HTMLElement>('#pdfFilterBtn');
  if (pdfFilterBtn) {
    pdfFilterBtn.addEventListener('click', () => {
      state.pdfOnly = !state.pdfOnly;
      state.shown = PAGE;
      writeUrl();
      render();
      reflectPdfFilter();
    });
  }
  // OA filter toggle (show only Open Access papers)
  const oaFilterBtn = document.querySelector<HTMLElement>('#oaFilterBtn');
  if (oaFilterBtn) {
    oaFilterBtn.addEventListener('click', () => {
      state.oaOnly = !state.oaOnly;
      state.shown = PAGE;
      writeUrl();
      render();
      reflectOaFilter();
    });
  }
  // Quick export (no selection needed — exports current filtered results)
  const quickExportBtn = document.querySelector<HTMLElement>('#quickExportBtn');
  if (quickExportBtn) {
    quickExportBtn.addEventListener('click', () => {
      openPop(quickExportBtn, () => {
        const n = lastFiltered.length;
        return `<div class="pop-title">Export ${n.toLocaleString()} result${n !== 1 ? 's' : ''}</div>
          <div class="pop-row" data-quick-export="titles" role="button">${ICONS.copy}<span class="pop-row-label">Copy titles</span></div>
          <div class="pop-row" data-quick-export="urls" role="button">${ICONS.copy}<span class="pop-row-label">Copy URLs</span></div>
          <div class="pop-row" data-quick-export="dois" role="button">${ICONS.copy}<span class="pop-row-label">Copy DOIs</span></div>
          <div class="pop-row" data-quick-export="citations" role="button">${ICONS.copy}<span class="pop-row-label">Copy citations</span></div>
          <div class="pop-row" data-quick-export="bibtex" role="button">${ICONS.copy}<span class="pop-row-label">Copy BibTeX</span></div>
          <div class="pop-row" data-quick-export="table" role="button">${ICONS.copy}<span class="pop-row-label">Copy as Table (Notion/Obsidian)</span></div>
          <div class="pop-row" data-quick-export="abstracts" role="button">${ICONS.copy}<span class="pop-row-label">Copy abstracts</span></div>
          <div class="pop-row" data-quick-export="notes" role="button">${ICONS.copy}<span class="pop-row-label">Copy notes</span></div>
          <div class="pop-row" data-quick-export="csv" role="button">${ICONS.download}<span class="pop-row-label">Download CSV</span></div>
          <div class="pop-row" data-quick-export="markdown" role="button">${ICONS.download}<span class="pop-row-label">Download Markdown</span></div>
          <div class="pop-row" data-quick-export="json" role="button">${ICONS.download}<span class="pop-row-label">Download JSON</span></div>
          <div class="pop-row" data-quick-export="ris" role="button">${ICONS.download}<span class="pop-row-label">Download RIS</span></div>`;
      }, (t) => {
        const row = t.closest<HTMLElement>('[data-quick-export]');
        if (row) { closePop(); doExport(row.dataset.quickExport!); }
      });
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
    if (cb.dataset.facet === 'year') {
      const yr = Number(cb.value);
      if (cb.checked) state.yearFilter.add(yr); else state.yearFilter.delete(yr);
    } else if (cb.dataset.facet === 'keyword') {
      if (cb.checked) state.keywordFilter.add(cb.value); else state.keywordFilter.delete(cb.value);
    } else {
      const set = cb.dataset.facet === 'track' ? state.tracks : cb.dataset.facet === 'event' ? state.events : state.venuesFacet;
      if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    }
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
    else if (kind === 'pdfonly') { state.pdfOnly = false; reflectPdfFilter(); }
    else if (kind === 'oaonly') { state.oaOnly = false; reflectOaFilter(); }
    else if (kind === 'yearfilter') { state.yearFilter.delete(Number(btn.dataset.val)); }
    else if (kind === 'keywordfilter') { state.keywordFilter.delete(btn.dataset.val ?? ''); }
    else {
      const set = kind === 'track' ? state.tracks : kind === 'event' ? state.events : kind === 'tagfilter' ? state.tagFilter : state.venuesFacet;
      set.delete(btn.dataset.val ?? '');
    }
    state.shown = PAGE; writeUrl(); render();
  });

  // paper list delegation
  els.list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Handle clicks on sort-group divider buttons (outside paper cards)
    if (target.closest('.session-divider')) {
      if (target.closest('[data-session]')) {
        setQuery(`session:"${(target.closest('[data-session]') as HTMLElement).dataset.session!}"`);
      } else if (target.closest('[data-location-filter]')) {
        setQuery(`location:"${(target.closest('[data-location-filter]') as HTMLElement).dataset.locationFilter!}"`);
      } else if (target.closest('[data-track]')) {
        const tr = (target.closest('[data-track]') as HTMLElement).dataset.track!;
        state.tracks.has(tr) ? state.tracks.delete(tr) : state.tracks.add(tr);
        state.shown = PAGE; writeUrl(); render();
      } else if (target.closest('[data-divider-venue]')) {
        const vid = (target.closest('[data-divider-venue]') as HTMLElement).dataset.dividerVenue!;
        state.venuesFacet.has(vid) ? state.venuesFacet.delete(vid) : state.venuesFacet.add(vid);
        state.shown = PAGE; writeUrl(); render();
      } else if (target.closest('[data-status-filter]')) {
        const st = (target.closest('[data-status-filter]') as HTMLElement).dataset.statusFilter!;
        state.statusFilter = state.statusFilter === st ? '' : st;
        state.shown = PAGE; writeUrl(); render();
      } else if (target.closest('[data-oa-filter]')) {
        const oaKey = (target.closest('[data-oa-filter]') as HTMLElement).dataset.oaFilter!;
        setQuery(`oa:${oaKey}`);
      } else if (target.closest('[data-date-filter]')) {
        const dt = (target.closest('[data-date-filter]') as HTMLElement).dataset.dateFilter!;
        setQuery(`date:${dt}`);
      } else if (target.closest('[data-pubdate-filter]')) {
        const pd = (target.closest('[data-pubdate-filter]') as HTMLElement).dataset.pubdateFilter!;
        setQuery(`pubdate:${pd}`);
      }
      return;
    }
    const card = target.closest<HTMLElement>('.paper-card');
    if (!card) return;
    const toggle = target.closest<HTMLButtonElement>('[data-card-toggle]');
    if (toggle) {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      card.classList.toggle('is-open', !open);
      const cardKey = card.dataset.key ?? '';
      if (!open && cardKey) {
        try { history.replaceState(null, '', location.pathname + location.search + `#paper:${cardKey}`); } catch { /* ignore */ }
      } else if (open && location.hash.startsWith('#paper:')) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
      }
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
      // Shift+click: put similar:key into the search box for composable filtering
      if ((e as MouseEvent).shiftKey) {
        setQuery(`similar:${fk}`);
        return;
      }
      openRecommendLoading('Similar papers');
      ensureAllLoaded().then(() => {
        populateRecommendModal('Similar papers', similarGlobal(fk, 30));
      });
    } else if (target.closest('[data-session]')) {
      setQuery(`session:"${(target.closest('[data-session]') as HTMLElement).dataset.session!}"`);
    } else if (target.closest('[data-location-filter]')) {
      setQuery(`location:"${(target.closest('[data-location-filter]') as HTMLElement).dataset.locationFilter!}"`);
    } else if (target.closest('[data-inst]')) {
      const instName = (target.closest('[data-inst]') as HTMLElement).dataset.inst!;
      setQuery(`inst:"${instName}"`);
    } else if (target.closest('[data-author]')) {
      const authorName = (target.closest('[data-author]') as HTMLElement).dataset.author!;
      setQuery(`author:"${authorName}"`);
    } else if (target.closest('[data-kw-mode]')) {
      state.keywordFilterMode = state.keywordFilterMode === 'any' ? 'all' : 'any';
      state.shown = PAGE; writeUrl(); render();
    } else if (target.closest('[data-kw]')) {
      const kw = (target.closest('[data-kw]') as HTMLElement).dataset.kw!;
      if (state.keywordFilter.has(kw)) state.keywordFilter.delete(kw); else state.keywordFilter.add(kw);
      state.shown = PAGE; writeUrl(); render();
    } else if (target.closest('[data-copy-key]')) {
      const ck = (target.closest('[data-copy-key]') as HTMLElement).dataset.copyKey!;
      navigator.clipboard.writeText(ck).then(() => toast(`Key copied: ${ck}`)).catch(() => toast('Clipboard blocked'));
    } else if (target.closest('[data-copy-title]')) {
      const copyKey = (target.closest('[data-copy-title]') as HTMLElement).dataset.copyTitle!;
      const [vId, pId] = copyKey.split(':');
      const pRow = state.loaded.get(vId)?.find((p) => p.id === pId);
      if (pRow?.title) {
        navigator.clipboard.writeText(pRow.title).then(() => toast('Title copied!')).catch(() => toast('Clipboard blocked'));
      }
    } else if (target.closest('[data-copy-abstract]')) {
      const copyKey = (target.closest('[data-copy-abstract]') as HTMLElement).dataset.copyAbstract!;
      const [vId, pId] = copyKey.split(':');
      const pRow = state.loaded.get(vId)?.find((p) => p.id === pId);
      if (pRow?.abstract) {
        navigator.clipboard.writeText(pRow.abstract).then(() => toast('Abstract copied!')).catch(() => toast('Clipboard blocked'));
      }
    } else if (target.closest('[data-copy-cite]')) {
      const copyKey = (target.closest('[data-copy-cite]') as HTMLElement).dataset.copyCite!;
      const [vId, pId] = copyKey.split(':');
      const pRow = state.loaded.get(vId)?.find((p) => p.id === pId);
      const venue = venueById.get(vId);
      if (pRow && venue) {
        const authors = pRow.authors.length === 0 ? 'Unknown'
          : pRow.authors.length <= 3 ? pRow.authors.join(', ')
          : `${pRow.authors.slice(0, 3).join(', ')} et al.`;
        const year = venue.year ? ` (${venue.year})` : '';
        const doi = pRow.doi ? `. https://doi.org/${pRow.doi}` : pRow.urls[0] ? `. ${pRow.urls[0]}` : '';
        const cite = `${authors}${year}. "${pRow.title}." In ${venue.name}${doi}`;
        navigator.clipboard.writeText(cite).then(() => toast('Citation copied!')).catch(() => toast('Clipboard blocked'));
      }
    } else if (target.closest('[data-copy-paper]')) {
      const copyKey = (target.closest('[data-copy-paper]') as HTMLElement).dataset.copyPaper!;
      const [vId, pId] = copyKey.split(':');
      const pRow = state.loaded.get(vId)?.find((p) => p.id === pId);
      const venue = venueById.get(vId);
      if (pRow && venue) {
        const bib = toBibtex([{ paper: pRow, venue }]);
        navigator.clipboard.writeText(bib).then(() => toast('BibTeX copied!')).catch(() => toast('Clipboard blocked'));
      }
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

  // sort hint button in summary bar (appears when similar: active and sort !== relevance)
  els.summary.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-sort-hint]')) {
      state.sort = 'relevance';
      writeUrl(); render();
    } else if ((e.target as HTMLElement).closest('[data-reshuffle]')) {
      _shuffleWeights = null; // clear weights to get a fresh shuffle
      render();
    }
  });

  // export bar
  els.exportBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-export]');
    if (btn) doExport(btn.dataset.export!);
  });
  // Grouped Copy / Download menus for the selection bar — keep the bar short.
  const wireExportMenu = (id: string, items: { val: string; label: string }[]) => {
    const anchor = document.querySelector<HTMLElement>(id);
    if (!anchor) return;
    anchor.addEventListener('click', () => {
      openPop(anchor, () => {
        const rows = items.map((it) =>
          `<div class="pop-row" data-export-pick="${it.val}" role="button">${ICONS.copy}<span class="pop-row-label">${it.label}</span></div>`
        ).join('');
        return `<div class="pop-list">${rows}</div>`;
      }, (t) => {
        const row = t.closest<HTMLElement>('[data-export-pick]');
        if (row) { closePop(); doExport(row.dataset.exportPick!); }
      });
    });
  };
  wireExportMenu('#selCopyBtn', [
    { val: 'titles', label: 'Copy titles' },
    { val: 'urls', label: 'Copy URLs' },
    { val: 'dois', label: 'Copy DOIs' },
    { val: 'citations', label: 'Copy citations' },
    { val: 'bibtex', label: 'Copy BibTeX' },
    { val: 'table', label: 'Copy as Table (Notion/Obsidian)' },
    { val: 'abstracts', label: 'Copy abstracts' },
    { val: 'notes', label: 'Copy notes' },
  ]);
  wireExportMenu('#selDownloadBtn', [
    { val: 'csv', label: 'Download CSV' },
    { val: 'markdown', label: 'Download Markdown' },
    { val: 'json', label: 'Download JSON' },
    { val: 'ris', label: 'Download RIS' },
  ]);
  // Batch status: set reading status for all selected papers at once
  const batchStatusBtn = document.querySelector<HTMLElement>('#batchStatusBtn');
  if (batchStatusBtn) {
    batchStatusBtn.addEventListener('click', () => {
      const buildHtml = () => {
        const opts = [
          { val: 'toread', label: 'To read', icon: ICONS.statusToread },
          { val: 'reading', label: 'Reading', icon: ICONS.statusReading },
          { val: 'done', label: 'Done', icon: ICONS.statusDone },
          { val: 'unread', label: 'Unread (clear)', icon: ICONS.statusUnread },
        ];
        const rows = opts.map((o) =>
          `<div class="pop-row" data-batch-status="${o.val}" role="button">${o.icon}<span class="pop-row-label">${o.label}</span></div>`
        ).join('');
        return `<div class="pop-title">Set status for ${state.sel.size} papers</div><div class="pop-list">${rows}</div>`;
      };
      openPop(batchStatusBtn, buildHtml, (t) => {
        const row = t.closest<HTMLElement>('[data-batch-status]');
        if (!row) return;
        const newStatus = row.dataset.batchStatus!;
        for (const k of state.sel) {
          if (newStatus === 'unread') state.status.delete(k);
          else state.status.set(k, newStatus);
        }
        saveStatus();
        closePop();
        render();
        reflectStatusFilter();
        toast(`Status set to "${newStatus === 'unread' ? 'unread' : newStatus}" for ${state.sel.size} papers`);
      });
    });
  }

  // Batch collect: add all selected papers to a collection
  const batchCollectBtn = document.querySelector<HTMLElement>('#batchCollectBtn');
  if (batchCollectBtn) {
    batchCollectBtn.addEventListener('click', () => {
      const keys = [...state.sel];
      const buildHtml = () => {
        const rows = state.collections.map((c) =>
          `<div class="pop-row" data-bulk-col-toggle="${esc(c.id)}" role="button"><input type="checkbox" tabindex="-1" ${keys.every((k2) => c.keys.includes(k2)) ? 'checked' : ''}><span class="pop-row-label">${esc(c.name)}</span><span class="pop-row-n">${c.keys.length}</span></div>`
        ).join('');
        return `<div class="pop-title">Add ${keys.length} papers to collection</div>${rows || '<p class="pop-empty">No collections yet.</p>'}<button class="pop-action" data-bulk-col-new type="button">＋ New collection…</button>`;
      };
      openPop(batchCollectBtn, buildHtml, (t) => {
        const toggle = t.closest<HTMLElement>('[data-bulk-col-toggle]');
        if (toggle) {
          const c = collectionById(toggle.dataset.bulkColToggle ?? '');
          if (c) {
            for (const k of keys) { if (!c.keys.includes(k)) c.keys.push(k); }
            saveCollections();
            afterCollectionsChange();
            paintPop();
            toast(`Added ${keys.length} papers to "${c.name}"`);
          }
          return;
        }
        if (t.closest('[data-bulk-col-new]')) {
          askText({ title: 'New collection', placeholder: 'Collection name', max: NAME_MAX }).then((name) => {
            const clean = cleanInput(name ?? '');
            if (!clean) return;
            state.collections.push({ id: uid(), name: clean, keys: [...keys] });
            saveCollections();
            afterCollectionsChange();
            closePop();
            toast(`Created "${clean}" with ${keys.length} papers`);
          });
        }
      });
    });
  }

  // Batch tag: add a tag to all selected papers at once
  const batchTagBtn = document.querySelector<HTMLElement>('#batchTagBtn');
  if (batchTagBtn) {
    batchTagBtn.addEventListener('click', () => {
      let filterText = '';
      const buildHtml = () => {
        // Tags present on any selected paper (with count of selected papers having each tag)
        const selTagCounts = new Map<string, number>();
        for (const k of state.sel) for (const t of tagsOf(k)) selTagCounts.set(t, (selTagCounts.get(t) ?? 0) + 1);
        const removeSection = selTagCounts.size
          ? `<div class="pop-section-label">On selection</div><div class="pop-list">`
            + [...selTagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([t, n]) => `<div class="pop-row pop-row--removable" data-batch-tag-remove="${esc(t)}" role="button"><span class="pop-row-label">${esc(t)}</span><span class="pop-row-n">${n < state.sel.size ? `${n}/${state.sel.size}` : ''}</span><span class="pop-row-del">×</span></div>`)
                .join('')
            + `</div><div class="pop-divider"></div>`
          : '';
        const allTags = [...tagCounts().entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const lower = filterText.toLowerCase();
        const visible = lower ? allTags.filter(([t]) => t.toLowerCase().includes(lower)) : allTags;
        const rows = visible.map(([t, n]) =>
          `<div class="pop-row" data-batch-tag-apply="${esc(t)}" role="button"><span class="pop-row-label">${esc(t)}</span><span class="pop-row-n">${n}</span></div>`
        ).join('');
        const cleanFilter = cleanInput(filterText, TAG_MAX);
        const isNewTag = cleanFilter && !allTags.some(([t]) => t === cleanFilter);
        const newAction = isNewTag
          ? `<button class="pop-action" data-batch-tag-new="${esc(cleanFilter)}" type="button">＋ Add "${esc(cleanFilter)}" to ${state.sel.size} papers</button>` : '';
        return `<div class="pop-title">Tags for ${state.sel.size} papers</div>`
          + removeSection
          + `<input class="pop-search" type="text" placeholder="Filter or add tag…" value="${esc(filterText)}" autocomplete="off" spellcheck="false">`
          + `<div class="pop-list">${rows || (lower ? '<p class="pop-empty">No matching tags.</p>' : '<p class="pop-empty">No tags yet.</p>')}</div>`
          + newAction;
      };
      openPop(batchTagBtn, buildHtml, (t) => {
        const removeBtn = t.closest<HTMLElement>('[data-batch-tag-remove]');
        if (removeBtn) {
          const tag = removeBtn.dataset.batchTagRemove!;
          let removed = 0;
          for (const k of state.sel) {
            const cur = new Set(tagsOf(k));
            if (cur.delete(tag)) { state.tags.set(k, [...cur]); removed++; }
          }
          saveTags(); paintPop(); render();
          toast(`Removed "${tag}" from ${removed} ${plural(removed, 'paper')}`);
          return;
        }
        const applyBtn = t.closest<HTMLElement>('[data-batch-tag-apply]');
        const newBtn = t.closest<HTMLElement>('[data-batch-tag-new]');
        const tag = applyBtn?.dataset.batchTagApply ?? (newBtn ? cleanInput(newBtn.dataset.batchTagNew ?? '', TAG_MAX) : '');
        if (!tag) return;
        for (const k of state.sel) {
          const cur = new Set(tagsOf(k));
          cur.add(tag);
          state.tags.set(k, [...cur]);
        }
        saveTags();
        closePop();
        render();
        toast(`Tag "${tag}" added to ${state.sel.size} papers`);
      }, (val) => {
        filterText = val.slice(0, TAG_MAX * 2);
        paintPop();
      });
      requestAnimationFrame(() => { popEl.querySelector<HTMLInputElement>('.pop-search')?.focus(); });
    });
  }

  // saved searches (the toolbar button; a second opener lives in Settings)
  $('[data-save-current]').addEventListener('click', () => saveCurrentSearch());

  // theme, help, modals
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', cycleTheme));
  $('[data-help]').addEventListener('click', () => { $('#helpModal').hidden = false; });
  document.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));

  // PDF opens directly in a new tab (the card PDF button is a plain <a target="_blank">),
  // so there is no in-page viewer to wire up — many publishers block iframe embedding.

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
    const colSimilar = t.closest<HTMLElement>('[data-col-similar]');
    if (colSimilar) {
      const c = collectionById(colSimilar.dataset.colSimilar ?? '');
      if (c && c.keys.length) {
        const seeds = c.keys.slice(0, 10); // cap seeds to keep query short
        closeModals();
        setQuery(`similar:${seeds.join('|')} sort:relevance`);
      } else {
        toast('Collection is empty');
      }
      return;
    }
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
            await gistSync.push(bundle as Bundle);
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
      // --- Navigation: title → navigate directly to paper in main view ---
      const titleBtn = t.closest<HTMLElement>('[data-mini-nav]');
      if (titleBtn) {
        const navKey = titleBtn.dataset.miniNav!;
        const [navVid] = navKey.split(':');
        closeModals();
        // Ensure venue is selected, clear the search query so the paper is visible
        if (!state.selected.has(navVid)) { state.selected.add(navVid); reflectSidebar(); writeUrl(); }
        state.query = ''; els.search.value = ''; renderSearchHL?.();
        state.shown = PAGE;
        ensureLoaded([navVid]).then(() => {
          // Expand shown count if needed to include the target paper
          const filteredForNav = state.rows.filter(matches);
          const idx = filteredForNav.findIndex((r) => paperKey(r.v, r.p.id) === navKey);
          if (idx >= 0 && idx >= state.shown) state.shown = idx + 1;
          render();
          requestAnimationFrame(() => {
            const card = els.list.querySelector<HTMLElement>(`.paper-card[data-key="${CSS.escape(navKey)}"]`);
            if (card) {
              if (card.querySelector<HTMLButtonElement>('[data-card-toggle]')?.getAttribute('aria-expanded') !== 'true') {
                card.querySelector<HTMLButtonElement>('[data-card-toggle]')?.click();
              }
              card.scrollIntoView({ behavior: 'smooth', block: 'start' });
              els.list.querySelectorAll('.paper-card.is-focused').forEach((c) => c.classList.remove('is-focused'));
              card.classList.add('is-focused');
            }
          });
        });
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
    } else if (kind === 'keyword') {
      state.keywordFilter.has(val) ? state.keywordFilter.delete(val) : state.keywordFilter.add(val);
      state.shown = PAGE; writeUrl(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (kind === 'year') {
      const yr = Number(val);
      if (yr) { state.yearFilter.has(yr) ? state.yearFilter.delete(yr) : state.yearFilter.add(yr); }
      state.shown = PAGE; writeUrl(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (kind === 'author') {
      setQuery(`author:"${railAuthorName.get(val) ?? val}"`); // val is a disambiguated key
    } else if (kind === 'oa') {
      setQuery(`oa:${val}`);
    } else if (kind === 'inst') {
      setQuery(`inst:"${val}"`);
    } else if (kind === 'tag') {
      state.tagFilter.has(val) ? state.tagFilter.delete(val) : state.tagFilter.add(val);
      state.shown = PAGE; writeUrl(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      setQuery(`${kind}:"${val}"`); // fallback for other chart types
    }
  });

  // auto-sync on tab focus: pull remote changes when switching back to this tab;
  // best-effort flush on tab hide (changes inside the debounce window).
  let lastVisibilityPull = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingSync(); // non-blocking keepalive
      return;
    }
    // visible — pull remote
    if (!gistSync.isLoggedIn()) return;
    if (syncConflictPending) return;
    const now = Date.now();
    if (now - lastVisibilityPull < 30_000) return; // throttle: at most once per 30 s
    lastVisibilityPull = now;
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
      gistSync.refresh();
      return;
    }
    // Another tab signed out
    if (e.key === K_GH_TOKEN && !e.newValue) {
      gistSync.refresh();
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
      case '?': case 'h': toggleHelp(); break;
      case 'f': { const open = els.facetsWrap.classList.toggle('is-open'); $('[data-facets-toggle]').setAttribute('aria-expanded', String(open)); break; }
      case 't': cycleTheme(); break;
      case '[': setSidebarCollapsed(!document.documentElement.classList.contains('is-sidebar-collapsed')); break;
      case ']': setRailCollapsed(!document.documentElement.classList.contains('is-rail-collapsed')); break;
      case 'j': e.preventDefault(); moveFocus(1); break;
      case 'k': e.preventDefault(); moveFocus(-1); break;
      case 'o': focusedCard()?.querySelector<HTMLButtonElement>('[data-card-toggle]')?.click(); break;
      case 'O': { // expand all visible cards
        const allCards = els.list.querySelectorAll<HTMLElement>('.paper-card');
        const anyCollapsed = [...allCards].some((c) => c.querySelector('[data-card-toggle]')?.getAttribute('aria-expanded') !== 'true');
        allCards.forEach((c) => {
          const tog = c.querySelector<HTMLButtonElement>('[data-card-toggle]');
          if (tog) { const isOpen = tog.getAttribute('aria-expanded') === 'true'; if (anyCollapsed ? !isOpen : isOpen) tog.click(); }
        }); break;
      }
      case 'x': focusedCard()?.querySelector<HTMLInputElement>('[data-sel]')?.click(); break;
      case 'X': if (state.sel.size) { state.sel.clear(); render(); } break; // deselect all
      case 'n': focusedCard()?.querySelector<HTMLButtonElement>('[data-note-edit]')?.click(); break;
      case 'p': focusedCard()?.querySelector<HTMLElement>('[data-open-pdf]')?.click(); break;
      case '1': case '2': case '3': case '0': {
        const card = focusedCard();
        if (!card) break;
        const k = card.dataset.key ?? '';
        if (!k) break;
        const newStatus = e.key === '1' ? 'toread' : e.key === '2' ? 'reading' : e.key === '3' ? 'done' : 'unread';
        if (newStatus === 'unread') state.status.delete(k); else state.status.set(k, newStatus);
        saveStatus();
        const btn = card.querySelector<HTMLElement>('[data-status-cycle]');
        if (btn) {
          btn.className = `icon-btn status-btn status-btn--${newStatus}`;
          btn.title = STATUS_TITLE[newStatus] ?? '';
          btn.setAttribute('aria-label', STATUS_TITLE[newStatus] ?? '');
          btn.innerHTML = STATUS_ICONS[newStatus] ?? '';
        }
        reflectStatusFilter();
        break;
      }
      case 'u': {
        const card2 = focusedCard();
        const k2 = card2?.dataset.key ?? '';
        if (k2) {
          const deepUrl = location.origin + location.pathname + location.search + `#paper:${k2}`;
          navigator.clipboard.writeText(deepUrl).then(() => toast('Paper link copied')).catch(() => toast('Clipboard blocked'));
        } else {
          const link = card2?.querySelector<HTMLAnchorElement>('.program-link');
          if (link?.href) navigator.clipboard.writeText(link.href).then(() => toast('URL copied')).catch(() => toast('Clipboard blocked'));
        }
        break;
      }
      case 'U': {
        const searchUrl = location.href;
        navigator.clipboard.writeText(searchUrl).then(() => toast('Search URL copied')).catch(() => toast('Clipboard blocked'));
        break;
      }
      case 's': focusedCard()?.querySelector<HTMLButtonElement>('[data-collect]')?.click(); break;
      case 'c': focusedCard()?.querySelector<HTMLButtonElement>('[data-copy-paper]')?.click(); break;
      case 'C': { // copy BibTeX for all selected (or all filtered) papers
        const bibRows = currentExportRows();
        if (!bibRows.length) break;
        const bib = toBibtex(bibRows);
        navigator.clipboard.writeText(bib).then(() => toast(`Copied ${bibRows.length} ${plural(bibRows.length, 'BibTeX entry', 'BibTeX entries')}`)).catch(() => toast('Clipboard blocked'));
        break;
      }
      case 'A': { // copy abstract of focused card
        const aCard2 = focusedCard();
        const aKey2 = aCard2?.dataset.key ?? '';
        if (aKey2) {
          const [avid2, ...aidParts2] = aKey2.split(':');
          const aid2 = aidParts2.join(':');
          const aRow2 = state.rows.find((r) => r.v === avid2 && r.p.id === aid2);
          const abs = aRow2?.p.abstract?.trim();
          if (abs) navigator.clipboard.writeText(abs).then(() => toast('Abstract copied')).catch(() => toast('Clipboard blocked'));
          else toast('No abstract available');
        }
        break;
      }
      case 'l': { // open first URL of focused card in new tab
        const lCard = focusedCard();
        const lKey = lCard?.dataset.key ?? '';
        if (lKey) {
          const [lvid, ...lidParts] = lKey.split(':');
          const lid = lidParts.join(':');
          const lRow = state.rows.find((r) => r.v === lvid && r.p.id === lid);
          const lUrl = lRow?.p.urls[0] ?? lRow?.p.pdfUrls?.[0];
          if (lUrl) { window.open(lUrl, '_blank', 'noreferrer'); }
        }
        break;
      }
      case 'i': { // find similar to focused card (open modal)
        const simKey = focusedCard()?.dataset.key;
        if (simKey) {
          openRecommendLoading('Similar papers');
          ensureAllLoaded().then(() => { populateRecommendModal('Similar papers', similarGlobal(simKey, 30)); });
        }
        break;
      }
      case 'r': { // reset all active filters (keeps search query intact)
        const hadFilters = state.tracks.size || state.events.size || state.venuesFacet.size
          || state.tagFilter.size || state.yearFilter.size || state.keywordFilter.size
          || state.statusFilter || state.notesOnly || state.pdfOnly || state.oaOnly;
        state.tracks.clear(); state.events.clear(); state.venuesFacet.clear();
        state.tagFilter.clear(); state.yearFilter.clear(); state.keywordFilter.clear(); state.keywordFilterMode = 'any';
        state.statusFilter = ''; state.notesOnly = false; state.pdfOnly = false; state.oaOnly = false;
        state.shown = PAGE;
        if (hadFilters) { writeUrl(); render(); toast('Filters cleared'); }
        break;
      }
      case 'e': {
        const qeb = document.querySelector<HTMLElement>('#quickExportBtn');
        if (qeb && !qeb.hidden) qeb.click();
        break;
      }
      case 'm': { // load more papers
        const moreBtn = document.querySelector<HTMLButtonElement>('#showMore');
        if (moreBtn) moreBtn.click();
        break;
      }
      case 'G': window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); break;
      case 'g': {
        const now = Date.now();
        if (now - lastG < 500) { window.scrollTo({ top: 0, behavior: 'smooth' }); lastG = 0; } else lastG = now;
        break;
      }
    }
  });
}

// --- TF-IDF similarity (thin wrappers over core/similar buildTfidfIndex) ------
// STOP_WORDS, tfidfTokenize → imported from ../core/text
// buildTfidfIndex, TfidfIndex → imported from ../core/similar

let _tfidfIndex: TfidfIndex | null = null;
let _shuffleWeights: Map<string, number> | null = null;
const _similarSetsCache = new Map<string, Set<string>>();
const _similarScoreMapsCache = new Map<string, Map<string, number>>();

function getSimilarSet(targetKey: string): Set<string> {
  if (_similarSetsCache.has(targetKey)) return _similarSetsCache.get(targetKey)!;
  if (!_tfidfIndex) _tfidfIndex = buildTfidfIndex(state.rows);
  const s = _tfidfIndex.similarSet(targetKey);
  _similarSetsCache.set(targetKey, s);
  return s;
}

function getSimilarScoreMap(targetKey: string): Map<string, number> {
  if (_similarScoreMapsCache.has(targetKey)) return _similarScoreMapsCache.get(targetKey)!;
  if (!_tfidfIndex) _tfidfIndex = buildTfidfIndex(state.rows);
  const m = _tfidfIndex.similarScoreMap(targetKey);
  _similarScoreMapsCache.set(targetKey, m);
  return m;
}

function similarTo(targetKey: string, n = 8): { p: Paper; v: string; score: number }[] {
  if (!_tfidfIndex) _tfidfIndex = buildTfidfIndex(state.rows);
  return _tfidfIndex.similar(targetKey, n);
}

function recommendFromSaved(n = 12): { p: Paper; v: string; score: number }[] {
  if (!_tfidfIndex) _tfidfIndex = buildTfidfIndex(state.rows);
  // Papers the user has collected, tagged, or marked reading/done
  const savedKeys = new Set<string>();
  for (const c of state.collections) c.keys.forEach((k) => savedKeys.add(k));
  for (const [k] of state.tags) savedKeys.add(k);
  for (const [k] of state.status) savedKeys.add(k);
  return _tfidfIndex.recommend(savedKeys, n);
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
// Lazy-built after ensureAllLoaded(); uses a separate index over all loaded rows.
let _globalTfidfIndex: TfidfIndex | null = null;

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
  _globalTfidfIndex = null; // invalidate when corpus grows
}

function similarGlobal(targetKey: string, n = 30): { p: Paper; v: string; score: number }[] {
  if (!_globalTfidfIndex) _globalTfidfIndex = buildTfidfIndex(allLoadedRows());
  return _globalTfidfIndex.similar(targetKey, n);
}

function recommendGlobal(n = 40): { p: Paper; v: string; score: number }[] {
  if (!_globalTfidfIndex) _globalTfidfIndex = buildTfidfIndex(allLoadedRows());
  const savedKeys = new Set<string>();
  for (const c of state.collections) c.keys.forEach((k) => savedKeys.add(k));
  for (const [k] of state.tags) savedKeys.add(k);
  for (const [k] of state.status) savedKeys.add(k);
  for (const [k] of state.notes) savedKeys.add(k);
  return _globalTfidfIndex.recommend(savedKeys, n);
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

// Icons for the view toggle: show the CURRENT view so the button reflects state.
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
  void handleOAuthCallback();
  // If already logged in: fetch identity if not cached, then pull latest remote state
  if (gistSync.isLoggedIn()) {
    void gistSync.ensureIdentity();
    void autoSync(); // pull on startup; no-op if already up to date
  }
  reflectSidebar();
  reflectSeriesGroup();
  reflectCollectionFilter();
  reflectTagFilter();
  reflectStatusFilter();
  reflectNotesFilter();
  reflectPdfFilter();
  reflectOaFilter();
  reflectSort();
  renderSettings();
  ensureLoaded([...state.selected]).then(() => { render(); });
}

init();
