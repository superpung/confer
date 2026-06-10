from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.sigarch import SigarchScraper

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(tmp_path: Path) -> SigarchScraper:
    venue = VenueConfig(
        id="asplos2026",
        name="ASPLOS 2026",
        series="ASPLOS",
        year=2026,
        scraper="sigarch",
        source={
            "program_url": "https://www.asplos-conference.org/asplos2026/program/index.html",
        },
    )
    return SigarchScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_program_extracts_panel_papers(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "sigarch_program.html").read_text(encoding="utf-8")
    papers = scraper.parse_program(html)

    assert len(papers) == 2
    paper = papers[0]
    assert paper.title == "Fast LLM Serving on GPUs"
    assert paper.authors == ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Edsger Dijkstra"]
    assert paper.author_institutions == (
        "Ada Lovelace (Example University); "
        "Grace Hopper (Example University); "
        "Alan Turing (Example Labs); "
        "Edsger Dijkstra (Example Institute, Department of Computing)"
    )
    assert paper.tracks == ["LLM Serving"]
    assert paper.event_type == "Paper"
    assert paper.session_titles == ["Session 1A: LLM Serving"]
    assert paper.sessions == ["1A"]
    assert paper.dates == ["Day 1: Tuesday, March 24, 2026 8:30 - 8:55"]
    assert paper.locations == ["Fort Pitt"]
    assert paper.urls == ["https://www.asplos-conference.org/asplos2026/program/index.html"]
    assert paper.extra == {"sessionTrack": "LLM Serving"}


def test_parse_program_handles_malformed_nested_institutions(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "sigarch_program.html").read_text(encoding="utf-8")
    paper = scraper.parse_program(html)[1]

    assert paper.title == "Malformed Institution Authors"
    assert paper.authors == [
        "Jiahan Chen",
        "Keming He",
        "Junjie Wu",
        "Xin Wang",
        "Lingling Lao",
    ]
    assert paper.author_institutions == (
        "Jiahan Chen (Guangzhou); "
        "Keming He (The Hong Kong University of Science and Technology (Guangzhou)); "
        "Junjie Wu (National University of Defense Technology); "
        "Xin Wang (The Hong Kong University of Science and Technology (Guangzhou)); "
        "Lingling Lao (National University of Defense Technology)"
    )


def test_paper_schema(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "sigarch_program.html").read_text(encoding="utf-8")
    paper = scraper.parse_program(html)[0]

    assert set(paper.to_dict()) == {
        "id",
        "title",
        "abstract",
        "authors",
        "authorInstitutions",
        "tracks",
        "eventType",
        "sessionTitles",
        "sessions",
        "dates",
        "locations",
        "urls",
        "extra",
    }
