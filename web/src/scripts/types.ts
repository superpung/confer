export interface Venue {
  id: string;
  name: string;
  series: string;
  category: string;
  year: number | null;
  kind: string;
  count: number;
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

/** Serialized snapshot of all personal/preference data; used for export,
 *  import, URL sharing, and Gist sync. Every field is optional so partial
 *  bundles (e.g. a single shared collection) are valid. */
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
  theme?: string;
  accent?: string;
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
}
