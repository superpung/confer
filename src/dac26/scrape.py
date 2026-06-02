from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Tag


BASE_URL = "https://63dac.conference-program.com/"
DEFAULT_USER_AGENT = "dac26-scraper/0.1 (+https://63dac.conference-program.com/)"
DEFAULT_PREFIXES = ("RESEARCH",)
SCHEDULE_SOURCE_RE = re.compile(
    r'source="([^"]+wp_program_view_all_[^"]+\.txt\?v=\d+)"'
)
PRESENTATION_PREFIX_RE = re.compile(r"^[A-Z]+")


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


class Fetcher:
    def __init__(
        self,
        cache_dir: Path,
        *,
        refresh: bool = False,
        timeout: int = 30,
        delay: float = 0.0,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.timeout = timeout
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def get_text(self, url: str, cache_key: str) -> str:
        cache_path = self.cache_dir / cache_key
        if cache_path.exists() and not self.refresh:
            return cache_path.read_text(encoding="utf-8", errors="replace")

        if self.delay:
            time.sleep(self.delay)
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        text = response.text
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(text, encoding="utf-8")
        return text


def clean_text(node: Tag | None) -> str:
    if node is None:
        return ""
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()


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


def prefix_for(presentation_id: str) -> str:
    match = PRESENTATION_PREFIX_RE.match(presentation_id)
    return match.group(0) if match else presentation_id


def cache_name_for_url(url: str, suffix: str = ".html") -> str:
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    parsed = urlparse(url)
    safe_path = re.sub(r"[^A-Za-z0-9_.-]+", "_", parsed.path.strip("/") or "home")
    return f"{safe_path}_{digest}{suffix}"


def parse_query(href: str) -> dict[str, str]:
    query = parse_qs(urlparse(href.replace("&amp;", "&")).query)
    return {key: values[0] for key, values in query.items() if values}


def discover_schedule_sources(home_html: str) -> list[str]:
    sources = []
    for match in SCHEDULE_SOURCE_RE.finditer(home_html):
        sources.append(urljoin(BASE_URL, match.group(1)))
    return unique_preserve_order(sources)


def parse_filter_options(home_html: str) -> dict[str, dict[str, str]]:
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


def parse_track_names(container: Tag | None, option_maps: dict[str, dict[str, str]]) -> tuple[list[str], list[str]]:
    track_ids: list[str] = []
    track_names: list[str] = []
    if container is None:
        return track_ids, track_names

    track_ids.extend(split_classes(container.get("ptracks")))
    for tag in container.select(".program-track"):
        classes = [class_name for class_name in split_classes(tag.get("class")) if class_name.startswith("ptrack")]
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


def parse_session_rows(soup: BeautifulSoup, option_maps: dict[str, dict[str, str]]) -> dict[str, dict[str, Any]]:
    sessions: dict[str, dict[str, Any]] = {}
    for row in soup.select("tr.presentation-row[psid]"):
        session_id = row.get("psid", "")
        if not session_id or session_id == "none":
            continue
        title = clean_text(row.select_one(".presentation-title"))
        event_type = clean_text(row.select_one(".event-type-name"))
        location = clean_text(row.select_one(".presentation-location"))
        track_ids, tracks = parse_track_names(row, option_maps)
        sessions[session_id] = {
            "session_id": session_id,
            "title": title,
            "event_type": event_type,
            "location": location,
            "start_utc": row.get("s_utc", ""),
            "end_utc": row.get("e_utc", ""),
            "track_ids": track_ids,
            "tracks": tracks,
        }
    return sessions


def parse_schedule_snippet(
    html: str,
    source_url: str,
    option_maps: dict[str, dict[str, str]],
) -> list[LinkOccurrence]:
    soup = BeautifulSoup(html, "html.parser")
    sessions = parse_session_rows(soup, option_maps)
    source_date = ""
    match = re.search(r"wp_program_view_all_(\d{4}-\d{2}-\d{2})\.txt", source_url)
    if match:
        source_date = match.group(1)

    occurrences: list[LinkOccurrence] = []
    for anchor in soup.select('a[href*="post_type=page"][href*="p=16"][href*="id="]'):
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
        track_ids, tracks = parse_track_names(row, option_maps)
        if not track_ids:
            track_ids = list(session_hint.get("track_ids", []))
        if not tracks:
            tracks = list(session_hint.get("tracks", []))

        occurrences.append(
            LinkOccurrence(
                presentation_id=presentation_id,
                session_id=session_id,
                url=urljoin(BASE_URL, href.replace("&amp;", "&")),
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
    fetcher: Fetcher,
    *,
    prefixes: tuple[str, ...],
    all_presentations: bool,
) -> tuple[list[LinkOccurrence], dict[str, Any]]:
    home_html = fetcher.get_text(BASE_URL, "home.html")
    option_maps = parse_filter_options(home_html)
    sources = discover_schedule_sources(home_html)
    if not sources:
        raise RuntimeError("No Linklings schedule snippet sources were found on the home page.")

    all_occurrences: list[LinkOccurrence] = []
    for source in sources:
        cache_key = f"snippets/{cache_name_for_url(source, '.txt')}"
        html = fetcher.get_text(source, cache_key)
        all_occurrences.extend(parse_schedule_snippet(html, source, option_maps))

    deduped: dict[tuple[str, str], LinkOccurrence] = {}
    seen_sources: dict[tuple[str, str], set[str]] = defaultdict(set)
    for occurrence in all_occurrences:
        if not all_presentations and prefix_for(occurrence.presentation_id) not in prefixes:
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

    metadata = {
        "schedule_source_count": len(sources),
        "schedule_sources": sources,
        "raw_link_count": len(all_occurrences),
        "unique_id_session_count": len(deduped),
        "unique_presentation_id_count": len({item.presentation_id for item in deduped.values()}),
        "raw_prefix_counts": dict(Counter(prefix_for(item.presentation_id) for item in all_occurrences)),
        "selected_prefix_counts": dict(Counter(prefix_for(item.presentation_id) for item in deduped.values())),
        "option_maps": option_maps,
    }
    return sorted(deduped.values(), key=lambda item: (item.presentation_id, item.session_id)), metadata


def link_payload(anchor: Tag | None) -> dict[str, str]:
    if anchor is None:
        return {}
    href = anchor.get("href", "")
    return {
        "text": clean_text(anchor),
        "url": urljoin(BASE_URL, href) if href else "",
    }


def parse_people(display: Tag) -> dict[str, list[dict[str, str]]]:
    people: dict[str, list[dict[str, str]]] = {}
    section = display.select_one(".presenter-details-sect")
    if section is None:
        return people

    for role_block in section.find_all("div", recursive=False):
        label = clean_text(role_block.select_one(".info-label"))
        if not label:
            classes = [class_name for class_name in split_classes(role_block.get("class")) if class_name != "info-section"]
            label = classes[0] if classes else "people"

        entries: list[dict[str, str]] = []
        for person in role_block.select(".presenter-details"):
            name_anchor = person.select_one(".presenter-name a")
            institution_anchor = person.select_one(".presenter-institution a")
            entries.append(
                {
                    "name": clean_text(name_anchor) or clean_text(person.select_one(".presenter-name")),
                    "person_url": urljoin(BASE_URL, name_anchor.get("href", "")) if name_anchor else "",
                    "institution": clean_text(institution_anchor) or clean_text(person.select_one(".presenter-institution")),
                    "institution_url": urljoin(BASE_URL, institution_anchor.get("href", "")) if institution_anchor else "",
                }
            )
        if entries:
            people[label] = entries
    return people


def parse_info_sections(display: Tag) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for section in display.select(".info-section"):
        label_node = section.select_one(".info-label")
        label = clean_text(label_node)
        text = clean_text(section)
        if label and text.startswith(label):
            text = text[len(label) :].strip()
        links = []
        for anchor in section.select("a[href]"):
            href = anchor.get("href", "")
            links.append(
                {
                    "text": clean_text(anchor),
                    "url": urljoin(BASE_URL, href) if href else "",
                }
            )
        sections.append({"label": label, "text": text, "links": links})
    return sections


def parse_recommended(display: Tag) -> list[dict[str, str]]:
    recommendations: list[dict[str, str]] = []
    for item in display.select(".recommended-presentation"):
        anchor = item.select_one("a[href]")
        query = parse_query(anchor.get("href", "")) if anchor else {}
        recommendations.append(
            {
                "title": clean_text(anchor) or clean_text(item),
                "url": urljoin(BASE_URL, anchor.get("href", "")) if anchor else "",
                "presentation_id": query.get("id", ""),
                "session_id": query.get("sess", ""),
                "event_types": item.get("event_types", ""),
            }
        )
    return recommendations


def parse_detail(
    html: str,
    occurrence: LinkOccurrence,
    option_maps: dict[str, dict[str, str]],
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
        }

    people = parse_people(display)
    authors = people.get("Authors") or people.get("Author") or []
    event_types = [clean_text(node) for node in display.select(".event-types .event-type-name")]
    event_types = unique_preserve_order([event for event in event_types if event])
    track_ids, tracks = parse_track_names(display, option_maps)
    if not track_ids:
        track_ids = occurrence.track_ids_hint
    if not tracks:
        tracks = occurrence.tracks_hint

    start_node = display.select_one(".presentation-date-sect .start-time")
    end_node = display.select_one(".presentation-date-sect .end-time")
    session_anchor = display.select_one(".session-title a[href]")
    next_anchor = display.select_one(".next-presentation-sect a[href*='id=']")
    next_query = parse_query(next_anchor.get("href", "")) if next_anchor else {}

    return {
        "presentation_id": display.get("presentation", "") or occurrence.presentation_id,
        "session_id": display.get("session", "") or occurrence.session_id,
        "url": occurrence.url,
        "fetch_status": "ok",
        "title": clean_text(display.select_one(".presentation-title")) or occurrence.title_hint,
        "abstract": clean_text(display.select_one(".abstract")),
        "event_type": "; ".join(event_types) or occurrence.session_event_type_hint,
        "event_types": event_types,
        "presentation_classes": split_classes(display.get("class")),
        "conference": display.get("conference", ""),
        "event": display.get("event", ""),
        "track_ids": track_ids,
        "tracks": tracks,
        "session_title": clean_text(display.select_one(".session-title")) or occurrence.session_title_hint,
        "session_url": urljoin(BASE_URL, session_anchor.get("href", "")) if session_anchor else "",
        "date": clean_text(display.select_one(".presentation-date")),
        "time": clean_text(display.select_one(".presentation-time")),
        "start_utc": start_node.get("utc_time", "") if start_node else display.get("s_utc", ""),
        "end_utc": end_node.get("utc_time", "") if end_node else display.get("e_utc", ""),
        "location": clean_text(display.select_one(".room")) or occurrence.location_hint,
        "authors": "; ".join(item["name"] for item in authors),
        "author_institutions": "; ".join(
            f"{item['name']} ({item['institution']})" if item.get("institution") else item["name"]
            for item in authors
        ),
        "people": people,
        "info_sections": parse_info_sections(display),
        "recommended_presentations": parse_recommended(display),
        "next_presentation_id": next_query.get("id", ""),
        "next_session_id": next_query.get("sess", ""),
        "source_dates": occurrence.source_date,
        "source_url": occurrence.source_url,
        "title_hint": occurrence.title_hint,
        "session_title_hint": occurrence.session_title_hint,
        "row_start_utc": occurrence.row_start_utc,
        "row_end_utc": occurrence.row_end_utc,
    }


def crawl_details(
    occurrences: list[LinkOccurrence],
    fetcher: Fetcher,
    option_maps: dict[str, dict[str, str]],
    *,
    workers: int,
    limit: int | None,
) -> list[dict[str, Any]]:
    selected = occurrences[:limit] if limit else occurrences

    def fetch_one(occurrence: LinkOccurrence) -> dict[str, Any]:
        safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", occurrence.presentation_id)
        safe_sess = re.sub(r"[^A-Za-z0-9_.-]+", "_", occurrence.session_id or "none")
        html = fetcher.get_text(occurrence.url, f"presentations/{safe_id}__{safe_sess}.html")
        return parse_detail(html, occurrence, option_maps)

    if workers <= 1:
        return [fetch_one(occurrence) for occurrence in selected]

    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(fetch_one, occurrence): occurrence for occurrence in selected}
        completed = 0
        for future in as_completed(futures):
            occurrence = futures[future]
            completed += 1
            try:
                rows.append(future.result())
            except Exception as exc:  # noqa: BLE001 - keep crawl resilient and report the failed item.
                rows.append(
                    {
                        "presentation_id": occurrence.presentation_id,
                        "session_id": occurrence.session_id,
                        "url": occurrence.url,
                        "fetch_status": "error",
                        "error": str(exc),
                    }
                )
            if completed % 25 == 0:
                print(f"Fetched {completed}/{len(selected)} detail pages...", file=sys.stderr)
    return sorted(rows, key=lambda item: (item.get("presentation_id", ""), item.get("session_id", "")))


def csv_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: csv_value(row.get(field, "")) for field in fields})


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def aggregate_papers(detail_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in detail_rows:
        grouped[row.get("presentation_id", "")].append(row)

    papers: list[dict[str, Any]] = []
    for presentation_id, rows in sorted(grouped.items()):
        rows = sorted(rows, key=lambda item: item.get("session_id", ""))
        ok_rows = [row for row in rows if row.get("fetch_status") == "ok"]
        base = ok_rows[0] if ok_rows else rows[0]
        sessions = unique_preserve_order([row.get("session_id", "") for row in rows])
        session_titles = unique_preserve_order([row.get("session_title", "") for row in rows])
        locations = unique_preserve_order([row.get("location", "") for row in rows])
        dates = unique_preserve_order([row.get("date", "") for row in rows])
        event_types = unique_preserve_order([row.get("event_type", "") for row in rows])
        tracks = unique_preserve_order([track for row in rows for track in row.get("tracks", [])])
        track_ids = unique_preserve_order([track for row in rows for track in row.get("track_ids", [])])

        papers.append(
            {
                "presentation_id": presentation_id,
                "title": base.get("title", ""),
                "authors": base.get("authors", ""),
                "author_institutions": base.get("author_institutions", ""),
                "abstract": base.get("abstract", ""),
                "event_type": "; ".join(event_types),
                "tracks": "; ".join(tracks),
                "track_ids": "; ".join(track_ids),
                "session_count": len(sessions),
                "sessions": "; ".join(sessions),
                "session_titles": "; ".join(session_titles),
                "dates": "; ".join(dates),
                "locations": "; ".join(locations),
                "urls": "; ".join(unique_preserve_order([row.get("url", "") for row in rows])),
                "fetch_statuses": "; ".join(unique_preserve_order([row.get("fetch_status", "") for row in rows])),
                "occurrences": rows,
                "people": base.get("people", {}),
                "info_sections": base.get("info_sections", []),
            }
        )
    return papers


PRESENTATION_FIELDS = [
    "presentation_id",
    "session_id",
    "title",
    "authors",
    "author_institutions",
    "abstract",
    "event_type",
    "tracks",
    "track_ids",
    "session_title",
    "date",
    "time",
    "start_utc",
    "end_utc",
    "location",
    "conference",
    "event",
    "url",
    "source_dates",
    "fetch_status",
    "error",
    "people",
    "info_sections",
    "recommended_presentations",
    "next_presentation_id",
    "next_session_id",
]

PAPER_FIELDS = [
    "presentation_id",
    "title",
    "authors",
    "author_institutions",
    "abstract",
    "event_type",
    "tracks",
    "track_ids",
    "session_count",
    "sessions",
    "session_titles",
    "dates",
    "locations",
    "urls",
    "fetch_statuses",
    "people",
    "info_sections",
    "occurrences",
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Crawl the DAC 2026 Linklings program and export paper tables."
    )
    parser.add_argument("--base-url", default=BASE_URL, help="Conference program base URL.")
    parser.add_argument("--out-dir", default="data", help="Directory for CSV/JSON outputs.")
    parser.add_argument("--cache-dir", default="data/cache", help="Directory for cached HTML.")
    parser.add_argument(
        "--prefix",
        action="append",
        dest="prefixes",
        help="Presentation ID prefix to include. Defaults to RESEARCH. Can be repeated.",
    )
    parser.add_argument(
        "--all-presentations",
        action="store_true",
        help="Export every presentation type instead of only paper prefixes.",
    )
    parser.add_argument("--workers", type=int, default=6, help="Parallel detail-page fetches.")
    parser.add_argument("--delay", type=float, default=0.0, help="Delay before each uncached HTTP request.")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds.")
    parser.add_argument("--limit", type=int, help="Debug only: limit number of id/session detail pages.")
    parser.add_argument("--refresh", action="store_true", help="Ignore cached pages and refetch.")
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    global BASE_URL
    BASE_URL = args.base_url.rstrip("/") + "/"

    out_dir = Path(args.out_dir)
    fetcher = Fetcher(
        Path(args.cache_dir),
        refresh=args.refresh,
        timeout=args.timeout,
        delay=args.delay,
    )
    prefixes = tuple(args.prefixes or DEFAULT_PREFIXES)

    occurrences, metadata = collect_occurrences(
        fetcher,
        prefixes=prefixes,
        all_presentations=args.all_presentations,
    )
    option_maps = metadata.get("option_maps", {})
    print(
        f"Found {metadata['unique_presentation_id_count']} unique IDs and "
        f"{metadata['unique_id_session_count']} unique id/session rows.",
        file=sys.stderr,
    )

    detail_rows = crawl_details(
        occurrences,
        fetcher,
        option_maps,
        workers=max(args.workers, 1),
        limit=args.limit,
    )
    papers = aggregate_papers(detail_rows)

    write_csv(out_dir / "dac2026_paper_presentations.csv", detail_rows, PRESENTATION_FIELDS)
    write_csv(out_dir / "dac2026_papers.csv", papers, PAPER_FIELDS)
    write_json(out_dir / "dac2026_paper_presentations.json", detail_rows)
    write_json(out_dir / "dac2026_papers.json", papers)

    metadata.update(
        {
            "detail_row_count": len(detail_rows),
            "paper_row_count": len(papers),
            "detail_fetch_status_counts": dict(Counter(row.get("fetch_status", "") for row in detail_rows)),
            "output_files": {
                "papers_csv": str(out_dir / "dac2026_papers.csv"),
                "paper_presentations_csv": str(out_dir / "dac2026_paper_presentations.csv"),
                "papers_json": str(out_dir / "dac2026_papers.json"),
                "paper_presentations_json": str(out_dir / "dac2026_paper_presentations.json"),
            },
        }
    )
    write_json(out_dir / "dac2026_metadata.json", metadata)
    return metadata


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    metadata = run(args)
    print(json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
