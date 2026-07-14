import json
from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.sigchi import SigchiScraper

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(tmp_path: Path) -> SigchiScraper:
    venue = VenueConfig(
        id="chi2026",
        name="CHI 2026",
        series="CHI",
        category="Human-Computer Interaction",
        year=2026,
        kind="conference",
        scraper="sigchi",
        source={"short_name": "CHI"},
    )
    return SigchiScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_program_keeps_papers_and_drops_other_types(tmp_path):
    scraper = make_scraper(tmp_path)
    program = json.loads((FIXTURES / "sigchi_program.json").read_text(encoding="utf-8"))
    papers = scraper.parse_program(program)

    # Only the Paper-typed content survives; the Poster is skipped.
    assert len(papers) == 1
    paper = papers[0]
    assert paper.id == "10.1145_3772318.3790431"
    assert paper.title == "A Real CHI Paper"
    assert paper.abstract == "This paper studies co-design methods for autonomous vehicles."
    assert paper.authors == ["Tram Thi Minh Tran", "Jordan Lee"]
    assert paper.event_type == "Paper"
    assert paper.session_titles == ["Co-Design"]
    assert paper.locations == ["P1 - Room 111"]
    assert paper.doi == "10.1145/3772318.3790431"
    assert paper.extra["sigchiContentId"] == 222560


def test_author_institutions_format_and_multi_affiliation(tmp_path):
    scraper = make_scraper(tmp_path)
    program = json.loads((FIXTURES / "sigchi_program.json").read_text(encoding="utf-8"))
    paper = scraper.parse_program(program)[0]

    # "Name (Institution)" joined by "; "; a multi-affiliation author uses " / "
    # inside the parens so the site's ";"-split stays intact.
    assert paper.author_institutions == (
        "Tram Thi Minh Tran (The University of Sydney); "
        "Jordan Lee (Stevens Institute of Technology / University of Illinois)"
    )


def test_video_and_doi_urls_collected(tmp_path):
    scraper = make_scraper(tmp_path)
    program = json.loads((FIXTURES / "sigchi_program.json").read_text(encoding="utf-8"))
    paper = scraper.parse_program(program)[0]

    assert paper.urls == [
        "https://doi.org/10.1145/3772318.3790431",
        "https://www.youtube.com/watch?v=abc123",
    ]


def test_content_types_are_configurable(tmp_path):
    venue = VenueConfig(
        id="chi2026",
        name="CHI 2026",
        series="CHI",
        year=2026,
        scraper="sigchi",
        source={"short_name": "CHI", "content_types": ["Paper", "Posters"]},
    )
    scraper = SigchiScraper(venue, Fetcher(tmp_path, refresh=False))
    program = json.loads((FIXTURES / "sigchi_program.json").read_text(encoding="utf-8"))
    papers = scraper.parse_program(program)

    assert {paper.event_type for paper in papers} == {"Paper", "Posters"}
