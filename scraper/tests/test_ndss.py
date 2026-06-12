from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.ndss import NdssScraper, parse_ndss_byline


def make_scraper(tmp_path: Path) -> NdssScraper:
    venue = VenueConfig(
        id="ndss2026",
        name="NDSS 2026",
        series="NDSS",
        year=2026,
        kind="conference",
        scraper="ndss",
        source={"accepted_url": "https://www.ndss-symposium.org/ndss2026/accepted-papers/"},
    )
    return NdssScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_ndss_accepted_links_and_detail(tmp_path):
    scraper = make_scraper(tmp_path)
    links = scraper.parse_accepted_links(
        """
        <a href="https://www.ndss-symposium.org/ndss-paper/a-paper/">A Paper</a>
        <a href="https://www.ndss-symposium.org/ndss-paper/a-paper/">A Paper</a>
        """
    )
    assert links == [("A Paper", "https://www.ndss-symposium.org/ndss-paper/a-paper/")]

    paper = scraper.parse_detail(
        """
        <h1 class="entry-title">A Paper</h1>
        <div class="paper-data">
          <p>Jane Doe (Example University), John Roe (Example Labs)</p>
          <p>A useful abstract.</p>
          <a class="pdf-button" href="/wp-content/uploads/2026-paper.pdf">Paper</a>
        </div>
        """,
        "https://www.ndss-symposium.org/ndss-paper/a-paper/",
    )

    assert paper.id == "a-paper"
    assert paper.authors == ["Jane Doe", "John Roe"]
    assert paper.author_institutions == "Jane Doe (Example University); John Roe (Example Labs)"
    assert paper.abstract == "A useful abstract."
    assert paper.pdf_urls == ["https://www.ndss-symposium.org/wp-content/uploads/2026-paper.pdf"]


def test_parse_ndss_byline_handles_nested_affiliations_and_shared_institutions():
    authors, institutions = parse_ndss_byline(
        "Yuhan Meng (Key Laboratory of High-Confidence Software Technologies (MOE), "
        "School of Computer Science, Peking University), "
        "Haowei Yang, Lei Xue (Sun Yat-sen University), "
        "Lea Gröber (International Computer Science Institute (ICSI), USA and Lahore University of Management Sciences (LUMS))"
    )

    assert authors == ["Yuhan Meng", "Haowei Yang", "Lei Xue", "Lea Gröber"]
    assert "School of Computer Science, Peking University" in institutions
    assert "Haowei Yang (Sun Yat-sen University)" in institutions
    assert "Lei Xue (Sun Yat-sen University)" in institutions
    assert "USA and Lahore University of Management Sciences (LUMS)" in institutions
