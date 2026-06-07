from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.dateconf import DateConfScraper

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(tmp_path: Path) -> DateConfScraper:
    venue = VenueConfig(
        id="date2026",
        name="DATE 2026",
        series="DATE",
        scraper="dateconf",
        source={"program_url": "https://www.date-conference.com/programme"},
    )
    return DateConfScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_program_extracts_downloadable_papers(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "dateconf_program.html").read_text(encoding="utf-8")
    papers = scraper.parse_program(html)

    assert [paper.id for paper in papers] == ["TS01.2", "TS01.3", "UF01.1"]

    technical = papers[0]
    assert technical.title == "Bespoke Co-Processor for Energy-Efficient Health Monitoring"
    assert technical.abstract == "Flexible electronics abstract."
    assert technical.authors == ["Theofanis Vergos", "Polykarpos Vergos", "Mehdi Tahoori"]
    assert technical.author_institutions == (
        "Theofanis Vergos (University of Patras, GR); "
        "Polykarpos Vergos (University of Patras, GR); "
        "Mehdi Tahoori (Karlsruhe Institute of Technology, DE)"
    )
    assert technical.tracks == ["Technical Session"]
    assert technical.event_type == "Technical Session"
    assert technical.session_titles == ["TS01 Energy Efficiency and Performance Optimization"]
    assert technical.sessions == ["TS01"]
    assert technical.dates == ["Monday, 20 April 2026 11:20 CEST"]
    assert technical.locations == ["Aida"]
    assert technical.urls == [
        "https://www.date-conference.com/proceedings-archive/2026/DATA/42.pdf",
        "https://www.date-conference.com/programme",
    ]

    single_author = papers[1]
    assert single_author.authors == ["Amir Moradi"]
    assert single_author.author_institutions == "Amir Moradi (TU Darmstadt, DE)"

    demo = papers[2]
    assert demo.title == "Systolic-ONN: A Live Demonstration"
    assert demo.authors == ["Jeongmin Jin", "Mundo Jeong", "Woojoo Lee"]
    assert demo.author_institutions == (
        "Jeongmin Jin (Chung-Ang University, KR); "
        "Mundo Jeong (Chung-Ang University, KR); "
        "Woojoo Lee (Chung-Ang University, KR)"
    )
    assert demo.tracks == ["Young People Programme"]


def test_paper_schema(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "dateconf_program.html").read_text(encoding="utf-8")
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
    }
