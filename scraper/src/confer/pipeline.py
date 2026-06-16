"""Orchestrate: for each venue, run its adapter and emit site data."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import VenueConfig
from .enrichers import enrich_papers
from .export import write_manifest, write_venue
from .fetcher import Fetcher
from .models import Paper
from .paths import cache_root, find_repo_root, site_data_dir
from .scrapers import get_scraper
from .util import meaningful_abstract


def build_venue(
    venue: VenueConfig,
    *,
    cache_dir: Path | None = None,
    refresh: bool = False,
    limit: int | None = None,
    workers: int = 6,
    delay: float = 0.0,
    timeout: int = 30,
) -> list[Paper]:
    base_cache = cache_dir or cache_root()
    fetcher = Fetcher(
        base_cache / venue.id,
        shared_cache_dir=base_cache / "_shared",
        refresh=refresh,
        timeout=timeout,
        delay=delay,
    )
    scraper = get_scraper(venue, fetcher, limit=limit, workers=workers)
    papers = scraper.scrape()
    papers = enrich_papers(venue, fetcher, papers)
    # Drop placeholder abstracts ("No abstract available", …) so a from-scratch
    # build is clean without depending on any previously written output.
    for paper in papers:
        paper.abstract = meaningful_abstract(paper.abstract)
    return papers


def build(
    venues: list[VenueConfig],
    *,
    out_dir: Path | None = None,
    cache_dir: Path | None = None,
    refresh: bool = False,
    limit: int | None = None,
    workers: int = 6,
    delay: float = 0.0,
    timeout: int = 30,
    update_manifest: bool = True,
    precompute: bool = True,
) -> dict[str, Any]:
    out = out_dir or site_data_dir()
    summaries: list[dict[str, Any]] = []
    counts: dict[str, int] = {}

    for venue in venues:
        papers = build_venue(
            venue,
            cache_dir=cache_dir,
            refresh=refresh,
            limit=limit,
            workers=workers,
            delay=delay,
            timeout=timeout,
        )
        path = write_venue(out, venue, papers)
        counts[venue.id] = len(papers)
        summaries.append(venue.summary(len(papers)))
        print(f"[{venue.id}] wrote {len(papers)} papers → {path}", file=sys.stderr)

    if update_manifest:
        manifest = _merge_manifest(out, summaries)
        write_manifest(out, manifest)
        print(f"manifest → {out / 'venues.json'} ({len(manifest)} venues)", file=sys.stderr)

    # Regenerate the MCP precompute artifacts (similar/stats) from the full
    # corpus in `out`. Skipped for debug builds (--limit) since their partial
    # data would corrupt the committed artifacts.
    if precompute and limit is None:
        _run_precompute(out)

    return {"counts": counts, "out_dir": str(out)}


def _run_precompute(out_dir: Path) -> None:
    """Run the MCP precompute (Node) over the freshly written corpus.

    Reuses web/src/core via mcp/dist/precompute.js. Non-fatal: if Node or the
    built script is missing, warn and skip — the data is already written and the
    MCP server falls back to live computation until the artifacts are generated.
    """
    node = shutil.which("node")
    script = find_repo_root() / "mcp" / "dist" / "precompute.js"
    if not node or not script.exists():
        print(
            "[precompute] skipped — run `cd mcp && npm install && npm run build`, "
            "then rebuild (or `cd mcp && CONFER_DATA_DIR=… npm run precompute`).",
            file=sys.stderr,
        )
        return
    env = {**os.environ, "CONFER_DATA_DIR": str(out_dir)}
    try:
        subprocess.run([node, str(script)], env=env, check=True)
    except subprocess.CalledProcessError as exc:  # pragma: no cover - build-time
        print(f"[precompute] failed (exit {exc.returncode}); artifacts may be stale.", file=sys.stderr)


def _merge_manifest(out_dir: Path, summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep manifest entries for venues we did not rebuild this run."""
    rebuilt_ids = {item["id"] for item in summaries}
    existing: list[dict[str, Any]] = []
    manifest_path = out_dir / "venues.json"
    if manifest_path.exists():
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            existing = [v for v in data.get("venues", []) if v.get("id") not in rebuilt_ids]
        except (ValueError, OSError):
            existing = []
    merged = existing + summaries
    return sorted(
        merged,
        key=lambda v: (
            str(v.get("category", "")),
            v.get("kind", ""),
            str(v.get("series", "")),
            -(v.get("year") or 0),
            v.get("id", ""),
        ),
    )
