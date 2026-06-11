"""Scraper-adapter registry.

To add a platform: implement a :class:`~confer.scrapers.base.Scraper`
subclass in this package and register it here under its ``venue.scraper`` key.
"""

from __future__ import annotations

from ..config import VenueConfig
from ..fetcher import Fetcher
from .aaai import AaaiScraper
from .acl_anthology import AclAnthologyScraper
from .base import Scraper
from .dateconf import DateConfScraper
from .dblp import DblpScraper
from .linklings import LinklingsScraper
from .ndss import NdssScraper
from .openreview import OpenReviewScraper
from .researchr import ResearchrScraper
from .sigarch import SigarchScraper


SCRAPERS: dict[str, type[Scraper]] = {
    AaaiScraper.name: AaaiScraper,
    AclAnthologyScraper.name: AclAnthologyScraper,
    DateConfScraper.name: DateConfScraper,
    DblpScraper.name: DblpScraper,
    LinklingsScraper.name: LinklingsScraper,
    NdssScraper.name: NdssScraper,
    OpenReviewScraper.name: OpenReviewScraper,
    ResearchrScraper.name: ResearchrScraper,
    SigarchScraper.name: SigarchScraper,
}


def get_scraper(venue: VenueConfig, fetcher: Fetcher, **kwargs) -> Scraper:
    try:
        cls = SCRAPERS[venue.scraper]
    except KeyError:
        known = ", ".join(sorted(SCRAPERS)) or "(none)"
        raise ValueError(
            f"Venue {venue.id!r} uses unknown scraper {venue.scraper!r}. Known: {known}"
        ) from None
    return cls(venue, fetcher, **kwargs)


__all__ = ["SCRAPERS", "Scraper", "get_scraper"]
