/**
 * Build-time precompute for the confer MCP server.
 *
 * Reads the corpus and writes two static artifacts that let the corpus-wide
 * tools skip the 84 MB corpus download and the runtime TF-IDF build:
 *
 *   <data>/mcp/vectors.json — per-paper TF-IDF vectors + slim records
 *   <data>/mcp/stats.json   — global top authors / institutions / tracks
 *
 * find_similar then loads vectors.json once and scores a single query against
 * it (~one cheap cosine scan), instead of downloading every venue and building
 * the index. The vectors come from web/src/core (buildTfidfModel) and the
 * tallies from computeInsights, so results match the site exactly — no
 * approximation, since the full cosine still runs at query time.
 *
 * Run via `npm run precompute` (or `node dist/precompute.js`); the scraper's
 * `confer build` invokes it automatically. Honors CONFER_DATA_DIR (default: the
 * repo's web/public/data).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTfidfModel } from '../../web/src/core/similar.js';
import { computeInsights, topN } from '../../web/src/core/insights.js';
import type { Paper, Venue } from '../../web/src/scripts/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** How many entries to keep in each global stats list. */
const STATS_LIMIT = 100;

const DATA_DIR = process.env.CONFER_DATA_DIR
  ? resolve(process.env.CONFER_DATA_DIR)
  : resolve(__dirname, '../../web/public/data');
const OUT_DIR = join(DATA_DIR, 'mcp');

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')) as T;
}

console.error(`[precompute] reading corpus from ${DATA_DIR}`);
const t0 = Date.now();

const manifest = loadJson<{ venues: Venue[] }>('venues.json').venues;
const venueById = new Map(manifest.map((v) => [v.id, v]));

const rows: { p: Paper; v: string }[] = [];
for (const v of manifest) {
  const papers = loadJson<Paper[]>(`${v.id}.json`);
  for (const p of papers) rows.push({ p, v: v.id });
}
console.error(`[precompute] ${rows.length} papers across ${manifest.length} venues`);

/** Compact paper record — must match the MCP server's slim() shape. */
function slim(p: Paper, v: string) {
  const venue = venueById.get(v);
  return {
    venue: v,
    venueName: venue?.name ?? v,
    year: venue?.year ?? null,
    id: p.id,
    title: p.title,
    authors: p.authors,
    tracks: p.tracks,
    doi: p.doi ?? null,
    url: p.urls[0] ?? null,
  };
}

// --- TF-IDF vectors (reused from core, so they match the site exactly) -----
const { keys, vecs } = buildTfidfModel(rows);
const papers = rows.map((r) => slim(r.p, r.v));

// Intern terms to integer ids and flatten each vector to [id, weight, id, …]
// (more compact than nested arrays; weights rounded to 4 decimals).
const termId = new Map<string, number>();
const terms: string[] = [];
const vecArr: number[][] = keys.map((k) => {
  const flat: number[] = [];
  for (const [t, w] of vecs.get(k)!) {
    let id = termId.get(t);
    if (id === undefined) { id = terms.length; terms.push(t); termId.set(t, id); }
    flat.push(id, Math.round(w * 1e4) / 1e4);
  }
  return flat;
});
console.error(`[precompute] vectors: ${rows.length} papers, ${terms.length} terms`);

// --- global stats (reused from core) --------------------------------------
const insights = computeInsights(rows);
const stats = {
  version: 1,
  generatedAt: new Date().toISOString(),
  papers: rows.length,
  venues: manifest.length,
  topAuthors: topN(insights.authorCount, STATS_LIMIT).map(({ name: key, count }) => ({
    author: insights.authorNames.get(key) ?? key,
    key,
    count,
  })),
  topInstitutions: topN(insights.instCount, STATS_LIMIT),
  topTracks: topN(insights.trackCount, STATS_LIMIT),
};

// --- write artifacts ------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const vectorsDoc = { version: 1, generatedAt: new Date().toISOString(), papers, terms, vecs: vecArr };
writeFileSync(join(OUT_DIR, 'vectors.json'), JSON.stringify(vectorsDoc));
writeFileSync(join(OUT_DIR, 'stats.json'), JSON.stringify(stats));

console.error(
  `[precompute] wrote ${join(OUT_DIR, 'vectors.json')} + stats.json ` +
  `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
