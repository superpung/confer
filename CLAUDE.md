# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** for the full guide: architecture, the unified `Paper`
schema, the scraper-adapter contract, commands, and conventions.

Quick reminders:

- Scrape: `cd scraper && uv run confcrawl build` (use `--venue <id>`, `--refresh`, `--limit N`).
- Preview site: `cd web && npm run dev` (or `npm run build` then serve `web/dist/`).
- One unified `Paper` schema; adapters normalize, the site stays platform-agnostic.
- Keep JSON output deterministic (sorted, `sort_keys=True`); never commit `data/cache/`.
- Preserve the minimal Claude-style site aesthetic in `web/src/styles/global.css`.
