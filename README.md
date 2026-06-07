# confcrawl

Scrape academic **conference / journal** programs into one unified schema and publish a
static, searchable website for browsing papers.

It is a config-driven, multi-venue pipeline: venues are declared in `config/venues.yaml`,
scraped through pluggable adapters, normalized to one `Paper` schema, and shown in a single
site. See **[AGENTS.md](AGENTS.md)** for the full architecture, the unified `Paper` schema,
the scraper-adapter contract, and conventions.

## Layout (monorepo)

```
config/venues.yaml   Registry of venues to scrape and publish.
scraper/             Python package `confcrawl`: fetch → parse → unified JSON.
web/                 Static site (Astro) consuming the JSON.
  public/data/       venues.json (sidebar manifest) + <venue>.json (papers).
  dist/              Astro build output, gitignored (Netlify publishes it).
data/cache/          Cached raw HTML, gitignored (regenerable; the parser test corpus).
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

An [Astro](https://astro.build) static site in `web/` renders the unified data as a
single page with a category sidebar to toggle venues and client-side search / track filter
/ sort / favorites.

```bash
cd web
npm install
npm run dev        # local dev server
npm run build      # static build → web/dist/
```

The site reads `web/public/data/` (produced by `confcrawl build`) at build time and ships
a single pre-rendered page; all filtering happens client-side. Favorites are stored in
`localStorage`, so it needs no backend.

## Deploy (Netlify)

`netlify.toml` builds the Astro site from `web/` (`base = "web"`, `npm run build`,
publish `dist`). The committed `web/public/data/*.json` is the build input, so Netlify
runs only the Astro build, not the Python scraper. Build artifacts (`web/dist/`,
`node_modules/`) are gitignored. Set `SITE_URL` in the Netlify environment for canonical
URLs once the domain is known.

To refresh the data, run `confcrawl build` locally and commit the updated JSON; Netlify
redeploys on push.
