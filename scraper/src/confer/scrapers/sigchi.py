"""Adapter for the official SIGCHI conference program platform.

The SIGCHI program site (``programs.sigchi.org``) is a JavaScript app backed by
static JSON on a CDN (``files.sigchi.org``). Three unauthenticated endpoints are
enough to reconstruct a full program:

1. ``/conference/cache/program-list`` — every conference, keyed by
   ``shortName`` + ``year`` (e.g. ``CHI`` / ``2026`` -> conference id ``10142``).
2. ``/conference/cache/{id}/version-2`` — the current ``scheduleVersion``.
3. ``/conference/cache/{id}/{version}/program`` — the whole program: contents
   (papers, posters, …), sessions, rooms, and people.

Unlike DBLP, this source carries abstracts and structured author affiliations
directly, so the adapter fully populates the unified :class:`Paper` without
relying on downstream enrichment.

Source keys (all optional; ids are resolved from ``program-list`` by default):
    short_name     -- conference ``shortName`` to match (default: ``venue.series``)
    conference_id  -- pin an exact conference id, skipping resolution
    content_types  -- content-type names to keep (default: ``["Paper"]``)
    base_url       -- CDN base (default: ``https://files.sigchi.org``)
"""

from __future__ import annotations

import json
import sys
from typing import Any
from urllib.parse import urljoin

from ..config import VenueConfig
from ..fetcher import Fetcher
from ..models import Paper
from ..util import clean_doi, doi_from_url, safe_slug, unique_preserve_order
from .base import Scraper


DEFAULT_BASE_URL = "https://files.sigchi.org"
DEFAULT_CONTENT_TYPES = ("Paper",)


class SigchiScraper(Scraper):
    name = "sigchi"

    def __init__(self, venue: VenueConfig, fetcher: Fetcher, **kwargs: Any) -> None:
        super().__init__(venue, fetcher, **kwargs)
        self.base_url = str(venue.source.get("base_url") or DEFAULT_BASE_URL).rstrip("/") + "/"
        self.short_name = str(venue.source.get("short_name") or venue.series or "").strip()
        self.conference_id = venue.source.get("conference_id")
        content_types = venue.source.get("content_types") or DEFAULT_CONTENT_TYPES
        self.content_types = {str(name).strip().casefold() for name in content_types}

    # -- endpoints -----------------------------------------------------------

    def get_json(self, path: str, cache_key: str) -> Any:
        return json.loads(self.fetcher.get_text(urljoin(self.base_url, path), cache_key))

    def resolve_conference_id(self) -> int:
        if self.conference_id is not None:
            return int(self.conference_id)
        if not self.short_name or not self.venue.year:
            raise ValueError(
                f"Venue {self.venue.id!r}: sigchi needs source.conference_id, "
                "or source.short_name/series + year to resolve one."
            )
        listing = self.get_json("conference/cache/program-list", "program-list.json")
        target = self.short_name.casefold()
        matches = [
            entry["conference"]
            for entry in listing
            if isinstance(entry, dict)
            and (conf := entry.get("conference"))
            and str(conf.get("shortName", "")).casefold() == target
            and conf.get("year") == self.venue.year
        ]
        if not matches:
            raise ValueError(
                f"Venue {self.venue.id!r}: no SIGCHI conference for "
                f"shortName={self.short_name!r} year={self.venue.year} in program-list."
            )
        return int(matches[0]["id"])

    # -- scrape --------------------------------------------------------------

    def scrape(self) -> list[Paper]:
        conference_id = self.resolve_conference_id()
        version_info = self.get_json(
            f"conference/cache/{conference_id}/version-2", f"version-{conference_id}.json"
        )
        version = version_info.get("scheduleVersion")
        if version is None:
            raise ValueError(f"Venue {self.venue.id!r}: no scheduleVersion for conference {conference_id}.")
        program = self.get_json(
            f"conference/cache/{conference_id}/{version}/program",
            f"program-{conference_id}-{version}.json",
        )
        papers = self.parse_program(program)
        selected = papers[: self.limit] if self.limit else papers
        print(
            f"[{self.venue.id}] {len(selected)} SIGCHI papers selected from "
            f"{len(program.get('contents', []))} program contents (conference {conference_id}).",
            file=sys.stderr,
        )
        return selected

    def parse_program(self, program: dict[str, Any]) -> list[Paper]:
        people = {person["id"]: person for person in program.get("people", [])}
        sessions = {session["id"]: session for session in program.get("sessions", [])}
        rooms = {room["id"]: room for room in program.get("rooms", [])}
        type_names = {ctype["id"]: str(ctype.get("name", "")) for ctype in program.get("contentTypes", [])}

        papers: list[Paper] = []
        for content in program.get("contents", []):
            type_name = type_names.get(content.get("typeId"), "")
            if type_name.casefold() not in self.content_types:
                continue
            paper = self.build_paper(content, type_name, people, sessions, rooms)
            if paper is not None:
                papers.append(paper)
        return sorted(papers, key=lambda paper: paper.id)

    # -- parsing -------------------------------------------------------------

    def build_paper(
        self,
        content: dict[str, Any],
        type_name: str,
        people: dict[int, dict[str, Any]],
        sessions: dict[int, dict[str, Any]],
        rooms: dict[int, dict[str, Any]],
    ) -> Paper | None:
        title = str(content.get("title", "")).strip()
        if not title:
            return None

        authors: list[str] = []
        affiliations: list[str] = []
        for author in content.get("authors", []):
            person = people.get(author.get("personId"), {})
            name = self.person_name(person)
            if not name:
                continue
            authors.append(name)
            institution = self.author_institution(author)
            affiliations.append(f"{name} ({institution})" if institution else name)

        addons = content.get("addons") or {}
        doi = self.addon_doi(addons)
        urls = unique_preserve_order(
            [url for url in (self.addon_doi_url(addons), self.addon_video_url(addons)) if url]
        )

        session_names = [
            name
            for sid in content.get("sessionIds", [])
            if (name := str(sessions.get(sid, {}).get("name", "")).strip())
        ]
        locations = [
            name
            for sid in content.get("sessionIds", [])
            if (name := str(rooms.get(sessions.get(sid, {}).get("roomId"), {}).get("name", "")).strip())
        ]

        return Paper(
            id=safe_slug(clean_doi(doi) or str(content.get("id", "")) or title),
            title=title,
            abstract=str(content.get("abstract", "")),
            authors=authors,
            author_institutions="; ".join(affiliations),
            tracks=[self.venue.name],
            event_type=type_name,
            session_titles=session_names,
            locations=locations,
            urls=urls,
            doi=clean_doi(doi),
            container=self.venue.name,
            extra={"sigchiContentId": content.get("id")},
        )

    @staticmethod
    def person_name(person: dict[str, Any]) -> str:
        parts = [
            str(person.get("firstName", "")).strip(),
            str(person.get("middleInitial", "")).strip(),
            str(person.get("lastName", "")).strip(),
        ]
        return " ".join(part for part in parts if part)

    @staticmethod
    def author_institution(author: dict[str, Any]) -> str:
        # One author may list several affiliations; join with " / " so the
        # site's "; "-delimited "Name (Institution)" format stays parseable.
        institutions = unique_preserve_order(
            [
                inst
                for affiliation in author.get("affiliations", [])
                if (inst := str(affiliation.get("institution", "")).strip())
            ]
        )
        return " / ".join(institutions)

    @staticmethod
    def addon_doi(addons: dict[str, Any]) -> str:
        return doi_from_url(SigchiScraper.addon_doi_url(addons))

    @staticmethod
    def addon_doi_url(addons: dict[str, Any]) -> str:
        doi_addon = addons.get("doi") or {}
        return str(doi_addon.get("url", "")).strip()

    @staticmethod
    def addon_video_url(addons: dict[str, Any]) -> str:
        for addon in addons.values():
            if isinstance(addon, dict) and addon.get("type") == "video" and addon.get("url"):
                return str(addon["url"]).strip()
        return ""
