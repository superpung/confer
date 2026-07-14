"""Adapter for the official SOSP (SIGOPS) accepted-papers page.

The ACM Symposium on Operating Systems Principles publishes its accepted papers
on the SIGOPS site (``sigops.org/s/conferences/sosp/<year>/accepted.html``) as a
static HTML list. Unlike the DBLP bibliography, this first-party source carries
**author affiliations** inline, one ``<li>`` per paper::

    <ul class="paperlist">
      <li>
        <b>Rearchitecting the Thread Model ...</b><br/>
        <em>Youmin Chen (Shanghai Jiao Tong University), Jiwu Shu (Tsinghua
        University), Yanyan Shen, Linpeng Huang, Hong Mei (Shanghai Jiao Tong
        University)</em>
      </li>
      ...
    </ul>

Affiliations use a trailing-group convention: an institution in parentheses
applies to the run of preceding comma-separated authors that carry no
parenthesised institution of their own. So in the example above ``Yanyan Shen``
and ``Linpeng Huang`` share ``Hong Mei``'s ``Shanghai Jiao Tong University``.

Abstracts and DOIs are not on this page — the default Crossref/OpenAlex
enrichers fill those downstream — but the authoritative author affiliations come
straight from the venue, which DBLP cannot provide.

Source keys:
    accepted_url  -- the accepted-papers page (required)
"""

from __future__ import annotations

import re
import sys
from typing import Any

from bs4 import BeautifulSoup, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import cache_name_for_url, strip_markup, title_slug
from .base import Scraper


class SospScraper(Scraper):
    name = "sosp"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        accepted_url = venue.source.get("accepted_url") or venue.source.get("url")
        if not accepted_url:
            raise ValueError(f"Venue {venue.id!r}: sosp requires source.accepted_url")
        self.accepted_url = str(accepted_url)

    def scrape(self) -> list[Paper]:
        html = self.fetcher.get_text(self.accepted_url, cache_name_for_url(self.accepted_url))
        papers = self.parse_papers(html)
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} SOSP papers parsed from the "
            f"official accepted-papers page.",
            file=sys.stderr,
        )
        return selected

    def parse_papers(self, html: str) -> list[Paper]:
        soup = BeautifulSoup(html, "html.parser")
        papers: list[Paper] = []
        seen: set[str] = set()
        for item in soup.select("ul.paperlist > li"):
            paper = self.parse_item(item, seen)
            if paper is not None:
                papers.append(paper)
        return sorted(papers, key=lambda paper: paper.id)

    def parse_item(self, item: Tag, seen: set[str]) -> Paper | None:
        title_node = item.find("b")
        title = self.clean_title(title_node.get_text(" ", strip=True) if title_node else "")
        if not title:
            return None
        authors_node = item.find("em")
        authors_text = authors_node.get_text(" ", strip=True) if authors_node else ""
        authors, author_institutions = self.parse_authors(authors_text)

        paper_id = title_slug(title)
        if paper_id in seen:
            suffix = 2
            while f"{paper_id}-{suffix}" in seen:
                suffix += 1
            paper_id = f"{paper_id}-{suffix}"
        seen.add(paper_id)

        return Paper(
            id=paper_id,
            title=title,
            authors=authors,
            author_institutions=author_institutions,
            tracks=[self.venue.name],
            event_type="Paper",
            urls=[self.accepted_url],
            container=self.venue.name,
        )

    @staticmethod
    def clean_title(title: str) -> str:
        title = re.sub(r"\s+", " ", strip_markup(title or "")).strip()
        if title.endswith(".") and not title.endswith(("?", "!")):
            title = title[:-1]
        return title

    @classmethod
    def parse_authors(cls, text: str) -> tuple[list[str], str]:
        """Split an ``em`` authors string into names and per-author affiliations.

        A parenthesised institution applies to the run of preceding authors that
        lack their own — see the module docstring's trailing-group convention.
        """
        # Drop the sentence-ending period some entries put after the final
        # institution ("… (Princeton University).") so it doesn't leak into the
        # last author's name and defeat the trailing-group rule.
        text = re.sub(r"[.\s]+$", "", text or "")
        names: list[str] = []
        display: list[str] = []
        pending: list[str] = []
        for token in cls.split_top_level(text):
            name, institution = cls.split_name_institution(token)
            if not name:
                continue
            names.append(name)
            pending.append(name)
            if institution:
                display.extend(f"{n} ({institution})" for n in pending)
                pending = []
        display.extend(pending)
        return names, "; ".join(display)

    @staticmethod
    def split_top_level(text: str) -> list[str]:
        """Split on commas that sit outside any parentheses.

        Institution names may contain commas (``University of California,
        Berkeley``); those live inside parentheses and must not split authors.
        """
        parts: list[str] = []
        depth = 0
        buf: list[str] = []
        for ch in text:
            if ch == "(":
                depth += 1
                buf.append(ch)
            elif ch == ")":
                depth = max(0, depth - 1)
                buf.append(ch)
            elif ch == "," and depth == 0:
                parts.append("".join(buf))
                buf = []
            else:
                buf.append(ch)
        parts.append("".join(buf))
        return [part.strip() for part in parts if part.strip()]

    @staticmethod
    def split_name_institution(token: str) -> tuple[str, str]:
        """Split ``Name (Institution)`` into its parts.

        Scans back from the trailing ``)`` to the *matching* ``(`` so nested
        parentheses in the institution (``Baidu (China) Co., Ltd``, ``Max Planck
        Institute for Software Systems (MPI-SWS)``) stay intact and a
        parenthesised nickname earlier in the name (``Suqiang (Jack) Song``) is
        not mistaken for the affiliation.
        """
        token = token.strip()
        if not token.endswith(")"):
            return token, ""
        depth = 0
        for index in range(len(token) - 1, -1, -1):
            char = token[index]
            if char == ")":
                depth += 1
            elif char == "(":
                depth -= 1
                if depth == 0:
                    return token[:index].strip(), token[index + 1 : -1].strip()
        return token, ""
