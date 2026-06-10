"""Adapter for SIGARCH-style static conference program pages."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import clean_text, safe_slug, unique_preserve_order
from .base import Scraper


NATURAL_RE = re.compile(r"(\d+)")
SESSION_RE = re.compile(r"^Session\s+([^:]+):\s*(.+)$", re.IGNORECASE)
TIME_RE = re.compile(r"\d{1,2}:\d{2}|\d{1,2}\s*(?:AM|PM)", re.IGNORECASE)


@dataclass
class SigarchSession:
    session_id: str
    title: str
    track: str
    date: str = ""
    time: str = ""
    location: str = ""


def natural_key(value: str) -> tuple:
    return tuple(
        int(chunk) if chunk.isdigit() else chunk
        for chunk in NATURAL_RE.split(value or "")
    )


class SigarchScraper(Scraper):
    name = "sigarch"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        program_url = venue.source.get("program_url") or venue.source.get("url")
        if not program_url:
            raise ValueError(f"Venue {venue.id!r}: sigarch requires source.program_url")
        self.program_url = str(program_url)
        self.default_track = venue.name

    def scrape(self) -> list[Paper]:
        html = self.fetcher.get_text(self.program_url, "program.html")
        papers = self.parse_program(html)
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} SIGARCH papers selected "
            f"from {len(papers)} program papers.",
            file=sys.stderr,
        )
        return selected

    def _abs(self, href: str) -> str:
        return urljoin(self.program_url, href) if href else ""

    def parse_program(self, html: str) -> list[Paper]:
        soup = BeautifulSoup(html, "html.parser")
        papers: list[Paper] = []
        seen_ids: set[str] = set()

        for heading in soup.select(".panel-heading"):
            session = self.parse_session(heading)
            if session is None:
                continue
            body = self.panel_body_for_heading(soup, heading)
            if body is None:
                continue
            for paper_node in body.select(".paper"):
                paper = self.parse_paper(paper_node, session)
                if paper is None:
                    continue
                paper_id = paper.id
                if paper_id in seen_ids:
                    paper.id = f"{paper_id}-{len(seen_ids) + 1}"
                seen_ids.add(paper.id)
                papers.append(paper)

        return sorted(papers, key=lambda paper: natural_key(paper.id))

    def parse_session(self, heading: Tag) -> SigarchSession | None:
        title = clean_text(heading.select_one(".panel-title"))
        if not title.lower().startswith("session"):
            return None
        match = SESSION_RE.match(title)
        session_id = match.group(1).strip() if match else safe_slug(title)
        session_topic = match.group(2).strip() if match else title
        location = re.sub(
            r"^Location:\s*",
            "",
            clean_text(heading.select_one(".session-location")),
            flags=re.IGNORECASE,
        )
        return SigarchSession(
            session_id=session_id,
            title=title,
            track=session_topic or self.default_track,
            date=self.find_session_day(heading),
            time=self.find_session_time(heading),
            location=location,
        )

    @staticmethod
    def panel_body_for_heading(soup: BeautifulSoup, heading: Tag) -> Tag | None:
        anchor = heading.select_one("a[href]")
        href = anchor.get("href", "") if anchor else ""
        panel_id = href.rsplit("#", maxsplit=1)[-1] if "#" in href else ""
        if not panel_id:
            return None
        return soup.find(id=panel_id)

    def parse_paper(self, node: Tag, session: SigarchSession) -> Paper | None:
        title = clean_text(node.select_one(".paper-title"))
        if not title:
            return None
        authors_text = clean_text(node.select_one(".paper-authors"))
        authors, author_institutions = self.parse_authors(authors_text)
        paper_time = clean_text(node.select_one(".paper-time"))
        paper_id = self.paper_id_for(session.session_id, title)
        date = " ".join(part for part in (session.date, paper_time or session.time) if part)
        return Paper(
            id=paper_id,
            title=title,
            abstract="",
            authors=authors,
            author_institutions=author_institutions or authors_text,
            tracks=[session.track or self.default_track],
            event_type="Paper",
            session_titles=[session.title],
            sessions=[safe_slug(session.session_id)],
            dates=[date] if date else [],
            locations=[session.location] if session.location else [],
            urls=[self.program_url],
            extra={"sessionTrack": session.track},
        )

    @staticmethod
    def parse_authors(text: str) -> tuple[list[str], str]:
        if not text:
            return [], ""
        parsed: list[tuple[str, str]] = []
        for group in SigarchScraper.split_top_level(text, ";"):
            parsed.extend(SigarchScraper.parse_author_group(group))

        authors = unique_preserve_order([name for name, _ in parsed])
        displays = [
            f"{name} ({institution})" if institution else name
            for name, institution in parsed
        ]
        return authors, "; ".join(displays)

    @staticmethod
    def parse_author_group(group: str) -> list[tuple[str, str]]:
        parsed: list[tuple[str, str]] = []
        cursor = 0
        index = 0
        while index < len(group):
            if group[index] != "(":
                index += 1
                continue

            close, next_cursor = SigarchScraper.find_institution_end(group, index)
            if close is None:
                index += 1
                continue

            names = SigarchScraper.split_names(group[cursor:index])
            institution = group[index + 1 : close].strip()
            parsed.extend((name, institution) for name in names)
            cursor = next_cursor
            index = cursor

        parsed.extend((name, "") for name in SigarchScraper.split_names(group[cursor:]))
        return parsed

    @staticmethod
    def split_top_level(text: str, separator: str) -> list[str]:
        parts: list[str] = []
        depth = 0
        current: list[str] = []
        for char in text:
            if char == "(":
                depth += 1
            elif char == ")" and depth:
                depth -= 1
            if char == separator and depth == 0:
                part = "".join(current).strip()
                if part:
                    parts.append(part)
                current = []
                continue
            current.append(char)
        part = "".join(current).strip()
        if part:
            parts.append(part)
        return parts

    @staticmethod
    def find_institution_end(text: str, start: int) -> tuple[int | None, int]:
        close = SigarchScraper.find_matching_paren(text, start)
        if close is not None:
            return close, close + 1

        boundary = SigarchScraper.find_malformed_institution_boundary(text, start)
        if boundary is not None:
            return boundary, boundary + 1
        return None, start + 1

    @staticmethod
    def find_matching_paren(text: str, start: int) -> int | None:
        depth = 0
        for index, char in enumerate(text[start:], start=start):
            if char == "(":
                depth += 1
            elif char == ")" and depth:
                depth -= 1
                if depth == 0:
                    return index
        return None

    @staticmethod
    def find_malformed_institution_boundary(text: str, start: int) -> int | None:
        depth = 0
        for index, char in enumerate(text[start:], start=start):
            if char == "(":
                depth += 1
            elif char == ")" and depth:
                depth -= 1
            elif char in {",", ";"} and depth == 1:
                if SigarchScraper.looks_like_author_start(text[index + 1 :]):
                    return index
        return None

    @staticmethod
    def looks_like_author_start(text: str) -> bool:
        candidate = text.strip()
        match = re.match(r"([^(),;()]{2,80})\s+\(", candidate)
        if not match:
            return False
        words = match.group(1).split()
        return 1 <= len(words) <= 6

    @staticmethod
    def split_names(text: str) -> list[str]:
        normalized = re.sub(r"\s+", " ", text).strip()
        normalized = re.sub(r"\s+\band\b\s+", ", ", normalized)
        names = [part.strip(" ,);") for part in normalized.split(",") if part.strip(" ,);")]
        return unique_preserve_order(names)

    def paper_id_for(self, session_id: str, title: str) -> str:
        base = safe_slug(session_id).strip("_") or self.venue.id
        return f"{base}-{safe_slug(title)[:80].strip('_')}"

    def find_session_time(self, heading: Tag) -> str:
        for previous in heading.find_all_previous(["h3", "h4"]):
            text = clean_text(previous)
            if text.lower().startswith("session"):
                continue
            if TIME_RE.search(text):
                return text
        return ""

    def find_session_day(self, heading: Tag) -> str:
        for previous in heading.find_all_previous(["h2", "h3", "h4"]):
            text = clean_text(previous)
            if self.looks_like_day(text):
                return self.ensure_year(text)
        return ""

    @staticmethod
    def looks_like_day(text: str) -> bool:
        lowered = text.lower()
        return any(
            day in lowered
            for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
        )

    def ensure_year(self, text: str) -> str:
        if re.search(r"\b20\d{2}\b", text) or not self.venue.year:
            return text
        return f"{text}, {self.venue.year}"
