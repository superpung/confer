# confcrawl

Scrape academic **conference / journal** programs into one unified schema and publish a
static, searchable website for browsing papers.

The project started as a single-purpose DAC 2026 scraper and is being generalized into a
config-driven, multi-venue pipeline. See **[AGENTS.md](AGENTS.md)** for the full
architecture, the unified `Paper` schema, the scraper-adapter contract, and conventions.

## Layout (monorepo)

```
config/venues.yaml   Registry of venues to scrape and publish.
scraper/             Python package `confcrawl`: fetch → parse → unified JSON.
web/                 Static site (Astro — Phase 2) consuming the JSON.
  public/data/       venues.json (sidebar manifest) + <venue>.json (papers).
data/cache/          Cached raw HTML, gitignored (regenerable; the parser test corpus).
docs/                Current hand-built site (being replaced by web/).
```

## Scrape

Run inside `scraper/` (uses [uv](https://docs.astral.sh/uv/)):

```bash
cd scraper

uv run confcrawl list                    # show configured venues
uv run confcrawl build                    # build all enabled venues → web/public/data/
uv run confcrawl build --venue dac2026     # build a single venue
uv run confcrawl build --refresh           # ignore cache, refetch over the network
uv run confcrawl build --venue dac2026 --limit 5   # debug: only a few detail pages
```

Each venue is cached under `data/cache/<venue_id>/`, so re-runs are offline unless you
pass `--refresh`.

### Tests

```bash
cd scraper
uv run --extra dev pytest        # offline, drives parsers from tests/fixtures/
```

## Add a venue

1. Add an entry to `config/venues.yaml` (see the comments there for the fields).
2. Point `scraper:` at a registered adapter (currently `linklings`).
3. `uv run confcrawl build --venue <id>` and check `web/public/data/<id>.json`.

To support a new platform, add an adapter under
`scraper/src/confcrawl/scrapers/` implementing the `Scraper` interface and register it —
see AGENTS.md "How to add a scraper adapter".

## Website

An [Astro](https://astro.build) static site in `web/` renders the unified data, with a
sidebar to switch venues and client-side search / track filter / sort / favorites.

```bash
cd web
npm install
npm run dev        # local dev server
npm run build      # static build → web/dist/
```

The site reads `web/public/data/` (produced by `confcrawl build`) and pre-renders one
page per venue. Favorites are stored client-side in `localStorage`, so it needs no
backend and deploys to GitHub Pages as static files. For GitHub Project Pages (served at
`/<repo>/`), build with `BASE_PATH=/dac26 npm run build`.

> The old hand-built site under `docs/` is superseded by `web/` and will be removed once
> Pages deploys the Astro build.
