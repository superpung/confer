import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('public/data');

export interface VenueSummary {
  id: string;
  name: string;
  series: string;
  category: string;
  year: number | null;
  kind: string;
  count: number;
}

export interface CategoryGroup {
  category: string;
  conferences: VenueSummary[];
  journals: VenueSummary[];
  count: number;
}

export function loadVenues(): VenueSummary[] {
  const file = path.join(DATA_DIR, 'venues.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return (raw.venues ?? []) as VenueSummary[];
}

/** ISO timestamp of the last scrape, recorded in venues.json. */
export function loadGeneratedAt(): string | null {
  const file = path.join(DATA_DIR, 'venues.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return (raw.generatedAt as string) ?? null;
}

/** Group venues by research category, splitting conferences and journals. */
export function groupByCategory(venues: VenueSummary[]): CategoryGroup[] {
  const byCat = new Map<string, VenueSummary[]>();
  for (const venue of venues) {
    const key = venue.category || 'Other';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(venue);
  }
  const sortVenues = (a: VenueSummary, b: VenueSummary) =>
    (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name);

  return [...byCat.entries()]
    .map(([category, items]) => ({
      category,
      conferences: items.filter((v) => v.kind !== 'journal').sort(sortVenues),
      journals: items.filter((v) => v.kind === 'journal').sort(sortVenues),
      count: items.reduce((sum, v) => sum + v.count, 0),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export function totalPaperCount(venues: VenueSummary[]): number {
  return venues.reduce((sum, v) => sum + v.count, 0);
}
