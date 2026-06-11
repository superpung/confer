<div align="center">

<img src="web/public/favicon.svg" width="64" alt="confer" />

# confer

**where research convenes**

A fast, searchable home for accepted papers from top conferences and journals —
browse the field, follow authors and institutions, and turn papers into insight.

**English** · [中文](README.zh-CN.md)

[**Open the live site →**](https://confer.repus.me)

</div>

---

## What is confer?

Every conference and journal publishes its accepted papers on a different site, in a
different format. **confer** gathers them into one place with a single, consistent
interface — so you can scan a whole field in minutes instead of clicking through a
dozen program pages.

It's a static website backed by a small scraping pipeline: each venue is normalized
to one shared `Paper` shape, then enriched from official detail pages and
bibliographic/open metadata sources for DOI, abstracts, publication details, and
open-access links where available. No accounts, no backend — your groups,
collections, tags and saved searches live in your browser. You can export everything
to a file, share a collection with a link, or optionally sign in with GitHub to sync
your config across devices automatically. Sync is opt-in; confer is fully usable
without any account.

## Highlights

- 🔎 **Field-aware search.** Search everything by default, then narrow with prefixes
  like `author:`, `title:`, or `inst:` and exclude terms with `-`.
- 🏷 **Authors & affiliations.** Hover an author to see their institution; click it to
  pull up every paper from that institution. Same-name authors are disambiguated in
  analytics and networks.
- 📊 **Insights panel.** Live charts of the top institutions, authors, and tracks for
  whatever is currently in view — click any bar to drill in.
- 🕸 **Relationship networks.** Explore co-author and institution networks for the
  current result set.
- ⭐ **Groups, collections & tags.** Build custom venue groups (series-level), file
  papers into named collections, tag papers freely, and save filter sets to return to
  later. Everything is local and exportable from a settings panel.
- 📤 **Selection & export.** Select papers from the list, then copy BibTeX or download
  CSV with DOI and publication metadata.
- 🔗 **Share & sync.** Share a collection or your whole setup with a link. Or sign in
  with GitHub to sync everything across devices automatically — stored in a private
  gist only you can reach. No account needed; sync is opt-in.
- ⚡ **Fast & private.** A single pre-rendered page; all filtering happens client-side.
  Light/dark themes with accent colors, keyboard shortcuts (`⌘K`, `⌘/`), and a
  responsive mobile layout.

## Venues

confer currently brings together conferences and journals across EDA, computer
architecture, software engineering, testing, programming languages, security and
privacy, systems/networking, AI/ML, and natural language processing, with more
added purely through configuration. Browse them all from the category sidebar.
The current data set includes multiple yearly editions for several venue series,
grouped by area, series, and year.

## How it works

```
config/venues.yaml ─▶ scraper + enrichers ─▶ unified JSON per venue ─▶ Astro site ─▶ static host
```

- **Config** lists venues, their primary scraper, and the minimum source URL.
- **Adapters** each understand one source platform and emit the *same* `Paper` shape;
  when source records link to official detail pages, adapters can merge those too.
- **Enrichers** merge Crossref/OpenAlex metadata such as DOI, abstract, publication
  date, volume/issue/pages, keywords, author metadata, and open-access/PDF links.
- **Site** consumes only the unified data — adding a venue never touches the UI. It
  uses the enriched metadata for search, export, disambiguation, and network views.

See **[AGENTS.md](AGENTS.md)** for the architecture, the `Paper` schema, and the
adapter contract.

## Run it yourself

**Build the data** (Python, via [uv](https://docs.astral.sh/uv/)):

```bash
cd scraper
uv run confer list                      # show configured venues
uv run confer build                     # build all enabled venues → web/public/data/
uv run confer build --venue <venue_id>  # build a single venue
uv run confer build --refresh           # ignore cache, refetch over the network
```

Each venue is cached under `data/cache/<venue_id>/`, so re-runs are offline unless you
pass `--refresh`.

**Run the site** (Astro, Node ≥ 18):

```bash
cd web
npm install
npm run dev        # local dev server
npm run build      # static build → web/dist/
```

The site reads `web/public/data/` at build time and outputs a static `dist/` you can
host anywhere. The committed JSON is the build input, so a deploy only runs the Astro
build — no Python at deploy time.

## Add a venue

1. Add an entry to `config/venues.yaml` (fields are documented inline).
2. Point its `scraper:` at a registered adapter.
3. Provide only the adapter's source locator, such as a source URL or source
   identifier. Tracks, event types, default labels, and Crossref/OpenAlex
   enrichment are inferred by the pipeline.
4. `uv run confer build --venue <id>` and check `web/public/data/<id>.json`.

To support a new platform, add an adapter under `scraper/src/confer/scrapers/` and
register it — see AGENTS.md, "How to add a scraper adapter".

## Credits

Built by [Super Lee](https://github.com/superpung) & [Claude](https://claude.com/product/claude-code).
