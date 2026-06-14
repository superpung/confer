/**
 * confer MCP stdio server.
 * Exposes the conference/journal paper corpus to AI agents via the
 * Model Context Protocol (https://modelcontextprotocol.io).
 *
 * Usage: node dist/server.js
 * Config: CONFER_DATA_DIR (optional) overrides the default data path.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadManifest, venueById, venueRows, allRows } from './corpus.js';
import { parseQuery, matchQuery } from '../../web/src/core/query.js';
import { paperKey } from '../../web/src/core/text.js';
import { buildTfidfIndex } from '../../web/src/core/similar.js';
import { computeInsights, topN } from '../../web/src/core/insights.js';
import { toBibtex, type ExportRow } from '../../web/src/scripts/export.js';
import type { Paper, Venue } from '../../web/src/scripts/types.js';

// ---------------------------------------------------------------------------
// Lazy global TF-IDF index (built on first find_similar / top_* call)
// ---------------------------------------------------------------------------
let _tfidfIndex: ReturnType<typeof buildTfidfIndex> | null = null;
function getTfidfIndex() {
  if (!_tfidfIndex) _tfidfIndex = buildTfidfIndex(allRows());
  return _tfidfIndex;
}

// ---------------------------------------------------------------------------
// Result shaping helpers
// ---------------------------------------------------------------------------

/** Compact paper record for list results (omit heavy fields). */
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
    let venues = loadManifest();
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
      'venue:, year:, keyword:, abstract:, tag:, doi:; "-" prefix excludes). ' +
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
    const terms = parseQuery(query);
    const ctx = { venueById: (id: string) => venueById(id) };

    // Determine row source: specific venues or all
    const sources = venues && venues.length > 0 ? venues : loadManifest().map((v) => v.id);
    const rows: { p: Paper; v: string }[] = [];
    for (const vid of sources) {
      for (const row of venueRows(vid)) rows.push(row);
    }

    const hits = rows
      .filter((row) => matchQuery(row, terms, ctx))
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
    const papers = venueRows(venue);
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
    const targetKey = paperKey(venue, id);
    const results = getTfidfIndex()
      .similar(targetKey, n)
      .map(({ p, v, score }) => ({ ...slim(p, v), score: Math.round(score * 1000) / 1000 }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: top_authors
// ---------------------------------------------------------------------------
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
    const terms = query ? parseQuery(query) : [];
    const ctx = { venueById: (id: string) => venueById(id) };
    const sources = venues && venues.length > 0 ? venues : loadManifest().map((v) => v.id);
    const rows: { p: Paper; v: string }[] = [];
    for (const vid of sources) {
      for (const row of venueRows(vid)) {
        if (!terms.length || matchQuery(row, terms, ctx)) rows.push(row);
      }
    }
    const { authorCount, authorNames } = computeInsights(rows);
    const top = topN(authorCount, limit).map(({ name: key, count }) => ({
      author: authorNames.get(key) ?? key,
      key,
      count,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(top, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: top_institutions
// ---------------------------------------------------------------------------
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
    const terms = query ? parseQuery(query) : [];
    const ctx = { venueById: (id: string) => venueById(id) };
    const sources = venues && venues.length > 0 ? venues : loadManifest().map((v) => v.id);
    const rows: { p: Paper; v: string }[] = [];
    for (const vid of sources) {
      for (const row of venueRows(vid)) {
        if (!terms.length || matchQuery(row, terms, ctx)) rows.push(row);
      }
    }
    const { instCount } = computeInsights(rows);
    const top = topN(instCount, limit);
    return { content: [{ type: 'text' as const, text: JSON.stringify(top, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: top_tracks
// ---------------------------------------------------------------------------
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
    const terms = query ? parseQuery(query) : [];
    const ctx = { venueById: (id: string) => venueById(id) };
    const sources = venues && venues.length > 0 ? venues : loadManifest().map((v) => v.id);
    const rows: { p: Paper; v: string }[] = [];
    for (const vid of sources) {
      for (const row of venueRows(vid)) {
        if (!terms.length || matchQuery(row, terms, ctx)) rows.push(row);
      }
    }
    const { trackCount } = computeInsights(rows);
    const top = topN(trackCount, limit);
    return { content: [{ type: 'text' as const, text: JSON.stringify(top, null, 2) }] };
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
    const exportRows: ExportRow[] = [];
    const missing: string[] = [];
    for (const { venue, id } of refs) {
      const papers = venueRows(venue);
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
