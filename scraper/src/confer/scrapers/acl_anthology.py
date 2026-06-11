"""Adapter for ACL Anthology event pages."""

from __future__ import annotations

import re
import sys
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import clean_text, safe_slug, unique_preserve_order
from .base import Scraper


class AclAnthologyScraper(Scraper):
    name = "acl_anthology"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        self.event_url = str(venue.source.get("event_url") or self.default_event_url())

    def default_event_url(self) -> str:
        if not self.venue.year:
            raise ValueError(f"Venue {self.venue.id!r}: acl_anthology requires source.event_url")
        return f"https://aclanthology.org/events/acl-{self.venue.year}/"

    def scrape(self) -> list[Paper]:
        html = self.fetcher.get_text(self.event_url, "event.html")
        papers = self.parse_event(html)
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} ACL Anthology papers selected "
            f"from {len(papers)} records.",
            file=sys.stderr,
        )
        return sorted(selected, key=lambda paper: paper.id)

    def parse_event(self, html: str) -> list[Paper]:
        soup = BeautifulSoup(html, "html.parser")
        papers: list[Paper] = []
        for volume in self.volume_sections(soup):
            track = self.volume_title(volume)
            for block in self.paper_blocks(volume):
                paper = self.parse_paper_block(block, track)
                if paper is not None:
                    papers.append(paper)
        return papers

    def volume_sections(self, soup: BeautifulSoup) -> list[Tag]:
        return [
            div
            for div in soup.find_all("div", id=True)
            if re.fullmatch(r"\d{4}.+", str(div.get("id", ""))) and div.find("h4")
        ]

    @staticmethod
    def volume_title(volume: Tag) -> str:
        h4 = volume.find("h4")
        title_link = None
        if h4:
            for link in h4.select(
                'a[href^="/volumes/"], a[href^="https://aclanthology.org/volumes/"]'
            ):
                href = str(link.get("href", ""))
                if not href.endswith(".bib"):
                    title_link = link
                    break
        return clean_text(title_link) or clean_text(h4)

    @staticmethod
    def paper_blocks(volume: Tag) -> list[Tag]:
        return [
            child
            for child in volume.find_all("div", recursive=False)
            if has_classes(child, {"d-sm-flex", "align-items-stretch", "mb-3"})
        ]

    def parse_paper_block(self, block: Tag, track: str) -> Paper | None:
        title_link = block.select_one("strong a[href]")
        if title_link is None:
            return None
        paper_url = urljoin(self.event_url, str(title_link.get("href", "")))
        paper_id = acl_id_from_url(paper_url)
        pdf_link = block.select_one('a[href$=".pdf"]')
        abstract = ""
        sibling = block.find_next_sibling()
        if isinstance(sibling, Tag) and has_classes(sibling, {"abstract-collapse"}):
            abstract_node = sibling.select_one(".card-body") or sibling
            abstract = clean_text(abstract_node)

        authors = [
            clean_text(author)
            for author in block.select('a[href^="/people/"], a[href^="https://aclanthology.org/people/"]')
        ]

        return Paper(
            id=safe_slug(paper_id or paper_url),
            title=clean_text(title_link),
            abstract=abstract,
            authors=authors,
            tracks=[track] if track else [],
            event_type=event_type_from_track(track),
            session_titles=[track] if track else [],
            dates=[str(self.venue.year)] if self.venue.year else [],
            urls=unique_preserve_order([paper_url, self.event_url]),
            pdf_urls=unique_preserve_order([urljoin(self.event_url, str(pdf_link.get("href", "")))] if pdf_link else []),
            container=track or self.venue.name,
            publisher="Association for Computational Linguistics",
            extra={
                "aclAnthologyId": paper_id,
                "aclAnthologySource": self.event_url,
            },
        )


def has_classes(node: Tag, expected: set[str]) -> bool:
    classes = set(node.get("class") or [])
    return expected.issubset(classes)


def acl_id_from_url(url: str) -> str:
    path = urlparse(url).path.strip("/")
    return path.split("/")[-1] if path else ""


def event_type_from_track(track: str) -> str:
    lower = track.lower()
    if "long paper" in lower:
        return "Long Paper"
    if "short paper" in lower:
        return "Short Paper"
    if "findings" in lower:
        return "Findings Paper"
    if "demo" in lower:
        return "Demo Paper"
    return "Paper"
