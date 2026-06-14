/**
 * Corpus loader for the confer MCP server.
 * Reads data from ../web/public/data/ (or CONFER_DATA_DIR env).
 * Venues are lazy-loaded on first access and cached in-process.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Venue, Paper } from '../../web/src/scripts/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the data directory. Override via CONFER_DATA_DIR env var. */
export const DATA_DIR = process.env.CONFER_DATA_DIR
  ? resolve(process.env.CONFER_DATA_DIR)
  : resolve(__dirname, '../../web/public/data');

/** Load and parse a JSON file from the data directory. */
function loadJson<T>(filename: string): T {
  return JSON.parse(readFileSync(resolve(DATA_DIR, filename), 'utf-8')) as T;
}

// --------------------------------------------------------------------------
// Venue manifest
// --------------------------------------------------------------------------

interface VenuesManifest {
  generatedAt: string;
  venues: Venue[];
}

let _manifest: Venue[] | null = null;

/** All venues from the manifest, sorted by year desc then name. */
export function loadManifest(): Venue[] {
  if (_manifest) return _manifest;
  const raw = loadJson<VenuesManifest>('venues.json');
  _manifest = raw.venues;
  return _manifest;
}

/** Fast lookup: venue id → Venue. */
let _venueById: Map<string, Venue> | null = null;
export function venueById(id: string): Venue | undefined {
  if (!_venueById) _venueById = new Map(loadManifest().map((v) => [v.id, v]));
  return _venueById.get(id);
}

// --------------------------------------------------------------------------
// Per-venue paper loading (lazy)
// --------------------------------------------------------------------------

const _paperCache = new Map<string, Paper[]>();

/** Load all papers for a venue id (cached). */
export function loadVenue(id: string): Paper[] {
  if (_paperCache.has(id)) return _paperCache.get(id)!;
  const papers = loadJson<Paper[]>(`${id}.json`);
  _paperCache.set(id, papers);
  return papers;
}

/** Rows for a single venue. */
export function venueRows(id: string): { p: Paper; v: string }[] {
  return loadVenue(id).map((p) => ({ p, v: id }));
}

/** All rows across all venues (loads entire corpus — ~100 MB in process). */
export function allRows(): { p: Paper; v: string }[] {
  const manifest = loadManifest();
  const rows: { p: Paper; v: string }[] = [];
  for (const venue of manifest) {
    for (const p of loadVenue(venue.id)) rows.push({ p, v: venue.id });
  }
  return rows;
}
