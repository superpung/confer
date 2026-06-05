"""Load and validate the venue registry (``config/venues.yaml``)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .paths import config_path


@dataclass
class VenueConfig:
    id: str
    name: str
    series: str = ""
    category: str = "Other"
    kind: str = "conference"
    year: int | None = None
    scraper: str = ""
    enabled: bool = True
    source: dict[str, Any] = field(default_factory=dict)

    def summary(self, count: int) -> dict[str, Any]:
        """The per-venue entry used by the site's ``venues.json`` manifest."""
        return {
            "id": self.id,
            "name": self.name,
            "series": self.series or self.name,
            "category": self.category or "Other",
            "year": self.year,
            "kind": self.kind,
            "count": count,
        }


_KNOWN_KEYS = {"id", "name", "series", "category", "kind", "year", "scraper", "enabled", "source"}


def _coerce(entry: dict[str, Any]) -> VenueConfig:
    if "id" not in entry or "name" not in entry:
        raise ValueError(f"Venue entry missing required 'id'/'name': {entry!r}")
    unknown = set(entry) - _KNOWN_KEYS
    if unknown:
        raise ValueError(f"Venue {entry['id']!r} has unknown keys: {sorted(unknown)}")
    return VenueConfig(**{key: entry[key] for key in _KNOWN_KEYS if key in entry})


def load_venues(path: Path | None = None) -> list[VenueConfig]:
    config_file = path or config_path()
    if not config_file.exists():
        raise FileNotFoundError(f"Venue config not found: {config_file}")
    data = yaml.safe_load(config_file.read_text(encoding="utf-8")) or {}
    venues = data.get("venues")
    if not isinstance(venues, list):
        raise ValueError(f"{config_file}: expected a top-level 'venues:' list")
    return [_coerce(entry) for entry in venues]


def select_venues(
    venues: list[VenueConfig],
    *,
    only: str | None = None,
    include_disabled: bool = False,
) -> list[VenueConfig]:
    if only is not None:
        matched = [venue for venue in venues if venue.id == only]
        if not matched:
            available = ", ".join(venue.id for venue in venues)
            raise ValueError(f"No venue with id {only!r}. Known: {available}")
        return matched
    if include_disabled:
        return list(venues)
    return [venue for venue in venues if venue.enabled]
