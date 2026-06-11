from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.aaai import AaaiScraper, apply_aaai_detail, parse_aaai_detail


def make_scraper(tmp_path: Path) -> AaaiScraper:
    venue = VenueConfig(
        id="aaai2026",
        name="AAAI 2026",
        series="AAAI",
        year=2026,
        kind="conference",
        scraper="aaai",
        source={},
    )
    return AaaiScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_aaai_issue_and_detail(tmp_path):
    scraper = make_scraper(tmp_path)
    issue_html = """
    <div class="obj_article_summary">
      <h3 class="title"><a href="https://ojs.aaai.org/index.php/AAAI/article/view/36958">Resource Efficient Sleep Staging</a></h3>
      <div class="authors">Jane Doe, John Roe</div>
      <div class="pages">3-11</div>
      <a class="obj_galley_link pdf" href="https://ojs.aaai.org/index.php/AAAI/article/view/36958/40920">PDF</a>
    </div>
    """
    papers = scraper.parse_issue(issue_html, "AAAI-26 Technical Tracks 1", "https://ojs.aaai.org/index.php/AAAI/issue/view/683")
    assert len(papers) == 1
    assert papers[0].id == "36958"
    assert papers[0].authors == ["Jane Doe", "John Roe"]
    assert papers[0].pages == "3-11"

    detail = parse_aaai_detail(
        """
        <meta name="citation_author" content="Jane Doe"/>
        <meta name="citation_author_institution" content="Example University"/>
        <meta name="citation_title" content="Resource Efficient Sleep Staging"/>
        <meta name="citation_date" content="2026/03/17"/>
        <meta name="citation_volume" content="40"/>
        <meta name="citation_issue" content="1"/>
        <meta name="citation_firstpage" content="3"/>
        <meta name="citation_lastpage" content="11"/>
        <meta name="citation_doi" content="10.1609/aaai.v40i1.36958"/>
        <meta name="citation_pdf_url" content="https://ojs.aaai.org/index.php/AAAI/article/download/36958/40920"/>
        <section class="item abstract">Abstract A precise abstract.</section>
        """
    )
    apply_aaai_detail(papers[0], detail)

    assert papers[0].doi == "10.1609/aaai.v40i1.36958"
    assert papers[0].abstract == "A precise abstract."
    assert papers[0].publication_date == "2026-03-17"
    assert papers[0].author_institutions == "Example University"
