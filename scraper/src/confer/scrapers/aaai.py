"""Adapter for AAAI OJS proceedings issues."""

from __future__ import annotations

import re
import sys
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import cache_name_for_url, clean_doi, clean_text, safe_slug, unique_preserve_order
from .base import Scraper


ARCHIVE_URL = "https://ojs.aaai.org/index.php/AAAI/issue/archive"


class AaaiScraper(Scraper):
    name = "aaai"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        self.archive_url = str(venue.source.get("archive_url") or ARCHIVE_URL)
        self.issue_prefix = str(venue.source.get("issue_prefix") or self.default_issue_prefix())

    def default_issue_prefix(self) -> str:
        if not self.venue.year:
            raise ValueError(f"Venue {self.venue.id!r}: aaai requires source.issue_prefix")
        return f"AAAI-{str(self.venue.year)[-2:]} Technical Tracks"

    def scrape(self) -> list[Paper]:
        archive_html = self.fetcher.get_text(self.archive_url, "archive.html")
        issue_links = self.parse_issue_links(archive_html)
        papers: list[Paper] = []
        for issue_title, issue_url in issue_links:
            issue_html = self.fetcher.get_text(issue_url, f"issues/{cache_name_for_url(issue_url)}")
            papers.extend(self.parse_issue(issue_html, issue_title, issue_url))
        selected = papers[: self.limit] if self.limit else papers
        self.enrich_details(selected)
        print(
            f"[{self.venue.id}] {len(selected)} AAAI papers selected "
            f"from {len(papers)} issue records.",
            file=sys.stderr,
        )
        return sorted(selected, key=lambda paper: paper.id)

    def parse_issue_links(self, html: str) -> list[tuple[str, str]]:
        soup = BeautifulSoup(html, "html.parser")
        links: list[tuple[str, str]] = []
        seen: set[str] = set()
        for link in soup.find_all("a", href=True):
            title = clean_text(link)
            if not title.startswith(self.issue_prefix):
                continue
            url = urljoin(self.archive_url, str(link.get("href", "")))
            if url in seen:
                continue
            seen.add(url)
            links.append((title, url))
        return sorted(links, key=lambda item: natural_key(item[0]))

    def parse_issue(self, html: str, issue_title: str, issue_url: str) -> list[Paper]:
        soup = BeautifulSoup(html, "html.parser")
        papers: list[Paper] = []
        for article in soup.select(".obj_article_summary"):
            paper = self.parse_article_summary(article, issue_title, issue_url)
            if paper:
                papers.append(paper)
        return papers

    def parse_article_summary(self, article: Tag, issue_title: str, issue_url: str) -> Paper | None:
        title_link = article.select_one("h3.title a[href]")
        if title_link is None:
            return None
        article_url = urljoin(issue_url, str(title_link.get("href", "")))
        article_id = article_id_from_url(article_url)
        pdf_urls = [
            urljoin(issue_url, str(link.get("href", "")))
            for link in article.select("a.obj_galley_link.pdf[href]")
        ]

        return Paper(
            id=safe_slug(article_id or article_url),
            title=clean_text(title_link),
            authors=parse_aaai_authors(clean_text(article.select_one(".authors"))),
            tracks=[issue_title],
            event_type="Paper",
            session_titles=[issue_title],
            dates=[str(self.venue.year)] if self.venue.year else [],
            urls=unique_preserve_order([article_url, issue_url, self.archive_url]),
            pdf_urls=unique_preserve_order(pdf_urls),
            pages=clean_text(article.select_one(".pages")),
            container="Proceedings of the AAAI Conference on Artificial Intelligence",
            publisher="AAAI Press",
            extra={
                "aaaiArticleId": article_id,
                "aaaiIssue": issue_title,
                "aaaiSource": issue_url,
            },
        )

    def enrich_details(self, papers: list[Paper]) -> None:
        for index, paper in enumerate(papers, start=1):
            article_url = next((url for url in paper.urls if "/article/view/" in url), "")
            if not article_url:
                continue
            try:
                html = self.fetcher.get_text(article_url, f"details/{cache_name_for_url(article_url)}")
            except Exception as exc:  # noqa: BLE001 - issue pages still provide core paper metadata
                print(f"[{self.venue.id}] aaai detail lookup failed for {paper.id}: {exc}", file=sys.stderr)
                continue
            metadata = parse_aaai_detail(html)
            apply_aaai_detail(paper, metadata)
            if index % 100 == 0:
                print(f"[{self.venue.id}] aaai details parsed {index}/{len(papers)} papers...", file=sys.stderr)


def parse_aaai_detail(html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    first_page = meta_content(soup, "citation_firstpage")
    last_page = meta_content(soup, "citation_lastpage")
    pages = "-".join(part for part in (first_page, last_page) if part)
    if first_page and last_page and first_page == last_page:
        pages = first_page
    institutions = meta_contents(soup, "citation_author_institution")
    return {
        "title": meta_content(soup, "citation_title"),
        "authors": meta_contents(soup, "citation_author"),
        "author_institutions": "; ".join(institutions),
        "abstract": clean_aaai_abstract(clean_text(soup.select_one("section.item.abstract"))),
        "publication_date": meta_content(soup, "citation_date").replace("/", "-"),
        "doi": clean_doi(meta_content(soup, "citation_doi")),
        "container": meta_content(soup, "citation_journal_title"),
        "volume": meta_content(soup, "citation_volume"),
        "issue": meta_content(soup, "citation_issue"),
        "pages": pages,
        "pdf_urls": meta_contents(soup, "citation_pdf_url"),
    }


def apply_aaai_detail(paper: Paper, metadata: dict[str, Any]) -> None:
    if metadata.get("title"):
        paper.title = str(metadata["title"])
    if metadata.get("authors"):
        paper.authors = list(metadata["authors"])
    paper.author_institutions = paper.author_institutions or str(metadata.get("author_institutions", ""))
    paper.abstract = paper.abstract or str(metadata.get("abstract", ""))
    paper.publication_date = paper.publication_date or str(metadata.get("publication_date", ""))
    paper.doi = paper.doi or str(metadata.get("doi", ""))
    paper.container = paper.container or str(metadata.get("container", ""))
    paper.volume = paper.volume or str(metadata.get("volume", ""))
    paper.issue = paper.issue or str(metadata.get("issue", ""))
    paper.pages = paper.pages or str(metadata.get("pages", ""))
    paper.pdf_urls = unique_preserve_order(paper.pdf_urls + list(metadata.get("pdf_urls", [])))


def parse_aaai_authors(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def clean_aaai_abstract(value: str) -> str:
    return re.sub(r"^Abstract\s+", "", value or "").strip()


def article_id_from_url(url: str) -> str:
    match = re.search(r"/article/view/(\d+)", urlparse(url).path)
    return match.group(1) if match else ""


def natural_key(value: str) -> list[int | str]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def meta_content(soup: BeautifulSoup, name: str) -> str:
    values = meta_contents(soup, name)
    return values[0] if values else ""


def meta_contents(soup: BeautifulSoup, name: str) -> list[str]:
    return [
        clean_text(meta) or str(meta.get("content", "")).strip()
        for meta in soup.find_all("meta", attrs={"name": name})
        if str(meta.get("content", "")).strip()
    ]
