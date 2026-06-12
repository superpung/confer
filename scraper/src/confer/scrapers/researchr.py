"""Adapter for Researchr conference programs (``conf.researchr.org``).

Source-specific options:

    program_url:         the Researchr program or track page (required)
    context:             optional Researchr context id override
    fetch_details:       fetch event detail modals for abstracts (default true)
"""

from __future__ import annotations

import json
import re
import sys
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, NavigableString, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import clean_text, meaningful_abstract, safe_slug, unique_preserve_order
from .base import Scraper


DURATION_RE = re.compile(r"^(?:(\d+)h)?(?:(\d+)m)?$")

PAPER_TRACK_KEYWORDS = (
    "paper",
    "research",
    "technical",
    "journal",
    "demonstration",
    "demo",
    "tool",
    "doctoral",
    "poster",
    "student research",
    "src",
    "industry",
    "practice",
    "education",
    "society",
    "new ideas",
    "emerging",
    "vision",
    "reflection",
    "fose",
)
NON_PAPER_TRACK_KEYWORDS = (
    "keynote",
    "social",
    "workshop",
    "tutorial",
    "catering",
    "break",
    "lunch",
    "dinner",
    "reception",
    "plenary",
    "opening",
    "closing",
    "volunteer",
    "attending",
    "mentoring",
    "new faculty",
    "most influential",
    "technical briefing",
    "open science",
    "submitting",
)
PAPER_EVENT_TYPE_KEYWORDS = (
    "paper",
    "poster",
    "talk",
    "demonstration",
    "presentation",
)
NON_PAPER_EVENT_TYPE_KEYWORDS = (
    "break",
    "coffee",
    "lunch",
    "dinner",
    "keynote",
    "panel",
    "opening",
    "closing",
    "social",
    "meeting",
    "tutorial",
    "award",
    "plenary",
    "reception",
    "other",
)
NON_PAPER_TITLE_PATTERNS = (
    re.compile(r"^q\s*&\s*a$", re.IGNORECASE),
    re.compile(r"^ask me anything$", re.IGNORECASE),
    re.compile(r"^break[- ]?out sessions?$", re.IGNORECASE),
    re.compile(r"^opening$", re.IGNORECASE),
    re.compile(r"^closing$", re.IGNORECASE),
    re.compile(r"\bawards?\b", re.IGNORECASE),
    re.compile(r"\bbusiness meeting\b", re.IGNORECASE),
    re.compile(r"\bpc chair's report\b", re.IGNORECASE),
    re.compile(r"\borganisers? discussion\b", re.IGNORECASE),
    re.compile(r"\borganizers? discussion\b", re.IGNORECASE),
    re.compile(r"\bpanel\b", re.IGNORECASE),
    re.compile(r"^welc?ome from the general chair\b", re.IGNORECASE),
)


@dataclass
class ResearchrModalConfig:
    action_url: str
    action_name: str
    context: str
    event_input_name: str
    form_name: str = ""
    placeholder_id: str = "event-modal-loader"


@dataclass
class ResearchrOccurrence:
    event_id: str
    slot_id: str
    title: str
    event_type: str
    tracks: list[str]
    facet_tracks: list[str]
    authors: list[str]
    author_institutions: str
    session_id: str
    session_title: str
    date: str
    location: str
    urls: list[str] = field(default_factory=list)


@dataclass
class ResearchrEvent:
    event_id: str
    title: str
    event_types: list[str]
    tracks: list[str]
    facet_tracks: list[str]
    authors: list[str]
    author_institutions: str
    slot_ids: list[str]
    session_ids: list[str]
    session_titles: list[str]
    dates: list[str]
    locations: list[str]
    urls: list[str]


@dataclass
class ResearchrDetail:
    title: str = ""
    abstract: str = ""
    url: str = ""
    urls: list[str] = field(default_factory=list)
    authors: list[str] = field(default_factory=list)
    author_institutions: str = ""
    tracks: list[str] = field(default_factory=list)
    session_title: str = ""
    date: str = ""
    location: str = ""


class ResearchrScraper(Scraper):
    name = "researchr"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        program_url = venue.source.get("program_url") or venue.source.get("url")
        if not program_url:
            raise ValueError(f"Venue {venue.id!r}: researchr requires source.program_url")
        self.program_url = str(program_url)
        self.context = str(venue.source.get("context") or self._infer_context(self.program_url))
        self.fetch_details = bool(venue.source.get("fetch_details", True))
        self.track_prefix = str(venue.source.get("track_prefix") or venue.series or "")

    def scrape(self) -> list[Paper]:
        html = self.fetcher.get_text(self.program_url, "program.html")
        occurrences, modal_config = self.parse_program(html)
        paper_tracks = self.infer_paper_tracks(html, occurrences)
        kept = [occ for occ in occurrences if self.keep_occurrence(occ, paper_tracks)]
        events = self.merge_occurrences(kept)
        selected = events[: self.limit] if self.limit else events
        print(
            f"[{self.venue.id}] {len(selected)} Researchr events selected "
            f"from {len(occurrences)} program rows.",
            file=sys.stderr,
        )

        details = self.crawl_details(selected, modal_config) if self.fetch_details else {}
        papers = [self.to_paper(event, details.get(event.event_id)) for event in selected]
        return [paper for paper in papers if self.keep_paper(paper)]

    def _abs(self, href: str) -> str:
        return urljoin(self.program_url, href) if href else ""

    @staticmethod
    def _infer_context(program_url: str) -> str:
        parts = [part for part in urlparse(program_url).path.split("/") if part]
        if "program" in parts:
            idx = parts.index("program")
            if idx + 1 < len(parts):
                return parts[idx + 1]
        if "track" in parts:
            idx = parts.index("track")
            if idx + 1 < len(parts):
                candidate = parts[idx + 1]
                if re.search(r"-20\d{2}$", candidate):
                    return candidate
        return ""

    def is_track_page(self) -> bool:
        return "/track/" in urlparse(self.program_url).path

    def _normalize_track(self, value: str) -> str:
        track = re.sub(r"\s+", " ", value or "").strip()
        prefix = f"{self.track_prefix} " if self.track_prefix else ""
        if prefix and track.startswith(prefix):
            return track[len(prefix) :].strip()
        return track

    def parse_program(
        self, html: str
    ) -> tuple[list[ResearchrOccurrence], ResearchrModalConfig | None]:
        soup = BeautifulSoup(html, "html.parser")
        modal_config = self.parse_modal_config(soup)
        occurrences: list[ResearchrOccurrence] = []
        for table in soup.select("table.session-table"):
            session = self.parse_session(table)
            for row in table.select("tr[data-slot-id]"):
                occurrence = self.parse_occurrence(row, session)
                if occurrence:
                    occurrences.append(occurrence)
        for node in soup.select("div[data-slot-id]"):
            occurrence = self.parse_timeline_occurrence(node)
            if occurrence:
                occurrences.append(occurrence)
        for row in soup.select("#event-overview table tr"):
            occurrence = self.parse_overview_occurrence(row)
            if occurrence:
                occurrences.append(occurrence)
        return occurrences, modal_config

    def infer_paper_tracks(self, html: str, occurrences: list[ResearchrOccurrence]) -> set[str]:
        """Infer the paper-bearing tracks from the linked page.

        Track pages are already scoped by the URL, so keep every track observed on
        the page. Full program pages can include co-hosted events and workshops;
        for those, use the page's own track navigation plus broad paper-track
        naming heuristics.
        """
        observed = set(self.observed_tracks(occurrences))
        if not observed:
            return set()
        if self.is_track_page():
            return observed

        primary_tracks = set(self.primary_nav_tracks(html))
        candidates = observed.intersection(primary_tracks) if primary_tracks else observed
        paper_tracks = {track for track in candidates if self.looks_like_paper_track(track)}
        return paper_tracks or candidates

    @staticmethod
    def observed_tracks(occurrences: list[ResearchrOccurrence]) -> list[str]:
        return unique_preserve_order(
            [track for occurrence in occurrences for track in occurrence.tracks + occurrence.facet_tracks if track]
        )

    def primary_nav_tracks(self, html: str) -> list[str]:
        soup = BeautifulSoup(html, "html.parser")
        tracks: list[str] = []
        for anchor in soup.select('#tracks-in-navbar a[href*="/track/"]'):
            href = self._abs(anchor.get("href", ""))
            if self.context and f"/track/{self.context}/" not in urlparse(href).path:
                continue
            label = self._normalize_track(clean_text(anchor))
            if label:
                tracks.append(label)
        return unique_preserve_order(tracks)

    @staticmethod
    def looks_like_paper_track(track: str) -> bool:
        lowered = track.lower()
        if any(keyword in lowered for keyword in NON_PAPER_TRACK_KEYWORDS):
            return False
        return any(keyword in lowered for keyword in PAPER_TRACK_KEYWORDS)

    @staticmethod
    def looks_like_paper_event_type(event_type: str) -> bool:
        lowered = event_type.lower().strip()
        if not lowered:
            return True
        if any(keyword in lowered for keyword in NON_PAPER_EVENT_TYPE_KEYWORDS):
            return False
        return any(keyword in lowered for keyword in PAPER_EVENT_TYPE_KEYWORDS)

    def parse_modal_config(self, soup: BeautifulSoup) -> ResearchrModalConfig | None:
        loader = soup.select_one("#event-modal-loader")
        form = loader.select_one("form[action]") if loader else None
        if form is None:
            return None
        event_input = form.select_one("input.event-id-input[name]")
        action_anchor = form.select_one("#load-modal-action[submitid], a[submitid]")
        if event_input is None or action_anchor is None:
            return None
        context_input = form.select_one('input[name="context"]')
        context = context_input.get("value", "") if context_input else self.context
        return ResearchrModalConfig(
            action_url=self._abs(form.get("action", "")),
            action_name=action_anchor.get("submitid", ""),
            context=context or self.context,
            event_input_name=event_input.get("name", ""),
            form_name=form.get("name", "") or form.get("id", ""),
        )

    def parse_session(self, table: Tag) -> dict[str, str]:
        detail = table.select_one("tr.session-details")
        info = detail.select_one(".session-info-in-table") if detail else None
        slot_label = clean_text(detail.select_one(".slot-label")) if detail else ""
        location = clean_text(info.select_one(".room-link")) if info else ""
        if not location:
            location = table.get("data-facet-room", "")
        session_title = self.parse_session_title(info)
        date = table.get("data-facet-date", "")
        return {
            "date": date,
            "location": location,
            "slot_label": slot_label,
            "title": session_title,
            "id": safe_slug(f"{date}-{location}-{slot_label}-{session_title}"),
        }

    @staticmethod
    def parse_session_title(info: Tag | None) -> str:
        if info is None:
            return ""
        chunks: list[str] = []
        for child in info.children:
            if isinstance(child, NavigableString):
                text = str(child).strip()
                if text:
                    chunks.append(text)
                continue
            if not isinstance(child, Tag):
                continue
            classes = child.get("class") or []
            if child.name in {"br", "p"} or "pull-right" in classes or "room-link" in classes:
                break
            text = clean_text(child)
            if text:
                chunks.append(text)
        title = re.sub(r"\s+", " ", " ".join(chunks)).strip()
        if title:
            return title
        fallback = clean_text(info)
        return re.split(r"\s+at\s+|\s+Chair\(s\):", fallback, maxsplit=1)[0].strip()

    def parse_occurrence(
        self, row: Tag, session: dict[str, str]
    ) -> ResearchrOccurrence | None:
        title_anchor = row.select_one("a[data-event-modal]")
        if title_anchor is None:
            return None
        event_id = title_anchor.get("data-event-modal", "")
        if not event_id:
            return None

        tracks = unique_preserve_order(
            [
                self._normalize_track(clean_text(node))
                for node in row.select(".prog-track")
                if clean_text(node)
            ]
        )
        facet_tracks = unique_preserve_order(
            [
                self._normalize_track(str(node.get("data-facet-track", "")))
                for node in row.select("[data-facet-track]")
                if node.get("data-facet-track")
            ]
        )
        people = self.parse_people(row.select_one(".performers"))
        urls = [
            self._abs(anchor.get("href", ""))
            for anchor in row.select("a.publication-link[href]")
            if anchor.get("href") and anchor.get("href") != "#"
        ]

        date = self.format_event_date(
            session.get("date", ""),
            clean_text(row.select_one(".start-time")),
            clean_text(row.select_one(".text-muted strong")),
        )
        return ResearchrOccurrence(
            event_id=event_id,
            slot_id=row.get("data-slot-id", ""),
            title=self.parse_event_title(title_anchor),
            event_type=clean_text(row.select_one(".event-type")),
            tracks=tracks,
            facet_tracks=facet_tracks,
            authors=[person["name"] for person in people if person.get("name")],
            author_institutions="; ".join(
                f"{person['name']} ({person['institution']})"
                if person.get("institution")
                else person["name"]
                for person in people
                if person.get("name")
            ),
            session_id=session.get("id", ""),
            session_title=session.get("title", ""),
            date=date,
            location=session.get("location", ""),
            urls=unique_preserve_order(urls),
        )

    def parse_timeline_occurrence(self, node: Tag) -> ResearchrOccurrence | None:
        title_anchor = node.select_one("a[data-event-modal]")
        if title_anchor is None:
            return None
        event_id = title_anchor.get("data-event-modal", "")
        if not event_id:
            return None

        track = self._normalize_track(str(node.get("data-facet-track", "")))
        date = str(node.get("data-facet-date", ""))
        location = str(node.get("data-facet-room", ""))
        time_range = clean_text(node.select_one(".small .pull-left"))
        session_id = safe_slug(f"{date}-{location}-{time_range}-{track}")

        return ResearchrOccurrence(
            event_id=event_id,
            slot_id=node.get("data-slot-id", ""),
            title=self.parse_timeline_title(title_anchor, track),
            event_type="",
            tracks=unique_preserve_order([track]),
            facet_tracks=unique_preserve_order([track]),
            authors=[],
            author_institutions="",
            session_id=session_id,
            session_title=track,
            date=self.combine_date_time(date, time_range),
            location=location,
            urls=[],
        )

    def parse_overview_occurrence(self, row: Tag) -> ResearchrOccurrence | None:
        title_anchor = row.select_one("a[data-event-modal]")
        if title_anchor is None:
            return None
        event_id = title_anchor.get("data-event-modal", "")
        if not event_id:
            return None

        tracks = unique_preserve_order(
            [
                self._normalize_track(clean_text(node))
                for node in row.select(".prog-track")
                if clean_text(node)
            ]
        )
        people = self.parse_people(row.select_one(".performers"))
        session_title = tracks[0] if tracks else self.venue.name
        return ResearchrOccurrence(
            event_id=event_id,
            slot_id=event_id,
            title=self.parse_event_title(title_anchor),
            event_type="Paper",
            tracks=tracks,
            facet_tracks=tracks,
            authors=[person["name"] for person in people if person.get("name")],
            author_institutions="; ".join(
                f"{person['name']} ({person['institution']})"
                if person.get("institution")
                else person["name"]
                for person in people
                if person.get("name")
            ),
            session_id=safe_slug(f"{self.venue.id}-{session_title}"),
            session_title=session_title,
            date="",
            location="",
            urls=[],
        )

    @staticmethod
    def parse_timeline_title(anchor: Tag, track: str = "") -> str:
        event = anchor.select_one(".event-elem")
        if event is not None:
            candidates: list[str] = []
            for node in event.find_all("div", recursive=False):
                text = clean_text(node)
                if not text:
                    continue
                strong = clean_text(node.select_one("strong"))
                if strong and text == strong:
                    continue
                if track and text == track:
                    continue
                candidates.append(text)
            if candidates:
                return candidates[-1]
        return ResearchrScraper.parse_event_title(anchor)

    @staticmethod
    def combine_date_time(date: str, time_range: str) -> str:
        if date and time_range:
            return f"{date} {time_range}"
        return date or time_range

    @staticmethod
    def parse_event_title(anchor: Tag) -> str:
        chunks: list[str] = []

        def collect(node: Tag | NavigableString) -> None:
            if isinstance(node, NavigableString):
                text = str(node).strip()
                if text:
                    chunks.append(text)
                return
            classes = node.get("class") or []
            if any(skip in classes for skip in ("pull-right", "output-badge", "label")):
                return
            for child in node.children:
                if isinstance(child, (Tag, NavigableString)):
                    collect(child)

        collect(anchor)
        return re.sub(r"\s+", " ", " ".join(chunks)).strip()

    @staticmethod
    def parse_people(container: Tag | None) -> list[dict[str, str]]:
        if container is None:
            return []
        people: list[dict[str, str]] = []
        for anchor in container.select('a[href*="/profile/"]'):
            name = clean_text(anchor)
            if not name:
                continue
            institution = ""
            sibling = anchor.next_sibling
            while sibling is not None:
                if isinstance(sibling, Tag) and sibling.name == "a":
                    break
                if isinstance(sibling, Tag) and "prog-aff" in (sibling.get("class") or []):
                    institution = clean_text(sibling)
                    break
                sibling = sibling.next_sibling
            people.append({"name": name, "institution": institution})
        return people

    @staticmethod
    def parse_modal_people(container: Tag | None) -> list[dict[str, str]]:
        if container is None:
            return []
        people: list[dict[str, str]] = []
        for anchor in container.select('a[href*="/profile/"]'):
            body = anchor.select_one(".media-body")
            if body is None:
                name = clean_text(anchor)
                institution = ""
            else:
                name_heading = body.select_one(".media-heading")
                institution = clean_text(body.select_one(".text-black"))
                if name_heading is None:
                    name = clean_text(anchor)
                else:
                    name, visual_institution = ResearchrScraper.parse_modal_name_heading(name_heading, institution)
                    institution = institution or visual_institution
            if name:
                people.append({"name": name, "institution": institution})
        return people

    @staticmethod
    def parse_modal_name_heading(name_heading: Tag, institution: str = "") -> tuple[str, str]:
        heading = BeautifulSoup(str(name_heading), "html.parser").find(class_="media-heading")
        if heading is None:
            heading = name_heading
        for node in heading.select(".pull-right"):
            node.extract()

        separator = heading.select_one(".name-visual-sep")
        if separator is None or institution:
            return clean_text(heading), ""

        before = "".join(str(sibling) for sibling in reversed(list(separator.previous_siblings)))
        after = "".join(str(sibling) for sibling in separator.next_siblings)
        name = clean_text(BeautifulSoup(before, "html.parser"))
        visual_institution = clean_text(BeautifulSoup(after, "html.parser"))
        return name or clean_text(heading), visual_institution

    @classmethod
    def format_event_date(cls, date: str, start: str, duration: str) -> str:
        if not date:
            return ""
        if not start:
            return date
        minutes = cls.parse_duration_minutes(duration)
        if minutes is None:
            return f"{date} {start}"
        try:
            start_dt = datetime.strptime(f"{date} {start}", "%a %d %b %Y %H:%M")
        except ValueError:
            return f"{date} {start}"
        end_dt = start_dt + timedelta(minutes=minutes)
        return f"{date} {start} - {end_dt.strftime('%H:%M')}"

    @staticmethod
    def parse_duration_minutes(duration: str) -> int | None:
        compact = re.sub(r"\s+", "", duration or "")
        match = DURATION_RE.match(compact)
        if not match:
            return None
        hours = int(match.group(1) or 0)
        minutes = int(match.group(2) or 0)
        total = hours * 60 + minutes
        return total if total else None

    def keep_occurrence(
        self,
        occurrence: ResearchrOccurrence,
        paper_tracks: set[str] | None = None,
    ) -> bool:
        if not occurrence.title:
            return False
        if not self.looks_like_paper_event_type(occurrence.event_type):
            return False
        if paper_tracks:
            track_names = set(occurrence.tracks + occurrence.facet_tracks)
            if not track_names.intersection(paper_tracks):
                return False
        return True

    @staticmethod
    def merge_occurrences(occurrences: list[ResearchrOccurrence]) -> list[ResearchrEvent]:
        grouped: OrderedDict[str, ResearchrEvent] = OrderedDict()
        for occurrence in occurrences:
            event = grouped.get(occurrence.event_id)
            if event is None:
                grouped[occurrence.event_id] = ResearchrEvent(
                    event_id=occurrence.event_id,
                    title=occurrence.title,
                    event_types=unique_preserve_order([occurrence.event_type]),
                    tracks=list(occurrence.tracks),
                    facet_tracks=list(occurrence.facet_tracks),
                    authors=list(occurrence.authors),
                    author_institutions=occurrence.author_institutions,
                    slot_ids=unique_preserve_order([occurrence.slot_id]),
                    session_ids=unique_preserve_order([occurrence.session_id]),
                    session_titles=unique_preserve_order([occurrence.session_title]),
                    dates=unique_preserve_order([occurrence.date]),
                    locations=unique_preserve_order([occurrence.location]),
                    urls=list(occurrence.urls),
                )
                continue

            event.event_types = unique_preserve_order(event.event_types + [occurrence.event_type])
            event.tracks = unique_preserve_order(event.tracks + occurrence.tracks)
            event.facet_tracks = unique_preserve_order(event.facet_tracks + occurrence.facet_tracks)
            event.slot_ids = unique_preserve_order(event.slot_ids + [occurrence.slot_id])
            event.session_ids = unique_preserve_order(event.session_ids + [occurrence.session_id])
            event.session_titles = unique_preserve_order(event.session_titles + [occurrence.session_title])
            event.dates = unique_preserve_order(event.dates + [occurrence.date])
            event.locations = unique_preserve_order(event.locations + [occurrence.location])
            event.urls = unique_preserve_order(event.urls + occurrence.urls)
            if not event.authors and occurrence.authors:
                event.authors = list(occurrence.authors)
                event.author_institutions = occurrence.author_institutions

        return sorted(grouped.values(), key=lambda event: event.event_id)

    def crawl_details(
        self,
        events: list[ResearchrEvent],
        modal_config: ResearchrModalConfig | None,
    ) -> dict[str, ResearchrDetail]:
        if modal_config is None:
            print(f"[{self.venue.id}] no Researchr modal loader found; skipping details.", file=sys.stderr)
            return {}

        def fetch_one(event: ResearchrEvent) -> tuple[str, ResearchrDetail]:
            payload = [
                (modal_config.action_name, "1"),
                ("__ajax_runtime_request__", modal_config.placeholder_id),
                ("context", modal_config.context),
            ]
            if modal_config.form_name:
                payload.append((modal_config.form_name, "1"))
            payload.append((modal_config.event_input_name, event.event_id))
            response = self.fetcher.post_text(
                modal_config.action_url,
                f"modals/{safe_slug(event.event_id)}.json",
                payload,
            )
            return event.event_id, self.parse_modal_response(response)

        if self.workers <= 1:
            return dict(fetch_one(event) for event in events)

        details: dict[str, ResearchrDetail] = {}
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(fetch_one, event): event for event in events}
            completed = 0
            for future in as_completed(futures):
                event = futures[future]
                completed += 1
                try:
                    event_id, detail = future.result()
                    details[event_id] = detail
                except Exception as exc:  # noqa: BLE001 - keep the crawl resilient
                    print(f"[{self.venue.id}] detail fetch failed for {event.event_id}: {exc}", file=sys.stderr)
                if completed % 100 == 0:
                    print(f"[{self.venue.id}] fetched {completed}/{len(events)} detail modals...", file=sys.stderr)
        return details

    def parse_modal_response(self, text: str) -> ResearchrDetail:
        html = ""
        try:
            commands = json.loads(text)
        except json.JSONDecodeError:
            html = text
        else:
            html = "".join(
                str(command.get("value", ""))
                for command in commands
                if command.get("action") in {"append", "replace"}
            )

        soup = BeautifulSoup(html, "html.parser")
        title_node = soup.select_one(".event-title h4")
        title = self.parse_event_title(title_node) if title_node else ""

        header = soup.select_one(".modal-header")
        header_track = clean_text(header.select_one("p.text-muted")) if header else ""
        tracks = unique_preserve_order([self._normalize_track(header_track)])
        date = ""
        location = ""
        session_title = ""
        if header is not None:
            time_node = header.select_one("strong")
            time_text = clean_text(time_node)
            if " at " in time_text:
                date, location = [part.strip() for part in time_text.split(" at ", maxsplit=1)]
            else:
                date = time_text
            session_title = clean_text(header.select_one("strong ~ a.navigate"))

        detail_links = [
            self._abs(anchor.get("href", ""))
            for anchor in soup.select('a[href*="/details/"]')
            if anchor.get("href")
        ]
        detail_url = detail_links[0] if detail_links else ""

        description = soup.select_one(".event-description")
        abstract = ""
        extra_urls: list[str] = []
        people = self.parse_modal_people(description)
        if description is not None:
            paragraphs = [
                clean_text(paragraph)
                for paragraph in description.find_all("p", recursive=False)
                if clean_text(paragraph)
            ]
            abstract = " ".join(paragraphs)
            if not abstract:
                for row in description.select(".row"):
                    row.extract()
                abstract = clean_text(description)
            abstract = meaningful_abstract(abstract)
            extra_urls = [
                self._abs(anchor.get("href", ""))
                for anchor in description.select("a[href]")
                if anchor.get("href")
                and "/profile/" not in anchor.get("href", "")
                and "/details/" not in anchor.get("href", "")
            ]

        return ResearchrDetail(
            title=title,
            abstract=abstract,
            url=detail_url,
            urls=unique_preserve_order(extra_urls),
            authors=[person["name"] for person in people if person.get("name")],
            author_institutions="; ".join(
                f"{person['name']} ({person['institution']})"
                if person.get("institution")
                else person["name"]
                for person in people
                if person.get("name")
            ),
            tracks=tracks,
            session_title=session_title,
            date=date,
            location=location,
        )

    def to_paper(self, event: ResearchrEvent, detail: ResearchrDetail | None = None) -> Paper:
        detail = detail or ResearchrDetail()
        urls = unique_preserve_order([detail.url] + event.urls + detail.urls + [self.program_url])
        tracks = unique_preserve_order(event.tracks + detail.tracks)
        authors = event.authors or detail.authors
        session_titles = unique_preserve_order(event.session_titles + [detail.session_title])
        dates = unique_preserve_order(event.dates + [detail.date])
        locations = unique_preserve_order(event.locations + [detail.location])
        event_types = unique_preserve_order([event_type for event_type in event.event_types if event_type])
        if not event_types:
            event_types = ["Paper"]
        return Paper(
            id=event.event_id,
            title=detail.title or event.title,
            abstract=detail.abstract,
            authors=list(authors),
            author_institutions=event.author_institutions or detail.author_institutions,
            tracks=tracks,
            event_type="; ".join(event_types),
            session_titles=session_titles,
            sessions=unique_preserve_order(event.session_ids),
            dates=dates,
            locations=locations,
            urls=urls,
        )

    def keep_paper(self, paper: Paper) -> bool:
        if not paper.title:
            return False
        if self.looks_like_non_paper_title(paper.title):
            return False
        if not self.looks_like_paper_event_type(paper.event_type):
            return False
        return True

    @staticmethod
    def looks_like_non_paper_title(title: str) -> bool:
        normalized = re.sub(r"\s+", " ", title or "").strip()
        return any(pattern.search(normalized) for pattern in NON_PAPER_TITLE_PATTERNS)
