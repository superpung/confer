"""Adapter for the Linklings program platform (``*.conference-program.com``).

This is the original DAC 2026 scraper, reorganized behind the :class:`Scraper`
interface. All source-specific options come from ``venue.source``:

    base_url:          the conference program root (required)
    prefixes:          presentation-id prefixes to include (default ["RESEARCH"])
    all_presentations: include every presentation type, ignoring prefixes
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import (
    cache_name_for_url,
    clean_text,
    parse_query,
    safe_slug,
    split_classes,
    unique_preserve_order,
)
from .base import Scraper


SCHEDULE_SOURCE_RE = re.compile(r'source="([^"]+wp_program_view_all_[^"]+\.txt\?v=\d+)"')
PRESENTATION_PREFIX_RE = re.compile(r"^[A-Z]+")
NATURAL_RE = re.compile(r"(\d+)")


def prefix_for(presentation_id: str) -> str:
    match = PRESENTATION_PREFIX_RE.match(presentation_id)
    return match.group(0) if match else presentation_id


def natural_key(value: str) -> tuple:
    return tuple(
        int(chunk) if chunk.isdigit() else chunk
        for chunk in NATURAL_RE.split(value or "")
    )


@dataclass
class LinkOccurrence:
    presentation_id: str
    session_id: str
    url: str
    title_hint: str = ""
    source_date: str = ""
    source_url: str = ""
    row_start_utc: str = ""
    row_end_utc: str = ""
    session_title_hint: str = ""
    session_event_type_hint: str = ""
    location_hint: str = ""
    track_ids_hint: list[str] = field(default_factory=list)
    tracks_hint: list[str] = field(default_factory=list)


class LinklingsScraper(Scraper):
    name = "linklings"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        base_url = venue.source.get("base_url")
        if not base_url:
            raise ValueError(f"Venue {venue.id!r}: linklings requires source.base_url")
        self.base_url = base_url.rstrip("/") + "/"
        self.prefixes = tuple(venue.source.get("prefixes") or ("RESEARCH",))
        self.all_presentations = bool(venue.source.get("all_presentations", False))

    # -- public entrypoint -------------------------------------------------
    def scrape(self) -> list[Paper]:
        occurrences, option_maps = self.collect_occurrences()
        print(
            f"[{self.venue.id}] {len({o.presentation_id for o in occurrences})} unique "
            f"IDs across {len(occurrences)} id/session rows.",
            file=sys.stderr,
        )
        detail_rows = self.crawl_details(occurrences, option_maps)
        return self.aggregate_to_papers(detail_rows)

    # -- helpers -----------------------------------------------------------
    def _abs(self, href: str) -> str:
        return urljoin(self.base_url, href.replace("&amp;", "&")) if href else ""

    def discover_schedule_sources(self, home_html: str) -> list[str]:
        sources = [self._abs(m.group(1)) for m in SCHEDULE_SOURCE_RE.finditer(home_html)]
        return unique_preserve_order(sources)

    def parse_filter_options(self, home_html: str) -> dict[str, dict[str, str]]:
        soup = BeautifulSoup(home_html, "html.parser")
        maps: dict[str, dict[str, str]] = {
            "event_types": {},
            "rooms": {},
            "tracks": {},
            "times": {},
        }
        selector_map = {
            "event_types": 'select[name="etype_filt"] option',
            "rooms": 'select[name="room_filt"] option',
            "tracks": 'select[name^="ptrack_filt"] option',
            "times": 'select[name="time_filt"] option',
        }
        for name, selector in selector_map.items():
            for option in soup.select(selector):
                value = option.get("value", "")
                label = clean_text(option)
                if value and value not in {"all", "none"} and label:
                    maps[name][value] = label
        return maps

    def parse_track_names(
        self, container: Tag | None, option_maps: dict[str, dict[str, str]]
    ) -> tuple[list[str], list[str]]:
        track_ids: list[str] = []
        track_names: list[str] = []
        if container is None:
            return track_ids, track_names

        track_ids.extend(split_classes(container.get("ptracks")))
        for tag in container.select(".program-track"):
            classes = [c for c in split_classes(tag.get("class")) if c.startswith("ptrack")]
            track_ids.extend(classes)
            label = clean_text(tag)
            if label:
                track_names.append(label)

        track_ids = unique_preserve_order(track_ids)
        for track_id in track_ids:
            mapped = option_maps.get("tracks", {}).get(track_id)
            if mapped:
                track_names.append(mapped)
        return track_ids, unique_preserve_order(track_names)

    def parse_session_rows(
        self, soup: BeautifulSoup, option_maps: dict[str, dict[str, str]]
    ) -> dict[str, dict[str, Any]]:
        sessions: dict[str, dict[str, Any]] = {}
        for row in soup.select("tr.presentation-row[psid]"):
            session_id = row.get("psid", "")
            if not session_id or session_id == "none":
                continue
            track_ids, tracks = self.parse_track_names(row, option_maps)
            sessions[session_id] = {
                "session_id": session_id,
                "title": clean_text(row.select_one(".presentation-title")),
                "event_type": clean_text(row.select_one(".event-type-name")),
                "location": clean_text(row.select_one(".presentation-location")),
                "start_utc": row.get("s_utc", ""),
                "end_utc": row.get("e_utc", ""),
                "track_ids": track_ids,
                "tracks": tracks,
            }
        return sessions

    def parse_schedule_snippet(
        self, html: str, source_url: str, option_maps: dict[str, dict[str, str]]
    ) -> list[LinkOccurrence]:
        soup = BeautifulSoup(html, "html.parser")
        sessions = self.parse_session_rows(soup, option_maps)
        source_date = ""
        match = re.search(r"wp_program_view_all_(\d{4}-\d{2}-\d{2})\.txt", source_url)
        if match:
            source_date = match.group(1)

        occurrences: list[LinkOccurrence] = []
        for anchor in soup.select('a[href*="post_type=page"][href*="id="]'):
            href = anchor.get("href", "")
            query = parse_query(href)
            presentation_id = query.get("id", "")
            if not presentation_id:
                continue

            row = anchor.find_parent("tr")
            session_id = query.get("sess", "") or (row.get("psid", "") if row else "")
            if not session_id:
                session_id = "none"
            session_hint = sessions.get(session_id, {})
            track_ids, tracks = self.parse_track_names(row, option_maps)
            if not track_ids:
                track_ids = list(session_hint.get("track_ids", []))
            if not tracks:
                tracks = list(session_hint.get("tracks", []))

            occurrences.append(
                LinkOccurrence(
                    presentation_id=presentation_id,
                    session_id=session_id,
                    url=self._abs(href),
                    title_hint=clean_text(anchor),
                    source_date=source_date,
                    source_url=source_url,
                    row_start_utc=row.get("s_utc", "") if row else "",
                    row_end_utc=row.get("e_utc", "") if row else "",
                    session_title_hint=session_hint.get("title", ""),
                    session_event_type_hint=session_hint.get("event_type", ""),
                    location_hint=clean_text(row.select_one(".presentation-location")) if row else "",
                    track_ids_hint=track_ids,
                    tracks_hint=tracks,
                )
            )
        return occurrences

    def collect_occurrences(
        self,
    ) -> tuple[list[LinkOccurrence], dict[str, dict[str, str]]]:
        home_html = self.fetcher.get_text(self.base_url, "home.html")
        option_maps = self.parse_filter_options(home_html)
        sources = self.discover_schedule_sources(home_html)
        if not sources:
            raise RuntimeError("No Linklings schedule snippet sources found on the home page.")

        all_occurrences: list[LinkOccurrence] = []
        for source in sources:
            cache_key = f"snippets/{cache_name_for_url(source, '.txt')}"
            html = self.fetcher.get_text(source, cache_key)
            all_occurrences.extend(self.parse_schedule_snippet(html, source, option_maps))

        deduped: dict[tuple[str, str], LinkOccurrence] = {}
        seen_sources: dict[tuple[str, str], set[str]] = defaultdict(set)
        for occurrence in all_occurrences:
            if not self.all_presentations and prefix_for(occurrence.presentation_id) not in self.prefixes:
                continue
            key = (occurrence.presentation_id, occurrence.session_id)
            seen_sources[key].add(occurrence.source_date)
            if key not in deduped:
                deduped[key] = occurrence
            else:
                current = deduped[key]
                current.track_ids_hint = unique_preserve_order(current.track_ids_hint + occurrence.track_ids_hint)
                current.tracks_hint = unique_preserve_order(current.tracks_hint + occurrence.tracks_hint)
                if not current.title_hint:
                    current.title_hint = occurrence.title_hint

        for key, occurrence in deduped.items():
            occurrence.source_date = "; ".join(sorted(seen_sources[key]))

        ordered = sorted(deduped.values(), key=lambda item: (item.presentation_id, item.session_id))
        return ordered, option_maps

    def parse_people(self, display: Tag) -> dict[str, list[dict[str, str]]]:
        people: dict[str, list[dict[str, str]]] = {}
        section = display.select_one(".presenter-details-sect")
        if section is None:
            return people

        for role_block in section.find_all("div", recursive=False):
            label = clean_text(role_block.select_one(".info-label"))
            if not label:
                classes = [c for c in split_classes(role_block.get("class")) if c != "info-section"]
                label = classes[0] if classes else "people"

            entries: list[dict[str, str]] = []
            for person in role_block.select(".presenter-details"):
                name_anchor = person.select_one(".presenter-name a")
                institution_anchor = person.select_one(".presenter-institution a")
                entries.append(
                    {
                        "name": clean_text(name_anchor) or clean_text(person.select_one(".presenter-name")),
                        "person_url": self._abs(name_anchor.get("href", "")) if name_anchor else "",
                        "institution": clean_text(institution_anchor)
                        or clean_text(person.select_one(".presenter-institution")),
                        "institution_url": self._abs(institution_anchor.get("href", "")) if institution_anchor else "",
                    }
                )
            if entries:
                people[label] = entries
        return people

    def parse_detail(
        self, html: str, occurrence: LinkOccurrence, option_maps: dict[str, dict[str, str]]
    ) -> dict[str, Any]:
        soup = BeautifulSoup(html, "html.parser")
        display = soup.select_one(".linklings-wp-plugin-contents.presentation-display")
        if display is None:
            story = clean_text(soup.select_one(".post-story"))
            return {
                "presentation_id": occurrence.presentation_id,
                "session_id": occurrence.session_id,
                "url": occurrence.url,
                "fetch_status": "missing",
                "error": story or "presentation-display not found",
                "authors": [],
            }

        people = self.parse_people(display)
        authors = people.get("Authors") or people.get("Author") or []
        event_types = unique_preserve_order(
            [clean_text(node) for node in display.select(".event-types .event-type-name") if clean_text(node)]
        )
        track_ids, tracks = self.parse_track_names(display, option_maps)
        if not track_ids:
            track_ids = occurrence.track_ids_hint
        if not tracks:
            tracks = occurrence.tracks_hint

        session_anchor = display.select_one(".session-title a[href]")

        return {
            "presentation_id": display.get("presentation", "") or occurrence.presentation_id,
            "session_id": display.get("session", "") or occurrence.session_id,
            "url": occurrence.url,
            "fetch_status": "ok",
            "title": clean_text(display.select_one(".presentation-title")) or occurrence.title_hint,
            "abstract": clean_text(display.select_one(".abstract")),
            "event_type": "; ".join(event_types) or occurrence.session_event_type_hint,
            "track_ids": track_ids,
            "tracks": tracks,
            "session_title": clean_text(display.select_one(".session-title")) or occurrence.session_title_hint,
            "session_url": self._abs(session_anchor.get("href", "")) if session_anchor else "",
            "date": clean_text(display.select_one(".presentation-date")),
            "location": clean_text(display.select_one(".room")) or occurrence.location_hint,
            "authors": [item["name"] for item in authors if item.get("name")],
            "author_institutions": "; ".join(
                f"{item['name']} ({item['institution']})" if item.get("institution") else item["name"]
                for item in authors
            ),
        }

    def crawl_details(
        self, occurrences: list[LinkOccurrence], option_maps: dict[str, dict[str, str]]
    ) -> list[dict[str, Any]]:
        selected = occurrences[: self.limit] if self.limit else occurrences

        def fetch_one(occurrence: LinkOccurrence) -> dict[str, Any]:
            safe_id = safe_slug(occurrence.presentation_id)
            safe_sess = safe_slug(occurrence.session_id or "none")
            html = self.fetcher.get_text(occurrence.url, f"presentations/{safe_id}__{safe_sess}.html")
            return self.parse_detail(html, occurrence, option_maps)

        if self.workers <= 1:
            return [fetch_one(occurrence) for occurrence in selected]

        rows: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(fetch_one, occurrence): occurrence for occurrence in selected}
            completed = 0
            for future in as_completed(futures):
                occurrence = futures[future]
                completed += 1
                try:
                    rows.append(future.result())
                except Exception as exc:  # noqa: BLE001 - keep crawl resilient, report the item
                    rows.append(
                        {
                            "presentation_id": occurrence.presentation_id,
                            "session_id": occurrence.session_id,
                            "url": occurrence.url,
                            "fetch_status": "error",
                            "error": str(exc),
                            "authors": [],
                        }
                    )
                if completed % 100 == 0:
                    print(f"[{self.venue.id}] fetched {completed}/{len(selected)} detail pages...", file=sys.stderr)
        return sorted(rows, key=lambda item: (item.get("presentation_id", ""), item.get("session_id", "")))

    def aggregate_to_papers(self, detail_rows: list[dict[str, Any]]) -> list[Paper]:
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in detail_rows:
            grouped[row.get("presentation_id", "")].append(row)

        papers: list[Paper] = []
        for presentation_id, rows in grouped.items():
            rows = sorted(rows, key=lambda item: item.get("session_id", ""))
            ok_rows = [row for row in rows if row.get("fetch_status") == "ok"]
            base = ok_rows[0] if ok_rows else rows[0]

            papers.append(
                Paper(
                    id=presentation_id,
                    title=base.get("title", ""),
                    abstract=base.get("abstract", ""),
                    authors=list(base.get("authors", [])),
                    author_institutions=base.get("author_institutions", ""),
                    event_type="; ".join(unique_preserve_order([r.get("event_type", "") for r in rows])),
                    tracks=unique_preserve_order([t for r in rows for t in r.get("tracks", [])]),
                    session_titles=unique_preserve_order([r.get("session_title", "") for r in rows]),
                    sessions=unique_preserve_order([r.get("session_id", "") for r in rows]),
                    dates=unique_preserve_order([r.get("date", "") for r in rows]),
                    locations=unique_preserve_order([r.get("location", "") for r in rows]),
                    urls=unique_preserve_order([r.get("url", "") for r in rows]),
                )
            )
        return sorted(papers, key=lambda paper: natural_key(paper.id))
