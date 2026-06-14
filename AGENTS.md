# AGENTS.md

Guidance for AI agents (and humans) working in this repository. `CLAUDE.md` points
here; this is the canonical file.

## What this project is

A pipeline that scrapes academic **conference / journal** programs and publishes a
static, searchable website (Netlify) for browsing papers. Venues are configured in
`config/venues.yaml`, scraped through pluggable adapters, enriched from bibliographic
metadata APIs, normalized to one schema, and shown in a single site with a category
**sidebar**. Enabled venues now span EDA, computer architecture, software engineering,
testing, programming languages, security/privacy, systems/networking, AI/ML, NLP, and
journals; new venues are added by config + adapter, never by changing the site.

**Stack:** a **monorepo** — a **Python** scraper (`scraper/`, package `confer`) that
emits unified JSON, consumed by an **Astro** static site (`web/`) that renders a single
page driven by a client-side script (`scripts/app.ts`) reading the embedded manifest.
The site builds to static assets deployed on Netlify.

> Status legend used below: **[now]** = exists today · **[target]** = planned, not yet
> built. Keep this file honest — when you land something, move it from **[target]** to
> **[now]**.

## Architecture

Three decoupled layers joined by one **unified `Paper` schema**:

```
config/venues.yaml ─▶ scraper + enrichers (Python) ─▶ unified JSON per venue ─▶ Astro site ─▶ Netlify
```

- **Config** names which scraper adapter a venue uses and passes only the source
  locator the adapter cannot infer, such as `program_url`, `base_url`, or `toc_url`.
- **Adapters** know one platform each and all emit the *same* `Paper` shape.
- **Enrichers** merge DOI, abstracts, publication metadata, keywords, and open-access
  links from Crossref/OpenAlex by default without changing venue-specific adapters.
- **Site** consumes only the unified data — it never knows which platform data came from.

### Layout

```
config/
  venues.yaml          [now] registry of venues to publish; read by config.py
scraper/               [now] Python project, package `confer`
  pyproject.toml       [now] console script: `confer`
  src/confer/
    cli.py             [now] `build [--venue ID] [--refresh] [--limit N]`, `list`
    config.py          [now] load + validate ../config/venues.yaml (PyYAML)
    models.py          [now] unified Paper dataclass + schema
    fetcher.py         [now] HTTP + disk cache
    paths.py           [now] cache / output path helpers
    pipeline.py        [now] per-venue orchestration
    enrichers.py       [now] Crossref/OpenAlex metadata enrichment
    export.py          [now] write web/public/data/<venue>.json + venues.json
    util.py            [now] shared helpers
    scrapers/
      __init__.py      [now] SCRAPERS registry
      aaai.py          [now] AAAI OJS archive / issue / article-detail adapter
      acl_anthology.py [now] ACL Anthology event-page adapter
      base.py          [now] Scraper ABC
      dateconf.py      [now] DATE official programme adapter
      dblp.py          [now] DBLP bibliography TOC adapter
      linklings.py     [now] DAC (Linklings program) adapter
      ndss.py          [now] NDSS accepted-paper / detail-page adapter
      openreview.py    [now] OpenReview notes API adapter
      researchr.py     [now] Researchr program / timeline / accepted-list adapter
      sigarch.py       [now] SIGARCH-style static program adapter
      ...              [target] ieee.py, acm_dl.py
  tests/fixtures/      [now] small sample of cached pages for offline parse tests
web/                   [now] Astro static site (Netlify)
  package.json  astro.config.mjs  tsconfig.json
  src/pages/index.astro    [now] the whole single-page app shell (sidebar + content)
  src/layouts/Layout.astro [now] html shell; sets theme/sidebar state before paint
  src/lib/data.ts          [now] read public/data at build (venues, generatedAt)
  src/core/            [now] framework-agnostic query core (shared with mcp/)
    text.ts            [now] searchBlob, eventList, parseAff/authorAff/instList, normKey, authorResolver, tfidfTokenize, fieldText
    query.ts           [now] Term, FIELD_ALIASES, parseQuery, matchQuery(row, terms, QueryContext)
                            ↳ QueryContext = { venueById, tagsOf? }. app.ts passes tagsOf at BOTH
                              call sites (matches + facetBase) so tag: queries work in the browser.
                              The MCP omits tagsOf by design — tag: no-ops (users have no tag store).
    similar.ts         [now] buildTfidfIndex(rows) → TfidfIndex { similar, recommend }
    insights.ts        [now] computeInsights(rows) → InsightsData, topN
    *.test.ts          [now] vitest unit tests (query/similar/insights); run: cd web && npm test
  src/scripts/
    app.ts             [now] client island: search / filter / sort / favorites / export (imports from core/)
    export.ts          [now] BibTeX + CSV serialization (also used by mcp/)
    types.ts           [now] Paper / Venue / SavedSearch types (shared with mcp/)
  src/styles/global.css    [now] Claude-style CSS + sidebar/card layout
  public/data/
    venues.json        [now] sidebar manifest (written by scraper export)
    <venue_id>.json    [now] unified papers per venue (written by scraper export)
  dist/                [now] Astro build output, gitignored (Netlify publishes it)
mcp/                   [now] MCP stdio server (TypeScript, Node 22)
  package.json         [now] name: confer-mcp; deps: @modelcontextprotocol/sdk, zod
  tsconfig.json        [now]
  src/
    corpus.ts          [now] fs loader for web/public/data/ (lazy per-venue, CONFER_DATA_DIR env)
    server.ts          [now] McpServer + StdioServerTransport; 8 tools (search, similar, stats, bibtex)
  README.md            [now] setup + Claude Desktop / Cursor config snippet
  dist/                [now] tsup bundle (gitignored); `npm run build` → dist/server.js
data/cache/            [now] cached raw HTML, gitignored. Per-venue subdirs.
netlify.toml           [now] Netlify build config (base=web, publish=dist)
```

## Unified `Paper` schema

The site consumes this shape (see `web/public/data/dac2026.json`). Generalize, do
not reinvent it. Every adapter must produce records with these keys:

```jsonc
{
  "id": "RESEARCH123",          // unique within a venue
  "title": "...",
  "abstract": "...",
  "authors": ["Jane Doe"],      // array of names
  "authorInstitutions": "...",  // display string
  "tracks": ["EDA", "Security"],
  "eventType": "Research Manuscript",
  "sessionTitles": ["..."],
  "sessions": ["sess123"],
  "dates": ["..."],
  "locations": ["..."],
  "urls": ["https://..."],
  "doi": "10.xxxx/...",          // optional publication metadata
  "publicationDate": "2026-01-01",
  "publisher": "ACM",
  "container": "Proceedings / journal name",
  "volume": "35",
  "issue": "1",
  "pages": "1-20",
  "pdfUrls": ["https://..."],
  "artifactUrls": ["https://..."],
  "keywords": ["Software engineering"],
  "extra": { }                  // optional adapter-specific passthrough; never required
}
```

Sidebar manifest `web/public/data/venues.json`:

```jsonc
{ "generatedAt": "ISO-8601", "venues": [
  { "id": "dac2026", "name": "DAC 2026", "series": "DAC", "year": 2026,
    "kind": "conference", "count": 543 }
]}
```

## Adapter contract

```python
class Scraper(ABC):
    name: str
    def __init__(self, venue: VenueConfig, fetcher: Fetcher): ...
    def scrape(self) -> list[Paper]: ...   # returns unified Papers
```

Adapters are selected by `venue.scraper` via a registry
(`SCRAPERS = {"linklings": LinklingsScraper, ...}`). **Adding a platform = one new
file in `scrapers/` + one registry entry.** Do not branch on platform anywhere else.

### How to add a venue
1. Add an entry to `config/venues.yaml` (see the seed file for fields).
2. Ensure its `scraper:` matches a registered adapter.
3. Provide only the adapter's required source locator. Tracks, event types,
   default labels, and normal metadata enrichers are inferred by the adapter and
   pipeline.
4. Run `confer build --venue <id>` and check `web/public/data/<id>.json`.

### How to add a scraper adapter
1. Create `scraper/src/confer/scrapers/<platform>.py` implementing `Scraper`.
2. Register it in `scrapers/__init__.py` `SCRAPERS`.
3. Add a fixture (a cached page) under `scraper/tests/fixtures/` and a parse test.
4. All output must already be normalized to the `Paper` schema — normalization lives
   in the adapter, not the site.

## Commands

```bash
# Scraper (run inside scraper/)
uv run confer list                       # show configured venues
uv run confer build                       # all enabled venues → web/public/data/
uv run confer build --venue dac2026       # a single venue
uv run confer build --venue date2026      # DATE official programme venue
uv run confer build --venue asplos2026    # SIGARCH-style static programme venue
uv run confer build --venue hpca2026      # Researchr accepted-list venue
uv run confer build --venue icse2026      # ICSE 2026 via Researchr
uv run confer build --venue fse2026       # Researchr detailed timeline venue
uv run confer build --venue tosem2026     # DBLP journal TOC + default metadata enrichment
uv run confer build --venue popl2026      # Researchr + default metadata enrichment
uv run confer build --refresh             # ignore cache, refetch over the network
uv run confer build --venue dac2026 --limit 5   # debug: only a few detail pages
uv run --extra dev pytest                    # offline parser tests (tests/fixtures/)

# Astro site (run inside web/)
npm install
npm run dev                       # local dev server
npm run build                     # static build → web/dist/ (what Netlify publishes)
```

## Conventions & guardrails

- **Determinism:** sort outputs (by id, then session) and serialize JSON with
  `ensure_ascii=False, indent=2, sort_keys=True`. Stable diffs matter — the data is
  committed and served.
- **Pipeline must be a pure function of source + APIs — no backfill.**
  `pipeline.py` must not read previously written output JSON to compensate for
  enrichment misses (DOI/abstract backfill). A build that depends on its own
  historical products is non-reproducible, masks real regressions, and produces
  subtly stale data. **Root-cause any enrichment miss at the right layer**: transient
  429/5xx → add retry/backoff to `Fetcher`; structural miss → fix the adapter or
  enricher match logic. The committed `Fetcher` already has exponential backoff with
  `Retry-After` support; lean on it. If a cold build cannot achieve the same quality
  as one that reads old JSON, that is a bug in the scraper/enricher, not a reason to
  add backfill.
- **Caching:** never refetch when a cache file exists unless `--refresh`. Be polite:
  reuse the shared `Fetcher`, keep a sane `User-Agent`, support `--delay`.
- **`data/cache/` is gitignored** raw HTML — do not commit it. It is regenerable and
  kept locally as the offline parser test corpus; copy a small sample into
  `tests/fixtures/` for committed tests.
- **One schema:** adapters may use the optional publication metadata keys above. If a
  source has data that still does not fit the `Paper` keys, put it in `extra`; do not
  add untyped top-level keys the site does not read.
- **Site aesthetic:** keep the minimal, Claude-like style (warm paper bg `#faf9f5`,
  clay accent `#c96442`, Source Serif 4 headings, flat thin-bordered cards). The tokens
  live in `web/src/styles/global.css`.
- **No left-edge accent bars on text/content boxes** (e.g. `border-left: … solid
  var(--accent)` on note previews, blockquotes, or read-only text areas). They look
  unfinished. Use a background tint (`var(--panel-soft)`) or spacing instead. The
  status-stripe on `.mini-card--toread/reading/done` is a deliberate *state indicator*
  on a card row and is exempt.
- **Fade fixed/scroll seams.** Any layout that pins a header, search bar, or
  toolbar over a scrolling area (modal bodies, popovers, sidebar facets, settings)
  must soften the boundary with a short (~10 px) gradient fade on the scroll
  container so rows don't clip hard against the pinned element. Use `mask-image` /
  `-webkit-mask-image` with a linear gradient from `transparent` to `#000` at both
  top and bottom edges. Never let scrolling content collide edge-to-edge with a
  sticky title or search input.
- **Favorites** are client-side `localStorage`. When multi-venue lands, key them as
  `venueId:paperId` so they do not collide across venues.
- **No backend:** the site is fully static. All filtering/search is client-side.
- **Changelog:** every bug fix, feature, or notable behaviour change must add a
  concise, user-facing one-liner to `CHANGELOG.md` under `## [Unreleased]` in the
  appropriate `### Added / Changed / Fixed` sub-section. Keep entries terse — describe
  the visible effect, not the implementation. When tagging a release, rename
  `[Unreleased]` to a version + date section (e.g. `## [1.2.0] - 2026-06-15`).

## Status

**Done:**

0. **Scaffolding** — AGENTS.md, CLAUDE.md, seed `config/venues.yaml`, untracked cache.
1. **Scraper monorepo** — `src/dac26` → `scraper/src/confer`; renamed package + console
   script (`confer`); split into `fetcher/models/config/util/paths/pipeline/export/cli`
   + `scrapers/{base,linklings}`; reads `config/venues.yaml` via PyYAML; `confer build
   --venue dac2026` reproduces 543 papers byte-for-byte; offline pytest from `tests/fixtures/`.
2. **Export + Astro site** — `export.py` writes `web/public/data/{venues.json,<venue>.json}`;
   the Astro app reads it at build, ported Claude-style CSS. Deploys on **Netlify**
   (`netlify.toml`, builds `web/`, publishes `dist/`); the old `docs/` site was removed and
   build artifacts are not committed.
3. **Single-page site** — one `index.astro` shell driven by a client island
   (`scripts/app.ts`) reading the embedded manifest; category sidebar toggles venues;
   client-side search / track + event filters / sort / per-venue favorites
   (`venueId:paperId`) / BibTeX + CSV export / saved searches.
4. **UX polish** — collapsible sidebar & filter groups (animated), responsive mobile layout
   + drawer, sidebar footer (last update, repo + commit links).
5. **Researchr venues** — `researchr` adapter parses Researchr program tables,
   detailed timelines, and accepted-paper track pages; infers paper-bearing tracks
   and event types from the linked page; fetches cached detail modals for abstracts
   and official detail URLs; and publishes ICSE 2023/2024/2025/2026,
   FSE 2023/2024/2025/2026, ASE 2023/2024/2025, ISSTA 2023/2024/2025,
   OOPSLA 2025/2026, HPCA 2026, POPL 2025/2026, and PLDI 2025/2026.
6. **DATE 2025/2026** — `dateconf` adapter parses the DATE official detailed programme,
   keeps downloadable paper rows, normalizes session metadata / author affiliations /
   PDF links, and publishes DATE 2025 and DATE 2026 alongside DAC 2025/2026.
7. **Computer architecture venues** — `sigarch` adapter parses SIGARCH-style static
   program pages with session metadata and author affiliations, including malformed
   nested institution strings seen in live pages; publishes ASPLOS 2026, ISCA 2026,
   and MICRO 2025. HPCA 2026 is published through the Researchr adapter.
8. **Publication metadata enrichment** — `enrichers.py` merges Crossref/OpenAlex data
   after the primary scrape by default, filling DOI, abstracts, publication date,
   publisher, container, volume/issue/pages, keywords, PDF/open-access links, and
   source provenance. Matching uses a broader conference-year window and can replace
   visibly truncated titles with richer bibliographic titles.
9. **DBLP journals and proceedings** — `dblp` adapter publishes TOSEM 2025/2026 and
   TSE 2025/2026 journal articles, plus security/privacy and systems/networking
   conference proceedings from DBLP TOC XML. It follows linked USENIX presentation
   pages to fill abstracts, author-affiliation display text, pages, publisher, and
   PDF links. Researchr publishes POPL 2025/2026 and PLDI 2025/2026.
10. **Official AI/NLP/security sources** — `openreview` publishes ICLR 2026,
    ICML 2025, and NeurIPS 2025 from accepted OpenReview notes; `aaai` publishes
    AAAI 2026 from the official OJS archive; `acl_anthology` publishes ACL 2025
    from ACL Anthology event pages; and `ndss` publishes NDSS 2026 from the official
    accepted-paper pages.

**Planned:**

- **More adapters** — IEEE and ACM DL for sources that are not exposed through official
  program pages, DBLP, or OpenReview. Adding a platform stays "one file in
  `scrapers/` + one registry entry".

## Tech notes

- **Scraper:** Python `>=3.10`, `uv`. Deps: `beautifulsoup4`, `requests`, and
  `PyYAML` (config is YAML, decided).
- **Site:** Astro (Node ≥ 18). Static output (`astro build`) deployed on Netlify; a single
  pre-rendered page with interactivity in a client island (`scripts/app.ts`).
- **Tests:** `pytest` in `scraper/`, driven by cached HTML in `tests/fixtures/` so they
  run offline.

## Known issues

- **iOS Safari ghost layer (unsolved).** Toggling the theme, opening/closing the
  mobile sidebar drawer, or opening a modal can leave a stale color/shadow band at
  the **bottom** of the screen until a reload. It's a Safari compositor bug: it fails
  to repaint fixed full-screen layers / the safe-area canvas when colors change or a
  layer is created/destroyed. Things tried that did **not** fully fix it: `viewport-fit=cover`
  + `env()` safe-area insets, a `theme-color` meta, JS repaint nudges (background /
  `color-scheme` / `backdrop-filter` off-for-a-frame), a real fixed `.app-bg` element,
  and switching scrim/modals from `display` toggling to `opacity`/`visibility`. We
  mirrored the Astro docs setup (no `viewport-fit=cover`; `color-scheme` keyed by
  `data-theme`) which is the cleanest baseline, but the band can still appear. Treat as
  a known Safari limitation; revisit if Safari fixes the underlying repaint behavior.
