import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const DATA_DIR = path.resolve('public/data');

export interface VenueSummary {
  id: string;
  name: string;
  series: string;
  category: string;
  year: number | null;
  kind: string;
  count: number;
  /** Homepage / programme URL for this venue edition, sourced from venues.yaml. */
  url?: string;
}

export interface SeriesGroup {
  series: string;
  kind: string;
  count: number;
  years: VenueSummary[];
}

export interface CategoryGroup {
  category: string;
  series: SeriesGroup[];
  count: number;
}

/** Read config/venues.yaml (one level up from web/) and extract the URL for each
 *  venue id.  Prefers program_url, then the first of program_urls (venues whose
 *  program is split across several track pages), then base_url, then toc_url.
 *  Returns an empty map on any parse error so the site degrades gracefully. */
function loadVenueUrls(): Map<string, string> {
  const urls = new Map<string, string>();
  try {
    const ymlFile = path.resolve('../config/venues.yaml');
    if (!fs.existsSync(ymlFile)) return urls;
    const doc = yaml.load(fs.readFileSync(ymlFile, 'utf-8')) as {
      venues?: {
        id?: string;
        source?: {
          program_url?: string;
          program_urls?: string[];
          base_url?: string;
          toc_url?: string;
        };
      }[]
    };
    for (const v of doc.venues ?? []) {
      if (!v.id) continue;
      const src = v.source;
      const url = src?.program_url ?? src?.program_urls?.[0] ?? src?.base_url ?? src?.toc_url;
      if (url) urls.set(v.id, url);
    }
  } catch { /* degrade gracefully */ }
  return urls;
}

export function loadVenues(): VenueSummary[] {
  const file = path.join(DATA_DIR, 'venues.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const urlMap = loadVenueUrls();
  const venues = (raw.venues ?? []) as VenueSummary[];
  for (const v of venues) {
    const url = urlMap.get(v.id);
    if (url) v.url = url;
  }
  return venues;
}

/** ISO timestamp of the last scrape, recorded in venues.json. */
export function loadGeneratedAt(): string | null {
  const file = path.join(DATA_DIR, 'venues.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return (raw.generatedAt as string) ?? null;
}

/** Group venues by research category, then by series (each series holds its years). */
export function groupByCategory(venues: VenueSummary[]): CategoryGroup[] {
  const byCat = new Map<string, VenueSummary[]>();
  for (const venue of venues) {
    const key = venue.category || 'Other';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(venue);
  }

  const groups: CategoryGroup[] = [];
  for (const [category, items] of byCat) {
    const bySeries = new Map<string, VenueSummary[]>();
    for (const v of items) {
      const key = v.series || v.name;
      if (!bySeries.has(key)) bySeries.set(key, []);
      bySeries.get(key)!.push(v);
    }
    const series: SeriesGroup[] = [...bySeries.entries()].map(([name, vs]) => ({
      series: name,
      kind: vs[0].kind,
      count: vs.reduce((sum, v) => sum + v.count, 0),
      years: vs.slice().sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name)),
    }));
    // Conferences first, then journals; alphabetical within each.
    series.sort((a, b) =>
      (a.kind === 'journal' ? 1 : 0) - (b.kind === 'journal' ? 1 : 0) || a.series.localeCompare(b.series));
    groups.push({ category, series, count: items.reduce((sum, v) => sum + v.count, 0) });
  }
  return groups.sort((a, b) => a.category.localeCompare(b.category));
}

export function totalPaperCount(venues: VenueSummary[]): number {
  return venues.reduce((sum, v) => sum + v.count, 0);
}
