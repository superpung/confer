# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** for the full guide: architecture, the unified `Paper`
schema, the scraper-adapter contract, commands, and conventions.

Quick reminders:

- Scrape: `uv run dac26` (current) → `uv run confcrawl build` (target).
- Preview site: `python3 -m http.server 8000 --directory docs`.
- One unified `Paper` schema; adapters normalize, the site stays platform-agnostic.
- Keep JSON output deterministic (sorted, `sort_keys=True`); never commit `data/cache/`.
- Preserve the minimal Claude-style site aesthetic in `docs/assets/styles.css`.
