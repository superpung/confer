#!/usr/bin/env node
/**
 * confer MCP stdio server.
 * Exposes the conference/journal paper corpus to AI agents via the
 * Model Context Protocol (https://modelcontextprotocol.io).
 *
 * Usage:  npx confer-mcp        (fetches data from confer.repus.me)
 *         node dist/server.js   (uses repo data when run from a checkout)
 * Env:    CONFER_DATA_DIR  override with a local data directory
 *         CONFER_DATA_URL  override the remote data base URL
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadManifest, venueById, venueRows, rowsFor, allRows } from './corpus.js';
import { parseQuery, matchQuery } from '../../web/src/core/query.js';
import { paperKey } from '../../web/src/core/text.js';
import { buildTfidfIndex } from '../../web/src/core/similar.js';
import { computeInsights, topN } from '../../web/src/core/insights.js';
import { toBibtex, type ExportRow } from '../../web/src/scripts/export.js';
import type { Paper } from '../../web/src/scripts/types.js';

// ---------------------------------------------------------------------------
// Lazy global TF-IDF index (built on first find_similar call)
// ---------------------------------------------------------------------------
let _tfidfIndex: ReturnType<typeof buildTfidfIndex> | null = null;
async function getTfidfIndex() {
  if (!_tfidfIndex) _tfidfIndex = buildTfidfIndex(await allRows());
  return _tfidfIndex;
}

// ---------------------------------------------------------------------------
// Result shaping helpers
// ---------------------------------------------------------------------------

/** Compact paper record for list results (omit heavy fields).
 *  Assumes loadManifest() has run so venueById is populated. */
function slim(p: Paper, v: string) {
  const venue = venueById(v);
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

/** Query context for matchQuery — venue lookup only (no user tags in MCP). */
const queryCtx = { venueById: (id: string) => venueById(id) };

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'confer',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Tool: list_venues
// ---------------------------------------------------------------------------
server.registerTool(
  'list_venues',
  {
    description: 'List all available conference/journal venues in the corpus.',
    inputSchema: z.object({
      category: z.string().optional().describe('Filter by category substring (case-insensitive).'),
      series: z.string().optional().describe('Filter by series name (e.g. "ICSE", "NeurIPS").'),
    }),
  },
  async ({ category, series }) => {
    let venues = await loadManifest();
    if (category) {
      const q = category.toLowerCase();
      venues = venues.filter((v) => v.category?.toLowerCase().includes(q));
    }
    if (series) {
      const q = series.toLowerCase();
      venues = venues.filter((v) => v.series?.toLowerCase().includes(q));
    }
    const rows = venues.map((v) => ({
      id: v.id,
      name: v.name,
      series: v.series,
      year: v.year,
      kind: v.kind,
      category: v.category,
      count: v.count,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: search_papers
// ---------------------------------------------------------------------------
server.registerTool(
  'search_papers',
  {
    description:
      'Search papers using field-aware query syntax (author:, title:, inst:, track:, ' +
      'venue:, year:, keyword:, abstract:, doi:; "-" prefix excludes). ' +
      'Returns a compact result list.',
    inputSchema: z.object({
      query: z.string().describe(
        'Query string. Examples: "author:lecun deep learning", "venue:ICSE year:2025", ' +
        '"title:\\"code review\\" -track:poster".',
      ),
      venues: z.array(z.string()).optional().describe('Restrict to these venue ids.'),
      limit: z.number().int().min(1).max(200).default(20).describe('Max results (default 20).'),
    }),
  },
  async ({ query, venues, limit }) => {
    const manifest = await loadManifest();
    const terms = parseQuery(query);
    const sources = venues && venues.length > 0 ? venues : manifest.map((v) => v.id);
    const rows = await rowsFor(sources);

    const hits = rows
      .filter((row) => matchQuery(row, terms, queryCtx))
      .slice(0, limit)
      .map(({ p, v }) => slim(p, v));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ total: hits.length, results: hits }, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_paper
// ---------------------------------------------------------------------------
server.registerTool(
  'get_paper',
  {
    description: 'Retrieve the full record for a single paper by venue id and paper id.',
    inputSchema: z.object({
      venue: z.string().describe('Venue id (e.g. "icse2025").'),
      id: z.string().describe('Paper id as found in search results.'),
    }),
  },
  async ({ venue, id }) => {
    await loadManifest();
    const papers = await venueRows(venue);
    const row = papers.find((r) => r.p.id === id);
    if (!row) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Paper ${venue}:${id} not found.` }) }],
        isError: true,
      };
    }
    const { p, v } = row;
    const vobj = venueById(v);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              venue: v,
              venueName: vobj?.name ?? v,
              year: vobj?.year ?? null,
              ...p,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: find_similar
// ---------------------------------------------------------------------------
server.registerTool(
  'find_similar',
  {
    description:
      'Find papers similar to a given paper using TF-IDF cosine similarity ' +
      '(title + abstract + keywords + tracks). Searches the full corpus.',
    inputSchema: z.object({
      venue: z.string().describe('Venue id of the seed paper.'),
      id: z.string().describe('Paper id of the seed paper.'),
      n: z.number().int().min(1).max(50).default(10).describe('Number of results (default 10).'),
    }),
  },
  async ({ venue, id, n }) => {
    await loadManifest();
    const index = await getTfidfIndex();
    const targetKey = paperKey(venue, id);
    const results = index
      .similar(targetKey, n)
      .map(({ p, v, score }) => ({ ...slim(p, v), score: Math.round(score * 1000) / 1000 }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Stats tools: top_authors / top_institutions / top_tracks
// ---------------------------------------------------------------------------

/** Shared row collection for the stats tools: optional venue + query narrowing. */
async function statsRows(venues: string[] | undefined, query: string | undefined) {
  const manifest = await loadManifest();
  const terms = query ? parseQuery(query) : [];
  const sources = venues && venues.length > 0 ? venues : manifest.map((v) => v.id);
  const all = await rowsFor(sources);
  return terms.length ? all.filter((row) => matchQuery(row, terms, queryCtx)) : all;
}

server.registerTool(
  'top_authors',
  {
    description: 'Return the most prolific authors in the corpus (or a filtered subset).',
    inputSchema: z.object({
      venues: z.array(z.string()).optional().describe('Restrict to these venue ids.'),
      query: z.string().optional().describe('Optional query to pre-filter papers.'),
      limit: z.number().int().min(1).max(100).default(20),
    }),
  },
  async ({ venues, query, limit }) => {
    const rows = await statsRows(venues, query);
    const { authorCount, authorNames } = computeInsights(rows);
    const top = topN(authorCount, limit).map(({ name: key, count }) => ({
      author: authorNames.get(key) ?? key,
      key,
      count,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(top, null, 2) }] };
  },
);

server.registerTool(
  'top_institutions',
  {
    description: 'Return the most represented institutions in the corpus (or a filtered subset).',
    inputSchema: z.object({
      venues: z.array(z.string()).optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
  },
  async ({ venues, query, limit }) => {
    const rows = await statsRows(venues, query);
    const { instCount } = computeInsights(rows);
    return { content: [{ type: 'text' as const, text: JSON.stringify(topN(instCount, limit), null, 2) }] };
  },
);

server.registerTool(
  'top_tracks',
  {
    description: 'Return the most common tracks/topics in the corpus (or a filtered subset).',
    inputSchema: z.object({
      venues: z.array(z.string()).optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
  },
  async ({ venues, query, limit }) => {
    const rows = await statsRows(venues, query);
    const { trackCount } = computeInsights(rows);
    return { content: [{ type: 'text' as const, text: JSON.stringify(topN(trackCount, limit), null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: export_bibtex
// ---------------------------------------------------------------------------
server.registerTool(
  'export_bibtex',
  {
    description: 'Export one or more papers as BibTeX entries.',
    inputSchema: z.object({
      refs: z
        .array(
          z.object({
            venue: z.string().describe('Venue id.'),
            id: z.string().describe('Paper id.'),
          }),
        )
        .min(1)
        .max(50)
        .describe('List of paper references to export.'),
    }),
  },
  async ({ refs }) => {
    await loadManifest();
    const exportRows: ExportRow[] = [];
    const missing: string[] = [];
    for (const { venue, id } of refs) {
      const papers = await venueRows(venue);
      const row = papers.find((r) => r.p.id === id);
      const vobj = venueById(venue);
      if (!row || !vobj) {
        missing.push(`${venue}:${id}`);
        continue;
      }
      exportRows.push({ paper: row.p, venue: vobj });
    }
    const bibtex = toBibtex(exportRows);
    const note = missing.length ? `\n% Not found: ${missing.join(', ')}` : '';
    return {
      content: [{ type: 'text' as const, text: bibtex + note }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
