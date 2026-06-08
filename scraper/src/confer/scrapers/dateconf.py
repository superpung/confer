"""Adapter for DATE Conference programme pages (``date-conference.com``)."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, NavigableString, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import clean_text, safe_slug, unique_preserve_order
from .base import Scraper


NATURAL_RE = re.compile(r"(\d+)")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
INSTITUTION_MARKERS = (
    "academy",
    "ag",
    "arm",
    "bosch",
    "cadence",
    "cea",
    "cnrs",
    "college",
    "company",
    "corp",
    "corporation",
    "department",
    "ecole",
    "fraunhofer",
    "gmbh",
    "google",
    "ibm",
    "imec",
    "inc",
    "institute",
    "institut",
    "intel",
    "laboratories",
    "laboratory",
    "lab",
    "labs",
    "ltd",
    "microsoft",
    "nvidia",
    "politecnico",
    "research",
    "center",
    "centre",
    "samsung",
    "school",
    "siemens",
    "synopsys",
    "technology",
    "technologies",
    "tu ",
    "universit",
)


@dataclass
class DateSession:
    session_id: str
    title: str
    date: str = ""
    time: str = ""
    location: str = ""


def natural_key(value: str) -> tuple:
    return tuple(
        int(chunk) if chunk.isdigit() else chunk
        for chunk in NATURAL_RE.split(value or "")
    )


class DateConfScraper(Scraper):
    name = "dateconf"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        program_url = venue.source.get("program_url") or venue.source.get("url")
        if not program_url:
            raise ValueError(f"Venue {venue.id!r}: dateconf requires source.program_url")
        self.program_url = str(program_url)

    def scrape(self) -> list[Paper]:
        html = self.fetcher.get_text(self.program_url, "program.html")
        papers = self.parse_program(html)
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} DATE papers selected "
            f"from {len(papers)} downloadable programme rows.",
            file=sys.stderr,
        )
        return selected

    def _abs(self, href: str) -> str:
        return urljoin(self.program_url, href) if href else ""

    def parse_program(self, html: str) -> list[Paper]:
        soup = BeautifulSoup(html, "html.parser")
        papers: list[Paper] = []
        for heading in soup.select("h2"):
            if "h2day" in (heading.get("class") or []):
                continue
            session, table = self.parse_session_block(heading)
            if table is None:
                continue
            for row in table.select("tr"):
                paper = self.parse_presentation_row(row, session)
                if paper:
                    papers.append(paper)
        return sorted(papers, key=lambda paper: natural_key(paper.id))

    def parse_session_block(self, heading: Tag) -> tuple[DateSession, Tag | None]:
        title = clean_text(heading)
        session_id = title.split(maxsplit=1)[0] if title else ""
        session = DateSession(session_id=session_id, title=title)
        table: Tag | None = None

        for sibling in heading.find_next_siblings():
            if not isinstance(sibling, Tag):
                continue
            if sibling.name == "h2":
                break
            if sibling.name == "table":
                table = sibling
                break
            text = clean_text(sibling)
            if "Date:" in text and "Time:" in text:
                session.date = self.extract_between(text, "Date:", "Time:")
                session.time = self.extract_between(text, "Time:", "Location / Room:")
                session.location = self.extract_after(text, "Location / Room:")

        return session, table

    @staticmethod
    def extract_between(text: str, start: str, end: str) -> str:
        match = re.search(
            rf"{re.escape(start)}\s*(.*?)\s*{re.escape(end)}",
            text,
            flags=re.IGNORECASE,
        )
        return match.group(1).strip() if match else ""

    @staticmethod
    def extract_after(text: str, marker: str) -> str:
        match = re.search(rf"{re.escape(marker)}\s*(.*)$", text, flags=re.IGNORECASE)
        return match.group(1).strip() if match else ""

    def parse_presentation_row(self, row: Tag, session: DateSession) -> Paper | None:
        cells = row.find_all("td", recursive=False)
        if len(cells) != 3:
            return None
        time = clean_text(cells[0])
        label = clean_text(cells[1])
        body = cells[2]
        download = body.find("a", string=lambda text: bool(text and "Download Paper" in text))
        if not label or download is None:
            return None

        title = clean_text(body.find("b"))
        if not title:
            return None

        lines = self.split_lines(body)
        authors, author_institutions = self.parse_authors(lines)
        abstract = self.parse_abstract(body)
        track = self.track_for_session(session.session_id)
        date = " ".join(part for part in (session.date, time or session.time) if part)
        download_url = self._abs(download.get("href", ""))
        return Paper(
            id=label,
            title=title,
            abstract=abstract,
            authors=authors,
            author_institutions=author_institutions,
            tracks=[track],
            event_type=track,
            session_titles=[session.title],
            sessions=[safe_slug(session.session_id or session.title)],
            dates=[date] if date else [],
            locations=[session.location] if session.location else [],
            urls=unique_preserve_order([download_url, self.program_url]),
            pdf_urls=[download_url] if download_url.lower().endswith(".pdf") else [],
        )

    @staticmethod
    def split_lines(cell: Tag) -> list[list[Tag | NavigableString]]:
        lines: list[list[Tag | NavigableString]] = []
        current: list[Tag | NavigableString] = []
        for child in cell.children:
            if isinstance(child, Tag) and child.name == "br":
                if DateConfScraper.line_text(current):
                    lines.append(current)
                current = []
                continue
            if isinstance(child, NavigableString):
                if str(child).strip():
                    current.append(child)
                continue
            if isinstance(child, Tag) and clean_text(child):
                current.append(child)
        if DateConfScraper.line_text(current):
            lines.append(current)
        return lines

    @staticmethod
    def line_text(nodes: list[Tag | NavigableString], *, include_sup: bool = False) -> str:
        chunks: list[str] = []
        for node in nodes:
            if isinstance(node, NavigableString):
                chunks.append(str(node))
                continue
            if node.name == "sup" and not include_sup:
                continue
            chunks.append(clean_text(node))
        return re.sub(r"\s+", " ", " ".join(chunks)).strip(" :")

    def parse_authors(self, lines: list[list[Tag | NavigableString]]) -> tuple[list[str], str]:
        label_index = self.find_label_line(lines, {"Authors", "Author"})
        if label_index is None:
            label_index = self.find_label_line(
                lines,
                {"Speaker", "Speaker and Author", "Panelist", "Moderator"},
            )
        if label_index is None or label_index + 1 >= len(lines):
            return [], ""

        author_nodes = lines[label_index + 1]
        affiliation_nodes = lines[label_index + 2] if label_index + 2 < len(lines) else []
        if any(isinstance(node, Tag) and node.name == "sup" for node in author_nodes):
            return self.parse_numbered_authors(author_nodes, affiliation_nodes)

        text = self.line_text(author_nodes)
        names_text, shared_affiliation = self.strip_trailing_affiliation(text)
        authors = self.split_author_names(names_text)
        institutions = self.format_author_institutions(authors, shared_affiliation)
        return authors, institutions

    @staticmethod
    def find_label_line(
        lines: list[list[Tag | NavigableString]],
        labels: set[str],
    ) -> int | None:
        for index, nodes in enumerate(lines):
            first_tag = next((node for node in nodes if isinstance(node, Tag)), None)
            if first_tag and first_tag.name == "b" and clean_text(first_tag) in labels:
                return index
        return None

    def parse_numbered_authors(
        self,
        author_nodes: list[Tag | NavigableString],
        affiliation_nodes: list[Tag | NavigableString],
    ) -> tuple[list[str], str]:
        marked = self.mark_superscripts(author_nodes)
        authors_with_ids: list[tuple[str, list[str]]] = []
        for chunk in re.split(r"\s*,\s*|\s+and\s+", marked):
            chunk = chunk.strip(" ,")
            if not chunk:
                continue
            ids = re.findall(r"\[(.*?)\]", chunk)
            name = re.sub(r"\s*\[.*?\]\s*", " ", chunk).strip()
            if name:
                authors_with_ids.append((name, ids))

        affiliations = self.parse_affiliations(affiliation_nodes)
        authors = [name for name, _ in authors_with_ids]
        institutions = []
        for name, ids in authors_with_ids:
            insts = [affiliations[item] for item in ids if item in affiliations]
            institutions.append(f"{name} ({'; '.join(insts)})" if insts else name)
        return authors, "; ".join(institutions)

    @staticmethod
    def mark_superscripts(nodes: list[Tag | NavigableString]) -> str:
        chunks: list[str] = []
        for node in nodes:
            if isinstance(node, NavigableString):
                chunks.append(str(node))
            elif node.name == "sup":
                chunks.append(f" [{clean_text(node)}] ")
            else:
                chunks.append(clean_text(node))
        return re.sub(r"\s+", " ", " ".join(chunks)).strip()

    def parse_affiliations(self, nodes: list[Tag | NavigableString]) -> dict[str, str]:
        affiliations: dict[str, str] = {}
        current_id = ""
        chunks: list[str] = []

        def flush() -> None:
            if current_id and chunks:
                affiliations[current_id] = re.sub(r"\s+", " ", " ".join(chunks)).strip(" ;")

        for node in nodes:
            if isinstance(node, Tag) and node.name == "sup":
                flush()
                current_id = clean_text(node)
                chunks = []
                continue
            text = self.line_text([node]) if isinstance(node, Tag) else str(node)
            if text.strip():
                chunks.append(text)
        flush()
        return affiliations

    @staticmethod
    def strip_trailing_affiliation(text: str) -> tuple[str, str]:
        parts = [part.strip() for part in text.split(",") if part.strip()]
        if len(parts) < 3 or not COUNTRY_RE.match(parts[-1]):
            return text, ""

        for index in range(1, len(parts) - 1):
            lowered = parts[index].lower()
            if any(marker in lowered for marker in INSTITUTION_MARKERS):
                return ", ".join(parts[:index]), ", ".join(parts[index:])

        return text, ""

    @staticmethod
    def split_author_names(text: str) -> list[str]:
        normalized = re.sub(r"\s+", " ", text).strip()
        normalized = re.sub(r"\s+\band\b\s+", ", ", normalized)
        names = [
            re.sub(r"\s*\d+\s*$", "", part).strip(" ,")
            for part in normalized.split(",")
            if part.strip()
        ]
        return unique_preserve_order([name for name in names if name])

    @staticmethod
    def format_author_institutions(authors: list[str], affiliation: str) -> str:
        if not affiliation:
            return "; ".join(authors)
        return "; ".join(f"{author} ({affiliation})" for author in authors)

    @staticmethod
    def parse_abstract(body: Tag) -> str:
        abstract = clean_text(body.find("em"))
        return re.sub(r"^Abstract\s*:?\s*", "", abstract, flags=re.IGNORECASE).strip()

    @staticmethod
    def track_for_session(session_id: str) -> str:
        prefix = session_id.upper()
        if prefix.startswith("TS"):
            return "Technical Session"
        if prefix.startswith("LBR"):
            return "Late Breaking Results"
        if prefix.startswith("BPA"):
            return "Best Paper Award Candidate"
        if prefix.startswith("FS"):
            return "Focus Session"
        if prefix.startswith("MPP"):
            return "Multi-Partner Project"
        if prefix.startswith("YPP"):
            return "Young People Programme"
        if prefix.startswith("SD"):
            return "Special Day"
        return "Paper"
