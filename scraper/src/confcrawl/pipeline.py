"""Orchestrate: for each venue, run its adapter and emit site data."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from .config import VenueConfig
from .export import write_manifest, write_venue
from .fetcher import Fetcher
from .models import Paper
from .paths import cache_root, site_data_dir
from .scrapers import get_scraper


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
        refresh=refresh,
        timeout=timeout,
        delay=delay,
    )
    scraper = get_scraper(venue, fetcher, limit=limit, workers=workers)
    return scraper.scrape()


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

    return {"counts": counts, "out_dir": str(out)}


def _merge_manifest(out_dir: Path, summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep manifest entries for venues we did not rebuild this run."""
    import json

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
