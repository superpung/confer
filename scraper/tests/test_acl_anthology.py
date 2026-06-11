from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.acl_anthology import AclAnthologyScraper


def make_scraper(tmp_path: Path) -> AclAnthologyScraper:
    venue = VenueConfig(
        id="acl2025",
        name="ACL 2025",
        series="ACL",
        year=2025,
        kind="conference",
        scraper="acl_anthology",
        source={"event_url": "https://aclanthology.org/events/acl-2025/"},
    )
    return AclAnthologyScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_event_extracts_acl_papers(tmp_path):
    scraper = make_scraper(tmp_path)
    html = """
    <div id="2025acl-long">
      <h4>
        <span><a href="/volumes/2025.acl-long.bib">bib (full)</a></span>
        <a href="/volumes/2025.acl-long/">Proceedings of ACL 2025 (Volume 1: Long Papers)</a>
      </h4>
      <div class="d-sm-flex align-items-stretch mb-3">
        <div class="d-block me-2 list-button-row">
          <a class="badge text-bg-primary" href="https://aclanthology.org/2025.acl-long.1.pdf">pdf</a>
        </div>
        <span class="d-block">
          <strong><a class="align-middle" href="/2025.acl-long.1/">A <span class="acl-fixed-case">NLP</span> Paper</a></strong><br>
          <a href="/people/jane-doe/">Jane Doe</a>
          <a href="/people/john-roe/">John Roe</a>
        </span>
      </div>
      <div class="card bg-light mb-2 mb-lg-3 collapse abstract-collapse" id="abstract-2025--acl-long--1">
        <div class="card-body p-3 small">A useful abstract.</div>
      </div>
    </div>
    """

    papers = scraper.parse_event(html)

    assert len(papers) == 1
    assert papers[0].id == "2025.acl-long.1"
    assert papers[0].title == "A NLP Paper"
    assert papers[0].abstract == "A useful abstract."
    assert papers[0].authors == ["Jane Doe", "John Roe"]
    assert papers[0].tracks == ["Proceedings of ACL 2025 (Volume 1: Long Papers)"]
    assert papers[0].event_type == "Long Paper"
    assert papers[0].pdf_urls == ["https://aclanthology.org/2025.acl-long.1.pdf"]
