"""Small HTML/text helpers shared across adapters."""

from __future__ import annotations

import hashlib
import html
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from bs4 import Tag

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.IGNORECASE)


def clean_text(node: Tag | None) -> str:
    if node is None:
        return ""
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()


def strip_markup(value: str) -> str:
    """Strip HTML/XML (incl. JATS) tags, decode entities, and collapse whitespace.

    The single canonical text-cleaner — used both on the parse hot path
    (``Paper.__post_init__``) and for enrichment abstracts from external APIs.
    """
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", "", value)
    text = re.sub(r"</?[A-Za-z][^>\s]*(?=\s|$)", "", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def clean_doi(value: str) -> str:
    text = re.sub(r"\s+", "", value or "")
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^doi:\s*", "", text, flags=re.IGNORECASE)
    match = DOI_RE.search(text)
    doi = match.group(0) if match else text
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
