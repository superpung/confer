"""Command-line entrypoint: ``confer build`` / ``confer list``."""

from __future__ import annotations

import argparse
import sys

from .config import load_venues, select_venues
from .pipeline import build


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="confer",
        description="Scrape configured conference/journal venues into unified site data.",
    )
    parser.add_argument("--config", help="Path to venues.yaml (default: repo config/venues.yaml).")
    sub = parser.add_subparsers(dest="command", required=True)

    build_cmd = sub.add_parser("build", help="Scrape venue(s) and write web/public/data.")
    build_cmd.add_argument("--venue", help="Only build this venue id (ignores 'enabled').")
    build_cmd.add_argument("--out-dir", help="Override output dir (default web/public/data).")
    build_cmd.add_argument("--cache-dir", help="Override cache root (default data/cache).")
    build_cmd.add_argument("--all", action="store_true", help="Include disabled venues too.")
    build_cmd.add_argument("--refresh", action="store_true", help="Ignore cached pages and refetch.")
    build_cmd.add_argument("--limit", type=int, help="Debug: cap detail pages per venue.")
    build_cmd.add_argument(
        "--no-precompute",
        action="store_true",
        help="Skip regenerating MCP precompute artifacts (web/public/data/mcp).",
    )
    build_cmd.add_argument("--workers", type=int, default=6, help="Parallel detail fetches.")
    build_cmd.add_argument("--delay", type=float, default=0.0, help="Delay before each uncached request.")
    build_cmd.add_argument("--timeout", type=int, default=30, help="HTTP timeout (seconds).")

    sub.add_parser("list", help="List configured venues.")
    return parser


def cmd_list(args: argparse.Namespace) -> int:
    from pathlib import Path

    venues = load_venues(Path(args.config) if args.config else None)
    for venue in venues:
        flag = " " if venue.enabled else "x"
        year = venue.year or "-"
        print(f"[{flag}] {venue.id:<18} {venue.scraper:<12} {year}  {venue.name}")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    from pathlib import Path

    venues = load_venues(Path(args.config) if args.config else None)
    selected = select_venues(venues, only=args.venue, include_disabled=args.all)
    if not selected:
        print("No venues to build (all disabled? use --all or --venue).", file=sys.stderr)
        return 1

    result = build(
        selected,
        out_dir=Path(args.out_dir) if args.out_dir else None,
        cache_dir=Path(args.cache_dir) if args.cache_dir else None,
        refresh=args.refresh,
        limit=args.limit,
        workers=args.workers,
        delay=args.delay,
        timeout=args.timeout,
        precompute=not args.no_precompute,
    )
    total = sum(result["counts"].values())
    print(f"Done: {total} papers across {len(result['counts'])} venue(s).", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {"build": cmd_build, "list": cmd_list}
    raise SystemExit(handlers[args.command](args))


if __name__ == "__main__":
    main()
