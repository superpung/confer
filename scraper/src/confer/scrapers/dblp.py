"""Adapter for DBLP bibliography table-of-contents XML pages."""

from __future__ import annotations

import re
import sys
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import clean_doi, clean_text, doi_from_url, safe_slug, unique_preserve_order
from .base import Scraper


DISAMBIGUATION_RE = re.compile(r"\s+\d{4}$")
MONTHS = {
    "january": "01",
    "february": "02",
    "march": "03",
    "april": "04",
    "may": "05",
    "june": "06",
    "july": "07",
    "august": "08",
    "september": "09",
    "october": "10",
    "november": "11",
    "december": "12",
}
DEFAULT_RECORD_TYPES = ("article", "inproceedings")
DEFAULT_EXCLUDED_TITLE_PATTERNS = (
    r"^Editorial\b",
    r"^A Year in\b",
    r"^A Journal for\b",
)


class DblpScraper(Scraper):
    name = "dblp"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        toc_url = venue.source.get("toc_url") or venue.source.get("url")
        if not toc_url:
            raise ValueError(f"Venue {venue.id!r}: dblp requires source.toc_url")
        self.toc_url = str(toc_url)
        self.exclude_title_patterns = [
            re.compile(pattern, re.IGNORECASE) for pattern in DEFAULT_EXCLUDED_TITLE_PATTERNS
        ]

    def scrape(self) -> list[Paper]:
        xml = self.fetcher.get_text(self.toc_url, "toc.xml")
        papers = self.parse_toc(xml)
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} DBLP papers selected "
            f"from {len(papers)} bibliography records.",
            file=sys.stderr,
        )
        return selected

    def parse_toc(self, xml: str) -> list[Paper]:
        soup = BeautifulSoup(xml, "html.parser")
        papers: list[Paper] = []
        for record in soup.find_all(list(DEFAULT_RECORD_TYPES)):
            paper = self.parse_record(record)
            if paper is not None:
                papers.append(paper)
        return sorted(papers, key=lambda paper: paper.id)

    def parse_record(self, record: Tag) -> Paper | None:
        title = self.clean_title(clean_text(record.find("title")))
        if not title or self.is_excluded_title(title):
            return None

        ee_urls = [clean_text(ee) for ee in record.find_all("ee") if clean_text(ee)]
        dblp_url = self.dblp_url(record)
        urls = unique_preserve_order(ee_urls + [dblp_url, self.toc_url])
        doi = next((doi_from_url(url) for url in ee_urls if doi_from_url(url)), "")
        issue_title = self.issue_title(record)
        journal = clean_text(record.find("journal"))
        booktitle = clean_text(record.find("booktitle"))
        container = journal or booktitle or self.venue.name
        human_date = self.human_publication_date(record)
        publication_date = self.publication_date(record)
        track = issue_title or self.venue.name
        event_type = "Journal Article" if record.name == "article" or self.venue.kind == "journal" else "Paper"

        return Paper(
            id=safe_slug(str(record.get("key", "")) or doi or title),
            title=title,
            authors=[self.clean_author(clean_text(author)) for author in record.find_all("author")],
            tracks=[track],
            event_type=event_type,
            session_titles=[issue_title] if issue_title else [],
            dates=[human_date] if human_date else [],
            urls=urls,
            doi=clean_doi(doi),
            publication_date=publication_date,
            container=container,
            volume=clean_text(record.find("volume")),
            issue=clean_text(record.find("number")),
            pages=clean_text(record.find("pages")),
            extra={
                "dblpKey": str(record.get("key", "")),
                "dblpSource": self.toc_url,
            },
        )

    @staticmethod
    def clean_title(title: str) -> str:
        title = re.sub(r"\s+", " ", title or "").strip()
        if title.endswith(".") and not title.endswith(("?", "!")):
            title = title[:-1]
        return title

    @staticmethod
    def clean_author(author: str) -> str:
        return DISAMBIGUATION_RE.sub("", author or "").strip()

    def is_excluded_title(self, title: str) -> bool:
        return any(pattern.search(title) for pattern in self.exclude_title_patterns)

    def dblp_url(self, record: Tag) -> str:
        url = clean_text(record.find("url"))
        return urljoin("https://dblp.org/", url) if url else ""

    @staticmethod
    def issue_title(record: Tag) -> str:
        heading = record.find_previous("h2")
        return clean_text(heading) if heading else ""

    @staticmethod
    def human_publication_date(record: Tag) -> str:
        year = clean_text(record.find("year"))
        month = clean_text(record.find("month"))
        return " ".join(part for part in (month, year) if part)

    @staticmethod
    def publication_date(record: Tag) -> str:
        year = clean_text(record.find("year"))
        month = clean_text(record.find("month"))
        if year and month:
            month_number = MONTHS.get(month.lower())
            if month_number:
                return f"{year}-{month_number}-01"
        return year
