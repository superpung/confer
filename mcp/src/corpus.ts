/**
 * Corpus loader for the confer MCP server.
 *
 * Data source resolution (first match wins):
 *   1. CONFER_DATA_DIR env   → read JSON from that local directory
 *   2. repo checkout         → web/public/data sitting next to mcp/ (offline)
 *   3. otherwise             → fetch from CONFER_DATA_URL
 *                              (default https://confer.repus.me/data),
 *                              caching downloaded files under the OS temp dir
 *
 * This lets `npx confer-mcp` work with zero clone and zero local data, while a
 * repo checkout (or an explicit CONFER_DATA_DIR) stays fully offline.
 *
 * The venue manifest is tiny and loaded first, so `venueById` is synchronous
 * (the query/matchQuery layer needs a sync venue lookup); per-venue paper files
 * are loaded lazily and asynchronously.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import type { Venue, Paper } from '../../web/src/scripts/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_REMOTE = 'https://confer.repus.me/data';
const REMOTE_URL = (process.env.CONFER_DATA_URL ?? DEFAULT_REMOTE).replace(/\/+$/, '');
const CACHE_DIR = join(tmpdir(), 'confer-mcp-cache');

// Node's global fetch ignores *_PROXY env vars, which silently breaks downloads
// behind a corporate proxy. When one is configured, route through undici's
// ProxyAgent so `npx confer-mcp` works on proxied networks too.
const PROXY =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || '';
const dispatcher: Dispatcher | undefined = PROXY ? new ProxyAgent(PROXY) : undefined;

/** Resolve a local data directory, or null when remote fetch should be used. */
function resolveLocalDir(): string | null {
  if (process.env.CONFER_DATA_DIR) return resolve(process.env.CONFER_DATA_DIR);
  // When running from a repo checkout, the bundled site data sits next to mcp/.
  const repoData = resolve(__dirname, '../../web/public/data');
  if (existsSync(join(repoData, 'venues.json'))) return repoData;
  return null;
}

const LOCAL_DIR = resolveLocalDir();

/** Human-readable description of where data is coming from (for diagnostics). */
export const DATA_SOURCE = LOCAL_DIR ? `local:${LOCAL_DIR}` : `remote:${REMOTE_URL}`;

/** Load and parse a JSON file by name — from the local dir, or remote (cached). */
async function loadJson<T>(filename: string): Promise<T> {
  if (LOCAL_DIR) {
    return JSON.parse(readFileSync(join(LOCAL_DIR, filename), 'utf-8')) as T;
  }
  // Remote: serve from the on-disk cache when present.
  const cached = join(CACHE_DIR, filename);
  if (existsSync(cached)) {
    return JSON.parse(readFileSync(cached, 'utf-8')) as T;
  }
  const res = await undiciFetch(`${REMOTE_URL}/${filename}`, dispatcher ? { dispatcher } : {});
  if (!res.ok) throw new Error(`Failed to fetch ${filename} from ${REMOTE_URL}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, text);
  } catch {
    // Cache is best-effort; ignore write failures (e.g. read-only temp dir).
  }
  return JSON.parse(text) as T;
}

// --------------------------------------------------------------------------
// Venue manifest (loaded once; powers the synchronous venueById lookup)
// --------------------------------------------------------------------------

interface VenuesManifest {
  generatedAt: string;
  venues: Venue[];
}

let _manifest: Venue[] | null = null;
let _venueById = new Map<string, Venue>();

/** Load the venue manifest (cached). Every tool handler awaits this first,
 *  which is what makes the synchronous `venueById` below safe to call. */
export async function loadManifest(): Promise<Venue[]> {
  if (_manifest) return _manifest;
  const raw = await loadJson<VenuesManifest>('venues.json');
  _manifest = raw.venues;
  _venueById = new Map(_manifest.map((v) => [v.id, v]));
  return _manifest;
}

/** Synchronous venue lookup. Requires `loadManifest()` to have run first. */
export function venueById(id: string): Venue | undefined {
  return _venueById.get(id);
}

// --------------------------------------------------------------------------
// Per-venue paper loading (lazy, async, cached)
// --------------------------------------------------------------------------

const _paperCache = new Map<string, Paper[]>();

/** Load all papers for a venue id (cached). */
export async function loadVenue(id: string): Promise<Paper[]> {
  const hit = _paperCache.get(id);
  if (hit) return hit;
  const papers = await loadJson<Paper[]>(`${id}.json`);
  _paperCache.set(id, papers);
  return papers;
}

/** Rows for a single venue. */
export async function venueRows(id: string): Promise<{ p: Paper; v: string }[]> {
  return (await loadVenue(id)).map((p) => ({ p, v: id }));
}

/** Rows for many venues, fetched in parallel and flattened in input order. */
export async function rowsFor(ids: string[]): Promise<{ p: Paper; v: string }[]> {
  const perVenue = await Promise.all(ids.map((id) => venueRows(id)));
  const rows: { p: Paper; v: string }[] = [];
  for (const vr of perVenue) for (const row of vr) rows.push(row);
  return rows;
}

/** All rows across all venues (loads the entire corpus; ~84 MB in process). */
export async function allRows(): Promise<{ p: Paper; v: string }[]> {
  const manifest = await loadManifest();
  return rowsFor(manifest.map((v) => v.id));
}

// --------------------------------------------------------------------------
// Precomputed artifacts (web/public/data/mcp/, written by `npm run precompute`)
// Optional: when absent, callers fall back to live computation over the corpus.
// --------------------------------------------------------------------------

/** Compact paper record, aligned to the vectors file (matches server slim()). */
export interface SlimPaper {
  venue: string;
  venueName: string;
  year: number | null;
  id: string;
  title: string;
  authors: string[];
  tracks: string[];
  doi: string | null;
  url: string | null;
}

/** Precomputed TF-IDF vectors for the whole corpus, ready for cosine scoring. */
export interface VectorData {
  /** Slim records, index-aligned to `vecs`. */
  papers: SlimPaper[];
  /** termId → term string (interning dictionary; unused at query time). */
  terms: string[];
  /** Flat [termId, weight, termId, weight, …] per paper, index-aligned to `papers`. */
  vecs: number[][];
  /** "venue:id" → index. */
  keyToIdx: Map<string, number>;
}

export interface StatsData {
  topAuthors: { author: string; key: string; count: number }[];
  topInstitutions: { name: string; count: number }[];
  topTracks: { name: string; count: number }[];
}

// undefined = not yet attempted, null = confirmed absent (use live fallback).
let _vectors: VectorData | null | undefined;
let _stats: StatsData | null | undefined;

/** Load precomputed TF-IDF vectors, or null when the artifact is unavailable. */
export async function loadVectors(): Promise<VectorData | null> {
  if (_vectors !== undefined) return _vectors;
  try {
    const raw = await loadJson<Omit<VectorData, 'keyToIdx'>>('mcp/vectors.json');
    const keyToIdx = new Map<string, number>();
    raw.papers.forEach((p, i) => keyToIdx.set(`${p.venue}:${p.id}`, i));
    _vectors = { ...raw, keyToIdx };
  } catch {
    _vectors = null;
  }
  return _vectors;
}

/** Load precomputed global stats, or null when the artifact is unavailable. */
export async function loadStats(): Promise<StatsData | null> {
  if (_stats !== undefined) return _stats;
  try {
    _stats = await loadJson<StatsData>('mcp/stats.json');
  } catch {
    _stats = null;
  }
  return _stats;
}
