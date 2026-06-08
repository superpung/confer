from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.linklings import (
    LinkOccurrence,
    LinklingsScraper,
    natural_key,
    prefix_for,
)

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(tmp_path: Path) -> LinklingsScraper:
    venue = VenueConfig(
        id="test",
        name="Test",
        scraper="linklings",
        source={"base_url": "https://example.conference-program.com/"},
    )
    return LinklingsScraper(venue, Fetcher(tmp_path, refresh=False))


def test_prefix_for():
    assert prefix_for("RESEARCH123") == "RESEARCH"
    assert prefix_for("ENGPRES7") == "ENGPRES"


def test_natural_key_orders_numerically():
    ids = ["RESEARCH10", "RESEARCH2", "RESEARCH1"]
    assert sorted(ids, key=natural_key) == ["RESEARCH1", "RESEARCH2", "RESEARCH10"]


def test_parse_detail_extracts_core_fields(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "RESEARCH004__sess155.html").read_text(encoding="utf-8")
    occ = LinkOccurrence(presentation_id="RESEARCH004", session_id="sess155", url="https://x/")
    row = scraper.parse_detail(html, occ, option_maps={})

    assert row["fetch_status"] == "ok"
    assert row["presentation_id"] == "RESEARCH004"
    assert row["title"]
    assert isinstance(row["authors"], list) and row["authors"]
    assert row["abstract"]


def test_parse_schedule_snippet_accepts_linklings_page_variants(tmp_path):
    scraper = make_scraper(tmp_path)
    html = """
    <table>
      <tr class="agenda-item presentation-row" psid="sess42" s_utc="2025-06-25T16:00:00Z">
        <td><span class="presentation-title">Research Session</span></td>
        <td><div class="event-type-name">Research Manuscript</div></td>
      </tr>
      <tr class="agenda-item" psid="sess42" ssid="RESEARCH123">
        <td>
          <a href="/?post_type=page&p=15&id=RESEARCH123&sess=sess42">
            DAC 2025 style paper
          </a>
        </td>
      </tr>
      <tr class="agenda-item" psid="sess42" ssid="RESEARCH124">
        <td>
          <a href="/?post_type=page&p=16&id=RESEARCH124&sess=sess42">
            DAC 2026 style paper
          </a>
        </td>
      </tr>
    </table>
    """

    rows = scraper.parse_schedule_snippet(html, "https://example.com/wp_program_view_all_2025-06-25.txt", {})

    assert [row.presentation_id for row in rows] == ["RESEARCH123", "RESEARCH124"]
    assert {row.session_id for row in rows} == {"sess42"}


def test_aggregate_merges_sessions(tmp_path):
    scraper = make_scraper(tmp_path)
    rows = [
        {
            "presentation_id": "RESEARCH1", "session_id": "sessA", "fetch_status": "ok",
            "title": "T", "abstract": "A", "authors": ["Jane"], "author_institutions": "Jane (X)",
            "event_type": "Research Manuscript", "tracks": ["EDA"],
            "session_title": "S-A", "date": "Mon", "location": "R1", "url": "u1",
        },
        {
            "presentation_id": "RESEARCH1", "session_id": "sessB", "fetch_status": "ok",
            "title": "T", "abstract": "A", "authors": ["Jane"], "author_institutions": "Jane (X)",
            "event_type": "Research Manuscript", "tracks": ["Security"],
            "session_title": "S-B", "date": "Tue", "location": "R2", "url": "u2",
        },
    ]
    papers = scraper.aggregate_to_papers(rows)
    assert len(papers) == 1
    paper = papers[0]
    assert paper.sessions == ["sessA", "sessB"]
    assert paper.tracks == ["EDA", "Security"]
    assert paper.dates == ["Mon", "Tue"]
    assert paper.authors == ["Jane"]
    d = paper.to_dict()
    assert set(d) == {
        "id", "title", "abstract", "authors", "authorInstitutions", "tracks",
        "eventType", "sessionTitles", "sessions", "dates", "locations", "urls",
    }
