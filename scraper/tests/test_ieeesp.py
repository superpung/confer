from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.ieeesp import IeeeSpScraper

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(tmp_path: Path) -> IeeeSpScraper:
    venue = VenueConfig(
        id="sp2099",
        name="IEEE S&P 2099",
        series="IEEE S&P",
        year=2099,
        scraper="ieeesp",
        source={"accepted_url": "https://sp2099.ieee-security.org/accepted-papers.html"},
    )
    return IeeeSpScraper(venue, Fetcher(tmp_path, refresh=False))


def parse(tmp_path: Path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "ieeesp_accepted.html").read_text(encoding="utf-8")
    return {paper.title: paper for paper in scraper.parse_papers(html)}


def test_parses_all_papers_across_cycles(tmp_path):
    papers = parse(tmp_path)
    assert len(papers) == 3
    # Every paper carries author affiliations from the first-party page.
    assert all(paper.author_institutions.strip() for paper in papers.values())


def test_superscript_affiliations_map_per_author(tmp_path):
    paper = parse(tmp_path)["PAC-Private Algorithms"]
    assert paper.authors == ["Mayuri Sridhar", "Hanshen Xiao", "Srinivas Devadas"]
    # A shared superscript (2,3) yields two institutions joined with " / ".
    assert paper.author_institutions == (
        "Mayuri Sridhar (MIT); "
        "Hanshen Xiao (Purdue University / NVIDIA Research); "
        "Srinivas Devadas (MIT)"
    )
    assert paper.session_titles == ["Cycle 1"]
    assert paper.event_type == "Paper"
    assert paper.tracks == ["IEEE S&P 2099"]
    assert paper.urls == ["https://sp2099.ieee-security.org/accepted-papers.html"]


def test_shared_single_institution_without_superscripts(tmp_path):
    paper = parse(tmp_path)["Verifiable Secret Sharing Simplified"]
    assert paper.authors == ["Alex Ozdemir", "Evan Laufer", "Dan Boneh"]
    assert paper.author_institutions == (
        "Alex Ozdemir (Stanford University); "
        "Evan Laufer (Stanford University); "
        "Dan Boneh (Stanford University)"
    )


def test_institution_names_with_commas_are_preserved(tmp_path):
    paper = parse(tmp_path)[
        "ALPACA: Anonymous Blocklisting with Constant-Sized Updatable Proofs"
    ]
    assert paper.session_titles == ["Cycle 2"]
    # "University of California, Berkeley" must not split on its internal comma.
    assert paper.author_institutions == (
        "Jiwon Kim (University of Michigan); "
        "Abhiram Kothapalli (University of California, Berkeley); "
        "Riad Wahby (University of California, Berkeley)"
    )


def test_paper_schema(tmp_path):
    paper = parse(tmp_path)["PAC-Private Algorithms"]
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
        "container",
    }
