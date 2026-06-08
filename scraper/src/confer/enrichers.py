"""Metadata enrichment from bibliographic indexes and open scholarly APIs."""

from __future__ import annotations

import json
import re
import sys
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import quote, urlencode

from bs4 import BeautifulSoup

from .config import VenueConfig
from .fetcher import Fetcher
from .models import Paper
from .util import cache_name_for_url, clean_doi, doi_from_url, strip_markup_text, unique_preserve_order


DEFAULT_MAILTO = "hi@repus.me"
TITLE_TOKEN_RE = re.compile(r"[a-z0-9]+")


def enrich_papers(venue: VenueConfig, fetcher: Fetcher, papers: list[Paper]) -> list[Paper]:
    specs = venue.source.get("enrichers") or []
    if isinstance(specs, str):
        specs = [specs]
    if not specs:
        return papers

    enriched = papers
    for spec in specs:
        name, options = parse_enricher_spec(spec)
        enricher_cls = ENRICHERS.get(name)
        if enricher_cls is None:
            raise ValueError(f"Venue {venue.id!r}: unknown enricher {name!r}")
        enriched = enricher_cls(venue, fetcher, options).enrich(enriched)
    return enriched


def parse_enricher_spec(spec: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(spec, str):
        return spec, {}
    if not isinstance(spec, dict) or len(spec) != 1:
        raise ValueError(f"Invalid enricher spec: {spec!r}")
    name, options = next(iter(spec.items()))
    return str(name), dict(options or {})


class MetadataEnricher(ABC):
    #: Registry key; set by subclasses (matches a name in ``source.enrichers``).
    name = ""

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, options: dict[str, Any]) -> None:
        self.venue = venue
        self.fetcher = fetcher
        self.options = options
        self.threshold = float(options.get("title_match_threshold", 0.82))
        self.mailto = str(options.get("mailto") or DEFAULT_MAILTO)
        self.workers = max(int(options.get("workers", venue.source.get("enricher_workers", 8))), 1)

    def enrich(self, papers: list[Paper]) -> list[Paper]:
        if self.workers <= 1 or len(papers) <= 1:
            return self.enrich_sequential(papers)

        matched = 0
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(self.safe_lookup, paper): paper for paper in papers}
            completed = 0
            for future in as_completed(futures):
                completed += 1
                paper = futures[future]
                metadata = future.result()
                if metadata:
                    matched += 1
                    merge_metadata(paper, metadata, self.name)
                if completed % 100 == 0:
                    print(f"[{self.venue.id}] {self.name} enriched {completed}/{len(papers)} papers...", file=sys.stderr)
        print(f"[{self.venue.id}] {self.name} matched {matched}/{len(papers)} papers.", file=sys.stderr)
        return papers

    def enrich_sequential(self, papers: list[Paper]) -> list[Paper]:
        matched = 0
        for index, paper in enumerate(papers, start=1):
            metadata = self.safe_lookup(paper)
            if metadata:
                matched += 1
                merge_metadata(paper, metadata, self.name)
            if index % 100 == 0:
                print(f"[{self.venue.id}] {self.name} enriched {index}/{len(papers)} papers...", file=sys.stderr)
        print(f"[{self.venue.id}] {self.name} matched {matched}/{len(papers)} papers.", file=sys.stderr)
        return papers

    def safe_lookup(self, paper: Paper) -> dict[str, Any] | None:
        try:
            return self.lookup(paper)
        except Exception as exc:  # noqa: BLE001 - enrichment should not break primary crawl
            print(f"[{self.venue.id}] {self.name} lookup failed for {paper.id}: {exc}", file=sys.stderr)
            return None

    @abstractmethod
    def lookup(self, paper: Paper) -> dict[str, Any] | None:
        """Return raw metadata for one paper (normalized later), or None."""
        raise NotImplementedError

    def get_json(self, url: str) -> dict[str, Any]:
        text = self.fetcher.get_text(url, f"enrich/{self.name}/{cache_name_for_url(url, '.json')}")
        return json.loads(text)

    def date_filter(self, *, openalex: bool = False) -> str:
        if not self.venue.year:
            return ""
        if openalex:
            return f"from_publication_date:{self.venue.year}-01-01,to_publication_date:{self.venue.year}-12-31"
        return f"from-pub-date:{self.venue.year}-01-01,until-pub-date:{self.venue.year}-12-31"

    def matches_title(self, expected: str, candidate: str) -> bool:
        return title_similarity(expected, candidate) >= self.threshold


class CrossrefEnricher(MetadataEnricher):
    name = "crossref"

    def lookup(self, paper: Paper) -> dict[str, Any] | None:
        if paper.doi:
            item = self.lookup_by_doi(paper.doi)
            if item:
                return crossref_to_metadata(item)
        item = self.lookup_by_title(paper)
        return crossref_to_metadata(item) if item else None

    def lookup_by_doi(self, doi: str) -> dict[str, Any] | None:
        url = f"https://api.crossref.org/works/{quote(clean_doi(doi), safe='')}"
        try:
            payload = self.get_json(url)
        except Exception:
            return None
        item = payload.get("message")
        return item if isinstance(item, dict) else None

    def lookup_by_title(self, paper: Paper) -> dict[str, Any] | None:
        params = {
            "query.title": paper.title,
            "rows": str(int(self.options.get("rows", 5))),
            "mailto": self.mailto,
        }
        date_filter = self.date_filter()
        if date_filter:
            params["filter"] = date_filter
        if paper.authors:
            params["query.author"] = paper.authors[0]
        url = f"https://api.crossref.org/works?{urlencode(params)}"
        try:
            payload = self.get_json(url)
        except Exception:
            return None
        items = payload.get("message", {}).get("items", [])
        for item in items:
            title = first(item.get("title"))
            if title and self.matches_title(paper.title, strip_markup(title)):
                return item
        return None


class OpenAlexEnricher(MetadataEnricher):
    name = "openalex"

    def lookup(self, paper: Paper) -> dict[str, Any] | None:
        metadata: dict[str, Any] = {}
        if paper.doi:
            by_doi = self.lookup_by_doi(paper.doi)
            if by_doi:
                metadata = openalex_to_metadata(by_doi)

        needs_title_fallback = not metadata or (
            not metadata.get("abstract") and not metadata.get("pdf_urls")
        )
        if needs_title_fallback:
            by_title = self.lookup_by_title(paper)
            if by_title:
                title_metadata = openalex_to_metadata(by_title)
                metadata = merge_metadata_dicts(metadata, title_metadata)
        return metadata or None

    def lookup_by_doi(self, doi: str) -> dict[str, Any] | None:
        params = {"filter": f"doi:https://doi.org/{clean_doi(doi)}", "per-page": "1", "mailto": self.mailto}
        url = f"https://api.openalex.org/works?{urlencode(params)}"
        try:
            payload = self.get_json(url)
        except Exception:
            return None
        results = payload.get("results", [])
        return results[0] if results else None

    def lookup_by_title(self, paper: Paper) -> dict[str, Any] | None:
        filters = self.date_filter(openalex=True)
        params = {"search": paper.title, "per-page": str(int(self.options.get("rows", 5))), "mailto": self.mailto}
        if filters:
            params["filter"] = filters
        url = f"https://api.openalex.org/works?{urlencode(params)}"
        try:
            payload = self.get_json(url)
        except Exception:
            return None
        for item in payload.get("results", []):
            title = item.get("title", "")
            if title and self.matches_title(paper.title, strip_markup(title)):
                return item
        return None


#: Selected by name from a venue's ``source.enrichers``. Add an enricher =
#: one subclass + one registry entry (mirrors ``scrapers.SCRAPERS``).
ENRICHERS: dict[str, type[MetadataEnricher]] = {
    CrossrefEnricher.name: CrossrefEnricher,
    OpenAlexEnricher.name: OpenAlexEnricher,
}


def merge_metadata(paper: Paper, metadata: dict[str, Any], source: str) -> None:
    paper.doi = paper.doi or clean_doi(str(metadata.get("doi", "")))
    paper.abstract = strip_markup_text(paper.abstract) or strip_markup_text(str(metadata.get("abstract", "")))
    paper.publication_date = paper.publication_date or str(metadata.get("publication_date", ""))
    paper.publisher = paper.publisher or str(metadata.get("publisher", ""))
    paper.container = paper.container or str(metadata.get("container", ""))
    paper.volume = paper.volume or str(metadata.get("volume", ""))
    paper.issue = paper.issue or str(metadata.get("issue", ""))
    paper.pages = paper.pages or str(metadata.get("pages", ""))
    paper.urls = unique_preserve_order(paper.urls + list(metadata.get("urls", [])))
    paper.pdf_urls = unique_preserve_order(paper.pdf_urls + list(metadata.get("pdf_urls", [])))
    paper.artifact_urls = unique_preserve_order(paper.artifact_urls + list(metadata.get("artifact_urls", [])))
    paper.keywords = unique_preserve_order(paper.keywords + list(metadata.get("keywords", [])))
    if paper.doi:
        paper.urls = unique_preserve_order([f"https://doi.org/{paper.doi}"] + paper.urls)

    provenance = paper.extra.setdefault("metadataSources", [])
    if source not in provenance:
        provenance.append(source)
    open_access = metadata.get("open_access")
    if open_access:
        paper.extra.setdefault("openAccess", open_access)


def merge_metadata_dicts(primary: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    merged = dict(primary)
    for key, value in fallback.items():
        if not value:
            continue
        if key in {"urls", "pdf_urls", "artifact_urls", "keywords"}:
            merged[key] = unique_preserve_order(list(merged.get(key, [])) + list(value))
        elif not merged.get(key):
            merged[key] = value
    return merged


def crossref_to_metadata(item: dict[str, Any]) -> dict[str, Any]:
    links = item.get("link") or []
    pdf_urls = [
        str(link.get("URL", ""))
        for link in links
        if "pdf" in str(link.get("content-type", "")).lower() and link.get("URL")
    ]
    metadata = {
        "doi": item.get("DOI", ""),
        "abstract": strip_markup(str(item.get("abstract", ""))),
        "publication_date": crossref_publication_date(item),
        "publisher": item.get("publisher", ""),
        "container": first(item.get("container-title")),
        "volume": item.get("volume", ""),
        "issue": item.get("issue", ""),
        "pages": item.get("page", ""),
        "urls": unique_preserve_order([item.get("URL", "")]),
        "pdf_urls": unique_preserve_order(pdf_urls),
        "keywords": [str(value) for value in item.get("subject", [])],
    }
    return {key: value for key, value in metadata.items() if value}


def crossref_publication_date(item: dict[str, Any]) -> str:
    for key in ("published-print", "published-online", "published"):
        value = item.get(key) or {}
        date_parts = value.get("date-parts") if isinstance(value, dict) else None
        date = date_parts_to_iso(first(date_parts))
        if date:
            return date
    return ""


def openalex_to_metadata(item: dict[str, Any]) -> dict[str, Any]:
    primary = item.get("primary_location") or {}
    source = primary.get("source") or {}
    biblio = item.get("biblio") or {}
    open_access = item.get("open_access") or {}
    landing = primary.get("landing_page_url") or item.get("landing_page_url")
    pdf = primary.get("pdf_url") or open_access.get("oa_url")
    pages = biblio_pages(biblio)
    metadata = {
        "doi": clean_doi(str(item.get("doi", ""))),
        "abstract": strip_markup(inverted_abstract(item.get("abstract_inverted_index") or {})),
        "publication_date": item.get("publication_date", ""),
        "publisher": source.get("host_organization_name") or "",
        "container": source.get("display_name") or "",
        "volume": biblio.get("volume", ""),
        "issue": biblio.get("issue", ""),
        "pages": pages,
        "urls": unique_preserve_order([landing, item.get("id", "")]),
        "pdf_urls": unique_preserve_order([pdf]),
        "keywords": openalex_keywords(item),
        "open_access": {
            key: open_access[key]
            for key in ("is_oa", "oa_status", "oa_url")
            if key in open_access and open_access[key] is not None
        },
    }
    return {key: value for key, value in metadata.items() if value}


def inverted_abstract(index: dict[str, list[int]]) -> str:
    if not index:
        return ""
    words: list[tuple[int, str]] = []
    for word, positions in index.items():
        words.extend((position, word) for position in positions)
    return " ".join(word for _, word in sorted(words))


def openalex_keywords(item: dict[str, Any]) -> list[str]:
    keywords = [
        str(keyword.get("display_name", ""))
        for keyword in item.get("keywords", [])
        if keyword.get("display_name")
    ]
    if keywords:
        return keywords[:12]
    return [
        str(concept.get("display_name", ""))
        for concept in item.get("concepts", [])[:12]
        if concept.get("display_name")
    ]


def biblio_pages(biblio: dict[str, Any]) -> str:
    first_page = str(biblio.get("first_page") or "")
    last_page = str(biblio.get("last_page") or "")
    if first_page and last_page and first_page != last_page:
        return f"{first_page}-{last_page}"
    return first_page or last_page


def date_parts_to_iso(parts: list[int] | None) -> str:
    if not parts:
        return ""
    year = parts[0]
    month = parts[1] if len(parts) > 1 else 1
    day = parts[2] if len(parts) > 2 else 1
    return f"{year:04d}-{month:02d}-{day:02d}"


def first(value: Any) -> Any:
    if isinstance(value, list):
        return value[0] if value else ""
    return value


def strip_markup(value: str) -> str:
    if not value:
        return ""
    soup = BeautifulSoup(value, "html.parser")
    text = soup.get_text(" ", strip=True)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"</?[A-Za-z][^>\s]*", "", text)
    return re.sub(r"\s+", " ", text).strip()


def normalized_title(value: str) -> str:
    return " ".join(TITLE_TOKEN_RE.findall(strip_markup(value).lower()))


def title_similarity(a: str, b: str) -> float:
    left = normalized_title(a)
    right = normalized_title(b)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return SequenceMatcher(None, left, right).ratio()
