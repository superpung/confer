"""Adapter for OpenReview accepted-paper note lists."""

from __future__ import annotations

import json
import sys
from typing import Any
from urllib.parse import urlencode, urljoin

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import cache_name_for_url, safe_slug, unique_preserve_order
from .base import Scraper


API_URL = "https://api2.openreview.net/notes"
OPENREVIEW_BASE = "https://openreview.net"
SERIES_DOMAINS = {
    "ICLR": "ICLR.cc",
    "ICML": "ICML.cc",
    "NeurIPS": "NeurIPS.cc",
}


class OpenReviewScraper(Scraper):
    name = "openreview"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        self.api_url = str(venue.source.get("api_url") or API_URL)
        self.venue_id = str(venue.source.get("venue_id") or self.default_venue_id())
        self.page_size = int(venue.source.get("page_size") or 1000)

    def default_venue_id(self) -> str:
        domain = SERIES_DOMAINS.get(self.venue.series)
        if not domain or not self.venue.year:
            raise ValueError(f"Venue {self.venue.id!r}: openreview requires source.venue_id")
        return f"{domain}/{self.venue.year}/Conference"

    def scrape(self) -> list[Paper]:
        notes = self.fetch_notes()
        papers = [self.note_to_paper(note) for note in notes]
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} OpenReview papers selected "
            f"from {len(papers)} notes.",
            file=sys.stderr,
        )
        return sorted(selected, key=lambda paper: paper.id)

    def fetch_notes(self) -> list[dict[str, Any]]:
        notes: list[dict[str, Any]] = []
        offset = 0
        while True:
            params = {
                "content.venueid": self.venue_id,
                "limit": str(self.page_size),
                "offset": str(offset),
            }
            url = f"{self.api_url}?{urlencode(params)}"
            text = self.fetcher.get_text(url, f"notes/{cache_name_for_url(url, '.json')}")
            page_notes = json.loads(text).get("notes", [])
            if not isinstance(page_notes, list):
                break
            notes.extend(page_notes)
            if self.limit and len(notes) >= self.limit:
                break
            if len(page_notes) < self.page_size:
                break
            offset += self.page_size
            print(f"[{self.venue.id}] openreview fetched {len(notes)} notes...", file=sys.stderr)
        return notes

    def note_to_paper(self, note: dict[str, Any]) -> Paper:
        content = note.get("content") or {}
        note_id = str(note.get("id") or note.get("forum") or "")
        venue_label = text_value(content.get("venue"))
        primary_area = text_value(content.get("primary_area"))
        pdf = text_value(content.get("pdf"))
        supplementary = text_value(content.get("supplementary_material"))
        forum_url = f"{OPENREVIEW_BASE}/forum?id={note.get('forum') or note_id}" if note_id else ""
        urls = unique_preserve_order([forum_url])
        pdf_urls = unique_preserve_order([urljoin(OPENREVIEW_BASE, pdf)] if pdf else [])
        artifact_urls = unique_preserve_order([urljoin(OPENREVIEW_BASE, supplementary)] if supplementary else [])

        extra: dict[str, Any] = {
            "openreviewId": note_id,
            "openreviewVenueId": self.venue_id,
        }
        tldr = text_value(content.get("TLDR"))
        if tldr:
            extra["tldr"] = tldr

        return Paper(
            id=safe_slug(note_id or text_value(content.get("title"))),
            title=text_value(content.get("title")),
            abstract=text_value(content.get("abstract")),
            authors=list_value(content.get("authors")),
            author_ids=list_value(content.get("authorids")),
            tracks=[primary_area] if primary_area else [],
            event_type=venue_label or "Paper",
            session_titles=[venue_label] if venue_label else [],
            dates=[str(self.venue.year)] if self.venue.year else [],
            urls=urls,
            pdf_urls=pdf_urls,
            artifact_urls=artifact_urls,
            keywords=list_value(content.get("keywords")),
            extra=extra,
        )


def text_value(value: Any) -> str:
    if isinstance(value, dict) and "value" in value:
        return text_value(value["value"])
    if isinstance(value, list):
        return ", ".join(str(item) for item in value if item)
    return str(value or "").strip()


def list_value(value: Any) -> list[str]:
    if isinstance(value, dict) and "value" in value:
        return list_value(value["value"])
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value or "").strip()
    return [text] if text else []
