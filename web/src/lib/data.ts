import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('public/data');

export interface VenueSummary {
  id: string;
  name: string;
  series: string;
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
}

export interface VenueGroup {
  series: string;
  items: VenueSummary[];
}

export function loadVenues(): VenueSummary[] {
  const file = path.join(DATA_DIR, 'venues.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return (raw.venues ?? []) as VenueSummary[];
}

export function loadPapers(venueId: string): Paper[] {
  const file = path.join(DATA_DIR, `${venueId}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Paper[];
}

export function groupBySeries(venues: VenueSummary[]): VenueGroup[] {
  const groups = new Map<string, VenueSummary[]>();
  for (const venue of venues) {
    const key = venue.series || venue.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(venue);
  }
  return [...groups.entries()]
    .map(([series, items]) => ({
      series,
      items: items.sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
    }))
    .sort((a, b) => a.series.localeCompare(b.series));
}

export function venueTracks(papers: Paper[]): string[] {
  return [...new Set(papers.flatMap((p) => p.tracks))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
