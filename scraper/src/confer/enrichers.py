"""Metadata enrichment from bibliographic indexes and open scholarly APIs."""

from __future__ import annotations

import json
import re
import sys
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import quote, urlencode, urlparse

import requests

from .config import VenueConfig
from .fetcher import Fetcher
from .models import Paper, clean_author_ids, clean_title
from .util import (
    cache_name_for_url,
    clean_doi,
    doi_from_url,
    meaningful_abstract,
    strip_markup,
    unique_preserve_order,
)


DEFAULT_MAILTO = "hi@repus.me"
TITLE_TOKEN_RE = re.compile(r"[a-z0-9]+")
TITLE_QUERY_SYMBOLS = {
    "α": "alpha",
    "β": "beta",
    "δ": "delta",
    "ε": "epsilon",
    "λ": "lambda",
    "μ": "mu",
    "π": "pi",
    "∀": "forall",
    "∃": "exists",
    "∞": "infinity",
}
GENERIC_METADATA_TITLE_RE = re.compile(
    r"^(?:distinguished papers|distinguished reviewers|opening|closing|welcome|break|lunch|coffee break|.*posters for day \d.*)$",
    re.IGNORECASE,
)
DEFAULT_ENRICHERS = ("crossref", "openalex")
PRIMARY_METADATA_SCRAPERS = {"aaai", "acl_anthology", "ndss", "openreview"}


def enrich_papers(venue: VenueConfig, fetcher: Fetcher, papers: list[Paper]) -> list[Paper]:
    if "enrichers" in venue.source:
        specs = venue.source.get("enrichers")
    elif venue.scraper in PRIMARY_METADATA_SCRAPERS:
        specs = []
    else:
        specs = DEFAULT_ENRICHERS
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
        default_workers = 1 if self.name == "openalex" else 4
        self.workers = max(int(options.get("workers", venue.source.get("enricher_workers", default_workers))), 1)

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
        text = self.fetcher.get_shared_text(url, self.cache_key_for_url(url))
        return json.loads(text)

    def has_cached_json(self, url: str) -> bool:
        return self.fetcher.has_shared_cache(self.cache_key_for_url(url))

    def cache_key_for_url(self, url: str) -> str:
        return f"enrich/{self.name}/{cache_name_for_url(url, '.json')}"

    def date_filter(self, *, openalex: bool = False) -> str:
        if not self.venue.year:
            return ""
        default_window = self.default_year_window()
        window = int(self.options.get("year_window", self.venue.source.get("metadata_year_window", default_window)))
        start_year = self.venue.year - max(window, 0)
        end_year = self.venue.year + (1 if self.venue.scraper == "researchr" else 0)
        if openalex:
            return f"from_publication_date:{start_year}-01-01,to_publication_date:{end_year}-12-31"
        return f"from-pub-date:{start_year}-01-01,until-pub-date:{end_year}-12-31"

    def default_year_window(self) -> int:
        if self.venue.kind == "journal":
            return 1
        if self.venue.scraper == "researchr":
            return 4
        return 0

    def matches_title(self, expected: str, candidate: str) -> bool:
        return title_similarity(expected, candidate) >= self.threshold


class CrossrefEnricher(MetadataEnricher):
    name = "crossref"

    def lookup(self, paper: Paper) -> dict[str, Any] | None:
        if paper.doi:
            item = self.lookup_by_doi(paper.doi)
            if item:
                metadata = self.complete_metadata(item)
                if self.matches_crossref_item(paper, item):
                    return metadata
                title_item = self.lookup_by_title(paper)
                if title_item:
                    title_metadata = self.complete_metadata(title_item)
                    title_metadata["replace_doi"] = True
                    return title_metadata
                return metadata
        item = self.lookup_by_title(paper)
        if not item:
            return None
        return self.complete_metadata(item)

    def complete_metadata(self, item: dict[str, Any]) -> dict[str, Any]:
        metadata = crossref_to_metadata(item)
        doi = clean_doi(str(metadata.get("doi", "")))
        if doi and needs_crossref_detail(metadata):
            detail = self.lookup_by_doi(doi)
            if detail:
                metadata = merge_metadata_dicts(metadata, crossref_to_metadata(detail))
        return metadata

    def matches_crossref_item(self, paper: Paper, item: dict[str, Any]) -> bool:
        title = first(item.get("title"))
        return bool(title and self.matches_title(paper.title, strip_markup(title)))

    def lookup_by_doi(self, doi: str) -> dict[str, Any] | None:
        url = f"https://api.crossref.org/works/{quote(clean_doi(doi), safe='')}"
        try:
            payload = self.get_json(url)
        except Exception:
            return None
        item = payload.get("message")
        return item if isinstance(item, dict) else None

    def lookup_by_title(self, paper: Paper) -> dict[str, Any] | None:
        if not should_lookup_by_title(paper):
            return None
        for query in title_query_variants(paper.title):
            params = {
                "query.title": query,
                "rows": str(int(self.options.get("rows", 25))),
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
                continue
            items = payload.get("message", {}).get("items", [])
            matches = []
            for item in items:
                title = first(item.get("title"))
                if title and self.matches_title(paper.title, strip_markup(title)):
                    matches.append(item)
            if matches:
                return max(matches, key=lambda item: crossref_item_score(item, paper, self.venue))
        return None


class OpenAlexEnricher(MetadataEnricher):
    name = "openalex"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, options: dict[str, Any]) -> None:
        super().__init__(venue, fetcher, options)
        self.network_disabled = False
        self.failures = 0
        self.max_failures = max(
            int(options.get("max_failures", venue.source.get("openalex_max_failures", 1))),
            1,
        )

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
            title_metadata = self.lookup_by_title(paper)
            if title_metadata:
                metadata = merge_metadata_dicts(metadata, title_metadata)
        return metadata or None

    def lookup_by_doi(self, doi: str) -> dict[str, Any] | None:
        params = {"filter": f"doi:https://doi.org/{clean_doi(doi)}", "per-page": "1", "mailto": self.mailto}
        url = f"https://api.openalex.org/works?{urlencode(params)}"
        payload = self.openalex_json(url)
        if not payload:
            return None
        results = payload.get("results", [])
        return results[0] if results else None

    def lookup_by_title(self, paper: Paper) -> dict[str, Any] | None:
        if not should_lookup_by_title(paper):
            return None
        filters = self.date_filter(openalex=True)
        for query in title_query_variants(paper.title):
            params = {
                "search": query,
                "per-page": str(int(self.options.get("rows", 10))),
                "mailto": self.mailto,
            }
            if filters:
                params["filter"] = filters
            url = f"https://api.openalex.org/works?{urlencode(params)}"
            payload = self.openalex_json(url)
            if not payload:
                continue
            matches = []
            for item in payload.get("results", []):
                title = item.get("title", "")
                if title and self.matches_title(paper.title, strip_markup(title)):
                    matches.append(item)
            if matches:
                return merge_openalex_metadata(matches)
        return None

    def openalex_json(self, url: str) -> dict[str, Any] | None:
        if self.network_disabled and not self.has_cached_json(url):
            return None
        try:
            return self.get_json(url)
        except Exception as exc:  # noqa: BLE001 - OpenAlex is optional enrichment
            if is_bad_openalex_query(exc):
                print(f"[{self.venue.id}] openalex skipped bad query: {exc}", file=sys.stderr)
                return None
            self.failures += 1
            if self.failures >= self.max_failures:
                self.network_disabled = True
                print(
                    f"[{self.venue.id}] openalex network disabled after {self.failures} lookup failures: {exc}",
                    file=sys.stderr,
                )
            return None


#: Selected by name from a venue's ``source.enrichers``. Add an enricher =
#: one subclass + one registry entry (mirrors ``scrapers.SCRAPERS``).
ENRICHERS: dict[str, type[MetadataEnricher]] = {
    CrossrefEnricher.name: CrossrefEnricher,
    OpenAlexEnricher.name: OpenAlexEnricher,
}


def merge_metadata(paper: Paper, metadata: dict[str, Any], source: str) -> None:
    metadata_title = clean_title(str(metadata.get("title", "")))
    if should_replace_title(paper.title, metadata_title):
        paper.title = metadata_title
    doi = clean_doi(str(metadata.get("doi", "")))
    if doi and (not paper.doi or metadata.get("replace_doi")):
        paper.doi = doi
    paper.abstract = meaningful_abstract(paper.abstract) or meaningful_abstract(str(metadata.get("abstract", "")))
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

    authorships = metadata.get("authorships")
    if authorships and not paper.authors:
        paper.authors = [a["name"] for a in authorships if a.get("name")]
        paper.author_ids = [a.get("id", "") for a in authorships if a.get("name")]
        institutions = [
            f"{a['name']} ({a['institution']})"
            for a in authorships
            if a.get("name") and a.get("institution")
        ]
        if institutions and not paper.author_institutions:
            paper.author_institutions = "; ".join(institutions)

    # Stable per-author ids (ORCID / OpenAlex id) for disambiguation, aligned to
    # paper.authors. Merge per-slot so crossref + openalex can each contribute.
    if authorships and paper.authors:
        if len(paper.author_ids) != len(paper.authors):
            paper.author_ids = clean_author_ids(paper.author_ids, len(paper.authors)) or [""] * len(paper.authors)
        for i, aid in enumerate(align_author_ids(paper.authors, authorships)):
            if aid and not paper.author_ids[i]:
                paper.author_ids[i] = aid

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


def needs_crossref_detail(metadata: dict[str, Any]) -> bool:
    return not all(
        metadata.get(key)
        for key in ("container", "publication_date", "publisher", "pages")
    ) or not metadata.get("authorships")


def is_bad_openalex_query(exc: Exception) -> bool:
    if not isinstance(exc, requests.HTTPError):
        return False
    status_code = exc.response.status_code if exc.response is not None else None
    return status_code is not None and 400 <= status_code < 500 and status_code != 429


def should_lookup_by_title(paper: Paper) -> bool:
    title = strip_markup(paper.title)
    normalized = re.sub(r"\s+", " ", title).strip().lower()
    if not normalized or GENERIC_METADATA_TITLE_RE.fullmatch(normalized):
        return False
    if paper.authors:
        return True
    return len(TITLE_TOKEN_RE.findall(normalized)) >= 4


def crossref_item_score(item: dict[str, Any], paper: Paper, venue: VenueConfig) -> float:
    metadata = crossref_to_metadata(item)
    title = str(metadata.get("title", ""))
    score = title_similarity(paper.title, title) * 100
    if normalized_title(paper.title) == normalized_title(title):
        score += 30

    authorships = metadata.get("authorships") or []
    if paper.authors and authorships:
        first_author_id = align_author_ids([paper.authors[0]], authorships)[0]
        if first_author_id or normalized_person_name(paper.authors[0]) == normalized_person_name(authorships[0].get("name", "")):
            score += 8
    if any(author.get("id") for author in authorships):
        score += 4

    for key, weight in (
        ("container", 5),
        ("pages", 4),
        ("volume", 3),
        ("issue", 2),
        ("publication_date", 2),
        ("doi", 2),
    ):
        if metadata.get(key):
            score += weight

    publication_year = str(metadata.get("publication_date", ""))[:4]
    if publication_year.isdigit() and venue.year:
        year_delta = abs(int(publication_year) - int(venue.year))
        score -= min(year_delta, 3) * 2

    item_type = str(item.get("type") or "").lower()
    container = str(metadata.get("container") or "").lower()
    if item_type in {"posted-content", "preprint", "report"}:
        score -= 18
    if "ssrn" in container:
        score -= 24
    return score


def normalized_person_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def crossref_to_metadata(item: dict[str, Any]) -> dict[str, Any]:
    links = item.get("link") or []
    pdf_urls = [
        str(link.get("URL", ""))
        for link in links
        if "pdf" in str(link.get("content-type", "")).lower() and link.get("URL")
    ]
    metadata = {
        "title": first(item.get("title")),
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
    out = {key: value for key, value in metadata.items() if value}
    auths = crossref_authorships(item)
    if any(a["name"] or a["id"] for a in auths):
        out["authorships"] = auths
    return out


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
    locations = [location for location in item.get("locations", []) or [] if isinstance(location, dict)]
    source = primary.get("source") or {}
    biblio = item.get("biblio") or {}
    open_access = item.get("open_access") or {}
    doi = clean_doi(str(item.get("doi") or (item.get("ids") or {}).get("doi") or ""))
    landing_urls = unique_preserve_order(
        [
            clean_metadata_url(primary.get("landing_page_url") or item.get("landing_page_url")),
            *[clean_metadata_url(location.get("landing_page_url")) for location in locations],
            item.get("id", ""),
        ]
    )
    pdf_urls = openalex_pdf_urls(item, primary, locations, open_access, doi)
    pages = biblio_pages(biblio)
    metadata = {
        "title": item.get("title", ""),
        "doi": doi,
        "abstract": strip_markup(inverted_abstract(item.get("abstract_inverted_index") or {})),
        "publication_date": item.get("publication_date", ""),
        "publisher": source.get("host_organization_name") or "",
        "container": source.get("display_name") or "",
        "volume": biblio.get("volume", ""),
        "issue": biblio.get("issue", ""),
        "pages": pages,
        "urls": landing_urls,
        "pdf_urls": pdf_urls,
        "keywords": openalex_keywords(item),
        "open_access": openalex_open_access(open_access),
    }
    out = {key: value for key, value in metadata.items() if value}
    auths = openalex_authorships(item)
    if any(a["name"] or a["id"] for a in auths):
        out["authorships"] = auths
    return out


def clean_metadata_url(value: Any) -> str:
    url = str(value or "").strip()
    if re.fullmatch(r"https?://(?:dx\.)?doi\.org/(?:none|null|nan|n/a|na)?/?", url, re.IGNORECASE):
        return ""
    return url


def openalex_pdf_urls(
    item: dict[str, Any],
    primary: dict[str, Any],
    locations: list[dict[str, Any]],
    open_access: dict[str, Any],
    doi: str,
) -> list[str]:
    candidates = [
        clean_metadata_url(primary.get("pdf_url")),
        clean_metadata_url(open_access.get("oa_url")),
        *[clean_metadata_url(location.get("pdf_url")) for location in locations],
        arxiv_pdf_url(doi),
        arxiv_pdf_url(primary.get("landing_page_url")),
        arxiv_pdf_url(open_access.get("oa_url")),
        *[arxiv_pdf_url(location.get("landing_page_url")) for location in locations],
        *[arxiv_pdf_url(location.get("pdf_url")) for location in locations],
    ]
    ids = item.get("ids") or {}
    candidates.extend(arxiv_pdf_url(value) for value in ids.values())
    return unique_preserve_order(candidates)


def arxiv_pdf_url(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    doi = clean_doi(text)
    if doi.lower().startswith("10.48550/arxiv."):
        return f"https://arxiv.org/pdf/{doi.split('arxiv.', 1)[1]}"
    parsed = urlparse(text)
    if parsed.netloc.lower() not in {"arxiv.org", "www.arxiv.org"}:
        return ""
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2 and parts[0] in {"abs", "pdf"}:
        return f"https://arxiv.org/pdf/{parts[1]}"
    return ""


def openalex_open_access(open_access: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in ("is_oa", "oa_status"):
        if key in open_access and open_access[key] is not None:
            out[key] = open_access[key]
    oa_url = clean_metadata_url(open_access.get("oa_url"))
    if oa_url:
        out["oa_url"] = oa_url
    return out


def clean_orcid(value: str) -> str:
    match = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dXx]", value or "")
    return match.group(0).upper() if match else ""


def crossref_authorships(item: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for a in item.get("author", []) or []:
        name = " ".join(part for part in [a.get("given", ""), a.get("family", "")] if part).strip()
        out.append({"name": name, "id": clean_orcid(str(a.get("ORCID") or "")), "institution": ""})
    return out


def openalex_authorships(item: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for a in item.get("authorships", []) or []:
        au = a.get("author") or {}
        orcid = clean_orcid(str(au.get("orcid") or ""))
        oid = str(au.get("id") or "").rstrip("/").rsplit("/", 1)[-1]
        institutions = [
            str(institution.get("display_name") or "").strip()
            for institution in a.get("institutions", []) or []
            if institution.get("display_name")
        ]
        out.append(
            {
                "name": str(au.get("display_name") or ""),
                "id": orcid or oid,
                "institution": "; ".join(institutions),
            }
        )
    return out


def openalex_item_score(item: dict[str, Any]) -> float:
    primary = item.get("primary_location") or {}
    open_access = item.get("open_access") or {}
    locations = [location for location in item.get("locations", []) or [] if isinstance(location, dict)]
    score = 0.0
    if clean_doi(str(item.get("doi") or (item.get("ids") or {}).get("doi") or "")):
        score += 12
    if openalex_pdf_urls(item, primary, locations, open_access, ""):
        score += 5
    if item.get("abstract_inverted_index"):
        score += 3
    if (primary.get("source") or {}).get("host_organization_name"):
        score += 1
    score += min(sum(1 for authorship in openalex_authorships(item) if authorship.get("id")), 10) / 10
    return score


def merge_openalex_metadata(items: list[dict[str, Any]]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for item in sorted(items, key=openalex_item_score, reverse=True):
        metadata = merge_metadata_dicts(metadata, openalex_to_metadata(item))
    return metadata


def align_author_ids(authors: list[str], authorships: list[dict[str, str]]) -> list[str]:
    """Best-effort align authorship ids to the paper's author list (by position
    when counts match, else by normalized name)."""
    ids = [""] * len(authors)
    if not authors or not authorships:
        return ids
    if len(authors) == len(authorships):
        for i, a in enumerate(authorships):
            ids[i] = a.get("id", "")
        return ids
    norm = lambda s: re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
    by_name: dict[str, str] = {}
    for a in authorships:
        by_name.setdefault(norm(a.get("name", "")), a.get("id", ""))
    for i, name in enumerate(authors):
        ids[i] = by_name.get(norm(name), "")
    return ids


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


def normalized_title(value: str) -> str:
    return " ".join(TITLE_TOKEN_RE.findall(clean_title(value).lower()))


def search_title(value: str) -> str:
    return title_query_variants(value)[0]


def title_query_variants(value: str) -> list[str]:
    primary = re.sub(r"\s*(?:\.{3}|…)\s*", " ", clean_title(value)).strip()
    ascii_math = primary
    for symbol, replacement in TITLE_QUERY_SYMBOLS.items():
        ascii_math = ascii_math.replace(symbol, replacement)
    caretless = re.sub(r"\^([+\-]|\d+)", r"\1", ascii_math)
    loose = re.sub(r"[^A-Za-z0-9]+", " ", ascii_math).strip()
    return unique_preserve_order([primary, ascii_math, caretless, loose])


def title_similarity(a: str, b: str) -> float:
    left = normalized_title(a)
    right = normalized_title(b)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return max(
        SequenceMatcher(None, left, right).ratio(),
        title_containment_similarity(left, right),
    )


def title_containment_similarity(left: str, right: str) -> float:
    left_tokens = left.split()
    right_tokens = right.split()
    shorter, longer = (
        (left_tokens, right_tokens)
        if len(left_tokens) <= len(right_tokens)
        else (right_tokens, left_tokens)
    )
    if len(shorter) < 5:
        return 0.0
    longer_set = set(longer)
    overlap = sum(1 for token in shorter if token in longer_set) / len(shorter)
    if overlap < 0.8:
        return 0.0
    return min(0.95, 0.72 + (overlap * 0.25))


def should_replace_title(current: str, candidate: str) -> bool:
    if not candidate:
        return False
    if not current:
        return True
    if not is_truncated_title(current):
        return False
    return len(candidate) > len(current) and title_similarity(current, candidate) >= 0.82


def is_truncated_title(value: str) -> bool:
    stripped = value.strip()
    return stripped.endswith("…") or stripped.endswith("...")
