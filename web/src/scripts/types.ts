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
  favOnly: boolean;
}
