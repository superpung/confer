from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.openreview import OpenReviewScraper


def make_scraper(tmp_path: Path) -> OpenReviewScraper:
    venue = VenueConfig(
        id="iclr2026",
        name="ICLR 2026",
        series="ICLR",
        year=2026,
        kind="conference",
        scraper="openreview",
        source={},
    )
    return OpenReviewScraper(venue, Fetcher(tmp_path, refresh=False))


def test_note_to_paper_maps_openreview_fields(tmp_path):
    scraper = make_scraper(tmp_path)
    paper = scraper.note_to_paper(
        {
            "id": "abc123",
            "forum": "abc123",
            "content": {
                "title": {"value": r"Task Tokens for $O(n^{2})$ Models"},
                "authors": {"value": ["Jane Doe", "John Roe"]},
                "authorids": {"value": ["~Jane_Doe1", "~John_Roe1"]},
                "abstract": {"value": "A precise abstract."},
                "keywords": {"value": ["reinforcement learning"]},
                "primary_area": {"value": "reinforcement learning"},
                "venue": {"value": "ICLR 2026 Poster"},
                "pdf": {"value": "/pdf/abc123.pdf"},
                "supplementary_material": {"value": "/attachment/abc123.zip"},
                "TLDR": {"value": "Short summary."},
            },
        }
    )

    assert paper.id == "abc123"
    assert paper.title == "Task Tokens for O(n^2) Models"
    assert paper.authors == ["Jane Doe", "John Roe"]
    assert paper.author_ids == ["~Jane_Doe1", "~John_Roe1"]
    assert paper.abstract == "A precise abstract."
    assert paper.tracks == ["reinforcement learning"]
    assert paper.event_type == "ICLR 2026 Poster"
    assert paper.pdf_urls == ["https://openreview.net/pdf/abc123.pdf"]
    assert paper.artifact_urls == ["https://openreview.net/attachment/abc123.zip"]
    assert paper.extra["tldr"] == "Short summary."
