"""Small HTML/text helpers shared across adapters."""

from __future__ import annotations

import hashlib
import html
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from bs4 import Tag

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.IGNORECASE)
PLACEHOLDER_ABSTRACTS = {
    "no description available",
    "no abstract available",
}


def clean_text(node: Tag | None) -> str:
    if node is None:
        return ""
    return strip_markup(node.get_text(" ", strip=True))


def strip_markup(value: str) -> str:
    """Strip HTML/XML (incl. JATS) tags, decode entities, and collapse whitespace.

    The single canonical text-cleaner — used both on the parse hot path
    (``Paper.__post_init__``) and for enrichment abstracts from external APIs.
    """
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", "", value)
    text = re.sub(r"</?[A-Za-z][^>\s]*(?=\s|$)", "", text)
    for _ in range(3):
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    return re.sub(r"\s+", " ", text).strip()


def split_author_names(value: str) -> list[str]:
    """Split a source-provided author string while preserving common name suffixes."""
    text = strip_markup(value)
    if not text:
        return []
    text = re.sub(r"\s+\band\b\s+", ", ", text)
    parts = [part.strip() for part in text.split(",") if part.strip()]
    authors: list[str] = []
    suffixes = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv"}
    for part in parts:
        if authors and part.lower().strip(".") in {suffix.strip(".") for suffix in suffixes}:
            authors[-1] = f"{authors[-1]}, {part}"
        else:
            authors.append(part)
    return authors


def meaningful_abstract(value: str) -> str:
    abstract = strip_markup(value).strip()
    return "" if abstract.lower().strip(" .") in PLACEHOLDER_ABSTRACTS else abstract


def clean_doi(value: str) -> str:
    text = re.sub(r"\s+", "", value or "")
    if not text or text.lower() in {"none", "null", "nan", "n/a", "na"}:
        return ""
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^doi:\s*", "", text, flags=re.IGNORECASE)
    match = DOI_RE.search(text)
    if not match:
        return ""
    doi = match.group(0)
    return doi.strip(" .;,)")


def doi_from_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.netloc.lower() in {"doi.org", "dx.doi.org"}:
        return clean_doi(parsed.path.lstrip("/"))
    return clean_doi(url) if DOI_RE.search(url) else ""


def split_classes(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        return value.split()
    return list(value)


def unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def parse_query(href: str) -> dict[str, str]:
    query = parse_qs(urlparse(href.replace("&amp;", "&")).query)
    return {key: values[0] for key, values in query.items() if values}


def cache_name_for_url(url: str, suffix: str = ".html") -> str:
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    parsed = urlparse(url)
    safe_path = re.sub(r"[^A-Za-z0-9_.-]+", "_", parsed.path.strip("/") or "home")
    return f"{safe_path}_{digest}{suffix}"


def safe_slug(value: str, fallback: str = "none") -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value or fallback)
