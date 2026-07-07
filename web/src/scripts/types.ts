export interface Venue {
  id: string;
  name: string;
  series: string;
  category: string;
  year: number | null;
  kind: string;
  count: number;
  /** Homepage / programme URL for this venue edition (from venues.yaml at build time). */
  url?: string;
}

export interface Paper {
  id: string;
  title: string;
  abstract: string;
  authors: string[];
  authorInstitutions: string;
  /** stable per-author ids (ORCID / OpenAlex), aligned to authors; '' when unknown */
  authorIds?: string[];
  tracks: string[];
  eventType: string;
  sessionTitles: string[];
  sessions: string[];
  dates: string[];
  locations: string[];
  urls: string[];
  doi?: string;
  publicationDate?: string;
  publisher?: string;
  container?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  pdfUrls?: string[];
  artifactUrls?: string[];
  keywords?: string[];
  /** free-form, adapter-specific metadata bag (e.g. OpenAlex `openAccess`,
   *  source-specific ids). Shape varies per venue adapter. */
  extra?: Record<string, unknown>;
  /** lazily-cached lowercased search blob */
  _search?: string;
  /** lazily-cached author→institution pairs parsed from authorInstitutions */
  _aff?: { author: string; inst: string }[];
  /** lazily-cached unique institution list */
  _insts?: string[];
}

export interface SavedSearch {
  name: string;
  query: string;
  tracks: string[];
  events: string[];
  venues: string[];
  sort: string;
  /** id of the collection the view was scoped to, '' for none */
  collection?: string;
  keywords?: string[];
  keywordMode?: 'any' | 'all';
  yearFilter?: number[];
  statusFilter?: string;
  notesOnly?: boolean;
  pdfOnly?: boolean;
  oaOnly?: boolean;
  tagFilter?: string[];
}

/** A user-named group of venue *series* (e.g. "My SE list" = ICSE, FSE, ASE). */
export interface VenueGroup {
  id: string;
  name: string;
  series: string[];
}

/** A user-named collection of papers, identified by "venueId:paperId" keys. */
export interface Collection {
  id: string;
  name: string;
  keys: string[];
}

/** Serialized snapshot of syncable config; used for export, import, URL
 *  sharing, and Gist sync. Every field is optional so partial bundles
 *  (e.g. a single shared collection) are valid.
 *  version 1 = initial; version 2 = adds paperNotes + readStatus. */
export interface SettingsBundle {
  app: string;
  version: number;
  exportedAt?: string;
  /** ISO timestamp written by pushBundle; used for conflict detection. */
  updatedAt?: string;
  venueGroups?: VenueGroup[];
  collections?: Collection[];
  paperTags?: Record<string, string[]>;
  savedSearches?: SavedSearch[];
  /** Per-paper private notes, keyed "venueId:paperId". */
  paperNotes?: Record<string, string>;
  /** Per-paper reading status, keyed "venueId:paperId". Values: 'toread'|'reading'|'done'. */
  readStatus?: Record<string, string>;
}

/** Cached GitHub user info (from GET /user). Stored as K_GH_USER. */
export interface GitHubUser {
  login: string;
  avatarUrl: string;
  name?: string;
  email?: string;
}

/** Persisted after each successful sync; used to detect which side has changed. */
export interface SyncMeta {
  /** The remote bundle's updatedAt at the time of last sync. */
  remoteUpdatedAt: string;
  /** bundleFingerprint() of the local config at the time of last sync. */
  localFingerprint: string;
  /** ISO time of the last confirmed-in-sync check (push, pull, or no-op).
   *  Used only for the "Last synced" display; falls back to remoteUpdatedAt
   *  for metas written before this field existed. */
  lastSyncedAt?: string;
  /** The synced bundle as of the last push/pull — used as the merge base for
   *  3-way conflict resolution. Absent on metas written before this field. */
  base?: SettingsBundle;
}
