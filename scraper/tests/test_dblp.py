from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.dblp import DblpScraper

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(tmp_path: Path) -> DblpScraper:
    venue = VenueConfig(
        id="example2026",
        name="Example Journal 2026",
        series="EXAMPLE",
        year=2026,
        kind="journal",
        scraper="dblp",
        source={
            "toc_url": "https://dblp.org/db/journals/example/example1.xml",
            "default_track": "Volume 1",
            "exclude_title_patterns": ["^Editorial"],
        },
    )
    return DblpScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_toc_extracts_journal_articles(tmp_path):
    scraper = make_scraper(tmp_path)
    xml = (FIXTURES / "dblp_toc.xml").read_text(encoding="utf-8")
    papers = scraper.parse_toc(xml)

    assert len(papers) == 1
    paper = papers[0]
    assert paper.id == "journals_example_DoeR26"
    assert paper.title == "Precise Metadata Collection for Static Paper Sites"
    assert paper.authors == ["Jane Doe", "John Roe"]
    assert paper.tracks == ["Volume 1"]
    assert paper.event_type == "Journal Article"
    assert paper.session_titles == ["Volume 1, Number 1, January 2026"]
    assert paper.dates == ["January 2026"]
    assert paper.doi == "10.1145/1234567"
    assert paper.publication_date == "2026-01-01"
    assert paper.container == "Example J."
    assert paper.volume == "1"
    assert paper.issue == "1"
    assert paper.pages == "1-20"
    assert paper.urls == [
        "https://doi.org/10.1145/1234567",
        "https://dblp.org/db/journals/example/example1.html#DoeR26",
        "https://dblp.org/db/journals/example/example1.xml",
    ]
    assert paper.extra == {
        "dblpKey": "journals/example/DoeR26",
        "dblpSource": "https://dblp.org/db/journals/example/example1.xml",
    }
