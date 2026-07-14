"""Adapter for the official IEEE S&P (Oakland) accepted-papers page.

The IEEE Symposium on Security and Privacy publishes its accepted papers on its
own site (``sp<year>.ieee-security.org/accepted-papers.html``) as a static HTML
page. Unlike the DBLP bibliography, this first-party source lists **author
affiliations** for every paper, using a compact superscript notation:

    <div class="list-group-item">
      <b><a ...>PAC-Private Algorithms <span class="glyphicon ..."></span></a></b>
      <div class="collapse authorlist">
        Mayuri Sridhar<sup>1</sup>, Hanshen Xiao<sup>2,3</sup>, Srinivas Devadas<sup>1</sup>
        <sup>1</sup>: MIT, <sup>2</sup>: Purdue University, <sup>3</sup>: NVIDIA Research
      </div>
    </div>

Some entries share a single institution for all authors and drop the
superscripts entirely (``Alex Ozdemir, Evan Laufer, Dan Boneh`` / ``Stanford
University``). Papers are grouped into review-cycle tabs (``Cycle 1`` / ``Cycle
2``); the adapter records the cycle as the session title.

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
from ..util import cache_name_for_url, strip_markup, title_slug, unique_preserve_order
from .base import Scraper


BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
SUP_RE = re.compile(r"<sup>(.*?)</sup>", re.IGNORECASE | re.DOTALL)
AFFIL_MARKER_RE = re.compile(r"<sup>\s*([\d,\s]+?)\s*</sup>\s*:?", re.IGNORECASE | re.DOTALL)
NUM_RE = re.compile(r"\d+")
NUM_SEP = "\x00"


class IeeeSpScraper(Scraper):
    name = "ieeesp"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        accepted_url = venue.source.get("accepted_url") or venue.source.get("url")
        if not accepted_url:
            raise ValueError(f"Venue {venue.id!r}: ieeesp requires source.accepted_url")
        self.accepted_url = str(accepted_url)

    def scrape(self) -> list[Paper]:
        html = self.fetcher.get_text(self.accepted_url, cache_name_for_url(self.accepted_url))
        papers = self.parse_papers(html)
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} IEEE S&P papers parsed from the "
            f"official accepted-papers page.",
            file=sys.stderr,
        )
        return selected

    def parse_papers(self, html: str) -> list[Paper]:
        soup = BeautifulSoup(html, "html.parser")
        labels = self.cycle_labels(soup)

        panels = [panel for panel in soup.select(".tab-pane") if panel.get("id")]
        containers: list[tuple[Tag, str]] = (
            [(panel, labels.get(str(panel.get("id")), "")) for panel in panels]
            if panels
            else [(soup, "")]
        )

        papers: list[Paper] = []
        seen: set[str] = set()
        for container, cycle in containers:
            for item in container.select(".list-group-item"):
                paper = self.parse_item(item, cycle, seen)
                if paper is not None:
                    papers.append(paper)
        return sorted(papers, key=lambda paper: paper.id)

    @staticmethod
    def cycle_labels(soup: BeautifulSoup) -> dict[str, str]:
        labels: dict[str, str] = {}
        for anchor in soup.select("ul.nav-tabs a[data-toggle='tab']"):
            href = str(anchor.get("href", "")).lstrip("#")
            text = anchor.get_text(" ", strip=True)
            if href and text:
                labels[href] = text
        return labels

    def parse_item(self, item: Tag, cycle: str, seen: set[str]) -> Paper | None:
        authorlist = item.select_one(".authorlist")
        if authorlist is None:
            return None
        title_node = item.find("b")
        title = self.clean_title(title_node.get_text(" ", strip=True) if title_node else "")
        if not title:
            return None
        authors, author_institutions = self.parse_authorlist(authorlist)

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
            session_titles=[cycle] if cycle else [],
            urls=[self.accepted_url],
            container=self.venue.name,
        )

    @staticmethod
    def clean_title(title: str) -> str:
        title = re.sub(r"\s+", " ", strip_markup(title or "")).strip()
        if title.endswith(".") and not title.endswith(("?", "!")):
            title = title[:-1]
        return title

    def parse_authorlist(self, authorlist: Tag) -> tuple[list[str], str]:
        head, tail = self.split_authorlist(authorlist.decode_contents())
        authors = self.parse_authors(head)
        affils = self.parse_affiliations(tail)

        names = [name for name, _ in authors]
        display: list[str] = []
        for name, nums in authors:
            institution = self.institution_for(nums, affils)
            display.append(f"{name} ({institution})" if institution else name)
        return names, "; ".join(display)

    @staticmethod
    def split_authorlist(raw: str) -> tuple[str, str]:
        parts = BR_RE.split(raw, maxsplit=1)
        head = parts[0]
        tail = parts[1] if len(parts) > 1 else ""
        return head, tail

    @staticmethod
    def parse_authors(authors_html: str) -> list[tuple[str, list[str]]]:
        def mark(match: re.Match[str]) -> str:
            numbers = ";".join(NUM_RE.findall(match.group(1)))
            return f"{NUM_SEP}{numbers}{NUM_SEP}"

        marked = SUP_RE.sub(mark, authors_html)
        text = BeautifulSoup(marked, "html.parser").get_text()
        authors: list[tuple[str, list[str]]] = []
        for token in text.split(","):
            token = token.strip()
            if not token:
                continue
            marker = re.search(rf"{NUM_SEP}([\d;]*){NUM_SEP}", token)
            nums = [n for n in marker.group(1).split(";") if n] if marker else []
            name = re.sub(rf"{NUM_SEP}[\d;]*{NUM_SEP}", "", token).strip()
            name = re.sub(r"\s+", " ", name)
            if name:
                authors.append((name, nums))
        return authors

    @staticmethod
    def parse_affiliations(affil_html: str) -> dict[str, str]:
        if not affil_html.strip():
            return {}
        if "<sup" not in affil_html.lower():
            institution = BeautifulSoup(affil_html, "html.parser").get_text(" ", strip=True)
            institution = institution.strip().strip(",").strip()
            return {"__all__": institution} if institution else {}

        mapping: dict[str, str] = {}
        markers = list(AFFIL_MARKER_RE.finditer(affil_html))
        for index, match in enumerate(markers):
            start = match.end()
            end = markers[index + 1].start() if index + 1 < len(markers) else len(affil_html)
            institution = BeautifulSoup(affil_html[start:end], "html.parser").get_text(" ", strip=True)
            institution = institution.strip().strip(",").strip()
            if not institution:
                continue
            for number in NUM_RE.findall(match.group(1)):
                mapping[number] = institution
        return mapping

    @staticmethod
    def institution_for(nums: list[str], affils: dict[str, str]) -> str:
        if "__all__" in affils:
            return affils["__all__"]
        institutions = unique_preserve_order([affils[n] for n in nums if n in affils])
        return " / ".join(institutions)
