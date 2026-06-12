"""Adapter for NDSS Symposium accepted-paper pages."""

from __future__ import annotations

import sys
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import cache_name_for_url, clean_text, safe_slug, split_author_names, unique_preserve_order
from .base import Scraper


class NdssScraper(Scraper):
    name = "ndss"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        self.accepted_url = str(venue.source.get("accepted_url") or self.default_accepted_url())

    def default_accepted_url(self) -> str:
        if not self.venue.year:
            raise ValueError(f"Venue {self.venue.id!r}: ndss requires source.accepted_url")
        return f"https://www.ndss-symposium.org/ndss{self.venue.year}/accepted-papers/"

    def scrape(self) -> list[Paper]:
        html = self.fetcher.get_text(self.accepted_url, "accepted-papers.html")
        links = self.parse_accepted_links(html)
        if self.limit:
            links = links[: self.limit]
        papers: list[Paper] = []
        for index, (title, url) in enumerate(links, start=1):
            html = self.fetcher.get_text(url, f"details/{cache_name_for_url(url)}")
            papers.append(self.parse_detail(html, url, title))
            if index % 100 == 0:
                print(f"[{self.venue.id}] ndss details parsed {index}/{len(links)} papers...", file=sys.stderr)
        print(f"[{self.venue.id}] {len(papers)} NDSS papers selected from {len(links)} links.", file=sys.stderr)
        return sorted(papers, key=lambda paper: paper.id)

    def parse_accepted_links(self, html: str) -> list[tuple[str, str]]:
        soup = BeautifulSoup(html, "html.parser")
        links: list[tuple[str, str]] = []
        seen: set[str] = set()
        for link in soup.find_all("a", href=True):
            href = str(link.get("href", ""))
            if "/ndss-paper/" not in href:
                continue
            url = urljoin(self.accepted_url, href)
            if url in seen:
                continue
            title = clean_text(link)
            if not title:
                continue
            seen.add(url)
            links.append((title, url))
        return links

    def parse_detail(self, html: str, url: str, fallback_title: str = "") -> Paper:
        soup = BeautifulSoup(html, "html.parser")
        title = clean_text(soup.select_one("h1.entry-title")) or fallback_title
        paper_data = soup.select_one(".paper-data")
        paragraphs = paper_data.find_all("p", recursive=False) if paper_data else []
        byline = clean_text(paragraphs[0]) if paragraphs else ""
        abstract = clean_text(paragraphs[1]) if len(paragraphs) > 1 else ""
        authors, institutions = parse_ndss_byline(byline)
        pdf_urls = [
            urljoin(url, str(link.get("href", "")))
            for link in soup.select("a.pdf-button[href], a[href$='.pdf']")
        ]

        return Paper(
            id=safe_slug(path_slug(url) or title),
            title=title,
            abstract=abstract,
            authors=authors,
            author_institutions=institutions,
            tracks=[self.venue.name],
            event_type="Paper",
            session_titles=[self.venue.name],
            dates=[str(self.venue.year)] if self.venue.year else [],
            urls=unique_preserve_order([url, self.accepted_url]),
            pdf_urls=unique_preserve_order(pdf_urls),
            publisher="Internet Society",
            container=f"Proceedings of the {self.venue.name}",
            extra={
                "ndssSource": self.accepted_url,
            },
        )


def parse_ndss_byline(byline: str) -> tuple[list[str], str]:
    authors: list[str] = []
    institutions: list[str] = []
    for names_text, affiliation in iter_ndss_author_affiliations(byline):
        names = split_author_names(names_text)
        if affiliation:
            for name in names:
                authors.append(name)
                institutions.append(f"{name} ({affiliation})")
        else:
            authors.extend(names)
    return authors, "; ".join(institutions)


def iter_ndss_author_affiliations(byline: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    index = 0
    length = len(byline)
    while index < length:
        while index < length and byline[index] in " ,":
            index += 1
        if index >= length:
            break
        open_index = byline.find("(", index)
        if open_index == -1:
            entries.append((byline[index:].strip(" ,"), ""))
            break
        names_text = byline[index:open_index].strip(" ,")
        close_index = matching_paren_index(byline, open_index)
        if close_index == -1:
            entries.append((byline[index:].strip(" ,"), ""))
            break
        affiliation = byline[open_index + 1 : close_index].strip()
        entries.append((names_text, affiliation))
        index = close_index + 1
    return entries


def matching_paren_index(value: str, open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(value)):
        if value[index] == "(":
            depth += 1
        elif value[index] == ")":
            depth -= 1
            if depth == 0:
                return index
    return -1


def path_slug(url: str) -> str:
    return urlparse(url).path.strip("/").split("/")[-1]
