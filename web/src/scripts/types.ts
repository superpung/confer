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
  tracks: string[];
  eventType: string;
  sessionTitles: string[];
  sessions: string[];
  dates: string[];
  locations: string[];
  urls: string[];
  /** lazily-cached lowercased search blob */
  _search?: string;
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
