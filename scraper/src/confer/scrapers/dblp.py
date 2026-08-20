"""Adapter for DBLP bibliography table-of-contents XML pages."""

from __future__ import annotations

import re
import sys
import unicodedata
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import (
    cache_name_for_url,
    clean_doi,
    clean_text,
    doi_from_url,
    meaningful_abstract,
    safe_slug,
    strip_markup,
    unique_preserve_order,
)
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
        self.enrich_official_details(selected)
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
        issue_title = self.issue_title(record)

        ee_urls = [clean_text(ee) for ee in record.find_all("ee") if clean_text(ee)]
        dblp_url = self.dblp_url(record)
        urls = unique_preserve_order(ee_urls + [dblp_url, self.toc_url])
        doi = next((doi_from_url(url) for url in ee_urls if doi_from_url(url)), "")
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

    def enrich_official_details(self, papers: list[Paper]) -> None:
        matched = 0
        candidates = [paper for paper in papers if self.usenix_presentation_url(paper)]
        for index, paper in enumerate(candidates, start=1):
            url = self.usenix_presentation_url(paper)
            if not url:
                continue
            try:
                html = self.fetcher.get_text(url, f"details/{cache_name_for_url(url)}")
            except Exception as exc:  # noqa: BLE001 - official pages supplement DBLP, not replace it
                print(f"[{self.venue.id}] usenix detail lookup failed for {paper.id}: {exc}", file=sys.stderr)
                continue
            metadata = self.usenix_detail_metadata(html, url)
            if metadata:
                matched += 1
                self.apply_usenix_detail(paper, metadata)
            if index % 100 == 0:
                print(
                    f"[{self.venue.id}] usenix details enriched {index}/{len(candidates)} papers...",
                    file=sys.stderr,
                )
        if candidates:
            print(f"[{self.venue.id}] usenix details matched {matched}/{len(candidates)} papers.", file=sys.stderr)

    @staticmethod
    def usenix_presentation_url(paper: Paper) -> str:
        return next(
            (
                url
                for url in paper.urls
                if "://www.usenix.org/conference/" in url and "/presentation/" in url
            ),
            "",
        )

    @staticmethod
    def usenix_detail_metadata(html: str, url: str) -> dict[str, Any]:
        soup = BeautifulSoup(html, "html.parser")
        first_page = meta_content(soup, "citation_firstpage")
        last_page = meta_content(soup, "citation_lastpage")
        pages = "-".join(part for part in (first_page, last_page) if part)
        if first_page and last_page and first_page == last_page:
            pages = first_page

        pdf_urls = unique_preserve_order(
            [
                *meta_contents(soup, "citation_pdf_url"),
                *[
                    urljoin(url, str(link.get("href", "")))
                    for link in soup.select(".field-name-field-final-paper-pdf a[href]")
                ],
                *[
                    urljoin(url, str(link.get("href", "")))
                    for link in soup.select(".field-name-field-presentation-pdf a[href]")
                ],
            ]
        )

        people_node = soup.select_one(".field-name-field-paper-people-text")
        abstract_node = soup.select_one(".field-name-field-paper-description")
        metadata = {
            "title": meta_content(soup, "citation_title"),
            "authors": meta_contents(soup, "citation_author"),
            "author_institutions": clean_text(people_node),
            "abstract": meaningful_abstract(clean_text(abstract_node)),
            "publication_date": meta_content(soup, "citation_publication_date"),
            "publisher": "USENIX Association",
            "container": meta_content(soup, "citation_conference_title"),
            "pages": pages,
            "urls": [url],
            "pdf_urls": pdf_urls,
        }
        return {key: value for key, value in metadata.items() if value}

    @staticmethod
    def apply_usenix_detail(paper: Paper, metadata: dict[str, Any]) -> None:
        if not paper.title and metadata.get("title"):
            paper.title = strip_markup(str(metadata["title"]))
        if not paper.authors and metadata.get("authors"):
            paper.authors = list(metadata["authors"])
        people = str(metadata.get("author_institutions", ""))
        formatted = format_usenix_people(people, paper.authors or list(metadata.get("authors", [])))
        paper.author_institutions = paper.author_institutions or formatted or people
        paper.abstract = meaningful_abstract(paper.abstract) or str(metadata.get("abstract", ""))
        paper.publication_date = paper.publication_date or str(metadata.get("publication_date", ""))
        paper.publisher = paper.publisher or str(metadata.get("publisher", ""))
        paper.container = paper.container or str(metadata.get("container", ""))
        paper.pages = paper.pages or str(metadata.get("pages", ""))
        paper.urls = unique_preserve_order(paper.urls + list(metadata.get("urls", [])))
        paper.pdf_urls = unique_preserve_order(paper.pdf_urls + list(metadata.get("pdf_urls", [])))
        sources = paper.extra.setdefault("officialSources", [])
        if "usenix" not in sources:
            sources.append("usenix")

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


def normalized_name(value: str) -> str:
    """Case/diacritic-insensitive key for matching a byline name to an author."""
    folded = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", folded.lower()).strip()


def format_usenix_people(people: str, authors: list[str]) -> str:
    """Rewrite a USENIX byline into the site's ``Name (Institution)`` shape.

    USENIX groups authors by institution -- ``"A, B, and C, Inst; D, Inst2"`` --
    which carries the affiliations but not per author, so the site cannot align
    them. The page's ``citation_author`` tags are the authoritative name list, so
    consume names from the left of each group and treat the rest as the
    institution. Returns "" when a group has no recognizable author, leaving the
    caller to keep the byline as-is rather than guess.
    """
    known = {normalized_name(author): author for author in authors if author}
    if not known or not people:
        return ""
    pairs: list[tuple[str, str]] = []
    for group in people.split(";"):
        tokens = [token.strip() for token in group.split(",") if token.strip()]
        names: list[str] = []
        index = 0
        while index < len(tokens):
            candidates = [part.strip() for part in re.split(r"\band\b", tokens[index]) if part.strip()]
            if not candidates or not all(normalized_name(part) in known for part in candidates):
                break
            names.extend(known[normalized_name(part)] for part in candidates)
            index += 1
        if not names:
            return ""
        institution = re.sub(r"^and\s+", "", ", ".join(tokens[index:]).strip()).strip(" ,")
        pairs.extend((name, institution) for name in names)
    return "; ".join(f"{name} ({institution})" if institution else name for name, institution in pairs)


def meta_content(soup: BeautifulSoup, name: str) -> str:
    values = meta_contents(soup, name)
    return values[0] if values else ""


def meta_contents(soup: BeautifulSoup, name: str) -> list[str]:
    return [
        strip_markup(str(meta.get("content", "")))
        for meta in soup.find_all("meta", attrs={"name": name})
        if strip_markup(str(meta.get("content", "")))
    ]
