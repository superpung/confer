# AGENTS.md

Guidance for AI agents (and humans) working in this repository. `CLAUDE.md` points
here; this is the canonical file.

## What this project is

A pipeline that scrapes academic **conference / journal** programs and publishes a
static, searchable website (GitHub Pages) for browsing papers. It started as a
single-purpose scraper for **DAC 2026** and is being generalized so that any number
of venues can be configured, scraped through pluggable adapters, normalized to one
schema, and shown in a single site with a venue **sidebar**.

**Stack (decided):** a **monorepo** — a **Python** scraper (`scraper/`, package
`confcrawl`) that emits unified JSON, consumed by an **Astro** static site (`web/`)
that pre-renders one page per venue and uses client-side islands for search/filter.
Both build to static assets deployed on GitHub Pages. The repo's local directory name
stays `dac26` (do not rename the working path).

> Status legend used below: **[now]** = exists today · **[target]** = the architecture
> we are migrating toward. Keep this file honest — when you land a phase, move items
> from **[target]** to **[now]**.

## Architecture

Three decoupled layers joined by one **unified `Paper` schema**:

```
config/venues.yaml ─▶ scraper (Python) ─▶ unified JSON per venue ─▶ Astro site ─▶ Pages
```

- **Config** names which scraper adapter a venue uses and passes it source options.
- **Adapters** know one platform each and all emit the *same* `Paper` shape.
- **Site** consumes only the unified data — it never knows which platform data came from.

### Layout (target = Astro monorepo)

```
config/
  venues.yaml          [now] registry of venues to publish (seed; not yet consumed)
scraper/               [target] Python project (moved + renamed from src/dac26)
  pyproject.toml
  src/confcrawl/
    cli.py             [target] `build [--venue ID] [--refresh]`, `list`
    config.py          [target] load + validate ../config/venues.yaml
    models.py          [target] unified Paper dataclass + schema
    fetcher.py         [target] HTTP + disk cache (extracted from scrape.py)
    pipeline.py        [target] per-venue orchestration
    export.py          [target] write web/public/data/<venue>.json + venues.json
    scrapers/
      base.py          [target] Scraper ABC + SCRAPERS registry
      linklings.py     [target] current DAC logic, refactored to the interface
      ...              [target] openreview.py, dblp.py, ieee.py, acm_dl.py
  tests/fixtures/      [target] small sample of cached pages for offline parse tests
web/                   [now] Astro static site (GitHub Pages)
  package.json  astro.config.mjs  tsconfig.json
  src/pages/
    index.astro        [now] redirects to the first venue
    [venue].astro      [now] SSG one static page per venue + client filter/sort/favorites
  src/layouts/Base.astro   [now] html shell + sidebar
  src/components/      [now] Sidebar.astro, PaperCard.astro
  src/lib/             [now] data.ts (read public/data at build), url.ts (base helper)
  src/styles/global.css    [now] ported Claude-style CSS + sidebar layout
  public/data/
    venues.json        [now] sidebar manifest (written by scraper export)
    <venue_id>.json    [now] unified papers per venue (written by scraper export)
data/cache/            [now] cached raw HTML, gitignored. Per-venue subdirs.

# [now] still present: superseded but not yet removed —
docs/                  old hand-built site; remove once Pages deploys the Astro build
```

## Unified `Paper` schema

The site already consumes this shape (see `docs/data/papers.json`). Generalize, do
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
3. Run `confcrawl build --venue <id>` and check `web/public/data/<id>.json`.

### How to add a scraper adapter
1. Create `scraper/src/confcrawl/scrapers/<platform>.py` implementing `Scraper`.
2. Register it in `scrapers/base.py` `SCRAPERS`.
3. Add a fixture (a cached page) under `scraper/tests/fixtures/` and a parse test.
4. All output must already be normalized to the `Paper` schema — normalization lives
   in the adapter, not the site.

## Commands

```bash
# [now] current DAC scraper (until Phase 1 lands)
uv run dac26                      # full crawl → data/dac2026_*.{json,csv}
uv run dac26 --limit 5            # debug: only a few detail pages
uv run dac26 --all-presentations  # every presentation type, not just RESEARCH
uv run dac26 --refresh            # ignore cache, refetch

# [target] generalized scraper (run inside scraper/)
uv run confcrawl build            # all enabled venues → web/public/data/
uv run confcrawl build --venue dac2026
uv run confcrawl list

# [now] Astro site (run inside web/)
npm install
npm run dev                       # local dev server
npm run build                     # static build → web/dist/
BASE_PATH=/dac26 npm run build    # build for GitHub Project Pages (/<repo>/ prefix)
```

## Conventions & guardrails

- **Determinism:** sort outputs (by id, then session) and serialize JSON with
  `ensure_ascii=False, indent=2, sort_keys=True`. Stable diffs matter — the data is
  committed and served.
- **Caching:** never refetch when a cache file exists unless `--refresh`. Be polite:
  reuse the shared `Fetcher`, keep a sane `User-Agent`, support `--delay`.
- **`data/cache/` is gitignored** raw HTML — do not commit it. It is regenerable and
  kept locally as the offline parser test corpus; copy a small sample into
  `tests/fixtures/` for committed tests.
- **One schema:** if an adapter has data that does not fit the `Paper` keys, put it in
  `extra`, do not add top-level keys the site does not read.
- **Site aesthetic:** keep the minimal, Claude-like style (warm paper bg `#faf9f5`,
  clay accent `#c96442`, Source Serif 4 headings, flat thin-bordered cards). Carry these
  tokens into the Astro site's global CSS when porting from `docs/assets/styles.css`.
- **Favorites** are client-side `localStorage`. When multi-venue lands, key them as
  `venueId:paperId` so they do not collide across venues.
- **No backend:** the site is fully static. All filtering/search is client-side.

## Migration phases

0. **Scaffolding** — AGENTS.md, CLAUDE.md, seed `config/venues.yaml`, untrack cache.
   *(done)*
1. **Scraper monorepo + rename** — *(done)* moved `src/dac26` → `scraper/src/confcrawl`;
   renamed package + console script (`confcrawl`); split into `fetcher/models/config/
   util/paths/pipeline/export/cli` + `scrapers/{base,linklings}`; reads
   `config/venues.yaml` via PyYAML; `confcrawl build --venue dac2026` reproduces today's
   543 papers byte-for-byte; offline pytest from `tests/fixtures/`.
2. **Export + Astro site** — *(done)* `export.py` writes `web/public/data/{venues.json,
   <venue>.json}`; Astro app scaffolded: `index.astro` (redirect), `[venue].astro` (SSG
   per venue), `Sidebar`/`PaperCard`, ported Claude-style CSS, sidebar venue switching,
   client-side search/track/sort + per-venue favorites (`venueId:paperId`). Client
   interactivity is plain inlined `<script>` (no framework island needed). **Open:** wire
   GitHub Pages deployment (Action vs build into `docs/`) and retire the old `docs/` site.
3. **Second adapter** — OpenReview (clean JSON API), to validate generality.
4. **UX polish** — a dedicated favorites view, deep links within a venue, mobile drawer.

## Tech notes

- **Scraper:** Python `>=3.10`, `uv`. Deps: `beautifulsoup4`, `requests`, and
  `PyYAML` (config is YAML, decided).
- **Site:** Astro (Node ≥ 18). Static output (`astro build`) for GitHub Pages; one
  pre-rendered page per venue, interactivity via a client island.
- **Tests:** `pytest` in `scraper/`, driven by cached HTML in `tests/fixtures/` so they
  run offline.
- The repo's local path stays `dac26`; only package/file *names* change, not the
  working directory.
