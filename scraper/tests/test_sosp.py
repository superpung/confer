from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.scrapers.sosp import SospScraper

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(tmp_path: Path) -> SospScraper:
    venue = VenueConfig(
        id="sosp2099",
        name="SOSP 2099",
        series="SOSP",
        year=2099,
        scraper="sosp",
        source={"accepted_url": "https://sigops.org/s/conferences/sosp/2099/accepted.html"},
    )
    return SospScraper(venue, Fetcher(tmp_path, refresh=False))


def parse(tmp_path: Path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "sosp_accepted.html").read_text(encoding="utf-8")
    return {paper.title: paper for paper in scraper.parse_papers(html)}


def test_parses_every_paper_with_affiliations(tmp_path):
    papers = parse(tmp_path)
    assert len(papers) == 6
    # Every paper carries author affiliations from the first-party page.
    assert all(paper.author_institutions.strip() for paper in papers.values())


def test_trailing_group_affiliation_applies_to_preceding_authors(tmp_path):
    paper = parse(tmp_path)["Rearchitecting the Thread Model of In-Memory Key-Value Stores"]
    assert paper.authors == [
        "Youmin Chen",
        "Jiwu Shu",
        "Yanyan Shen",
        "Linpeng Huang",
        "Hong Mei",
    ]
    # The trailing "(Shanghai Jiao Tong University)" fills the bare names before it.
    assert paper.author_institutions == (
        "Youmin Chen (Shanghai Jiao Tong University); "
        "Jiwu Shu (Tsinghua University); "
        "Yanyan Shen (Shanghai Jiao Tong University); "
        "Linpeng Huang (Shanghai Jiao Tong University); "
        "Hong Mei (Shanghai Jiao Tong University)"
    )
    assert paper.event_type == "Paper"
    assert paper.tracks == ["SOSP 2099"]
    assert paper.urls == ["https://sigops.org/s/conferences/sosp/2099/accepted.html"]


def test_shared_single_institution(tmp_path):
    paper = parse(tmp_path)["Prove It to the Kernel: Precise Extension Analysis"]
    assert paper.authors == ["Hao Sun", "Zhendong Su"]
    assert paper.author_institutions == (
        "Hao Sun (ETH Zurich); Zhendong Su (ETH Zurich)"
    )


def test_institution_names_with_commas_are_preserved(tmp_path):
    paper = parse(tmp_path)["Anonymous Blocklisting with Constant-Sized Updatable Proofs"]
    # The comma inside "University of California, Berkeley" must not split authors.
    assert paper.authors == ["Jiwon Kim", "Riad Wahby"]
    assert paper.author_institutions == (
        "Jiwon Kim (University of Michigan); "
        "Riad Wahby (University of California, Berkeley)"
    )


def test_id_is_a_clean_slug(tmp_path):
    paper = parse(tmp_path)["Prove It to the Kernel: Precise Extension Analysis"]
    # Lowercase, hyphen-separated, punctuation folded away.
    assert paper.id == "prove-it-to-the-kernel-precise-extension-analysis"


def test_trailing_period_is_stripped_from_title(tmp_path):
    # The fixture title ends with a period; the adapter drops it.
    assert "Anonymous Blocklisting with Constant-Sized Updatable Proofs" in parse(tmp_path)


def test_nested_parentheses_and_nickname(tmp_path):
    paper = parse(tmp_path)["Hierarchical Metadata Management"]
    # Nicknames and nested-paren institutions must not corrupt names or splits.
    assert paper.authors == ["Jiahao Li", "Suqiang (Jack) Song", "Kang Chen"]
    assert paper.author_institutions == (
        "Jiahao Li (University of Science and Technology of China, Baidu (China) Co., Ltd); "
        "Suqiang (Jack) Song (Uber); "
        "Kang Chen (Tsinghua University)"
    )


def test_trailing_period_after_final_institution(tmp_path):
    # "… (Princeton University)." — the sentence period must not leak into the
    # last author's name, and the bare "Amit Levy" still inherits Princeton.
    paper = parse(tmp_path)["Running Applications Closer to Users"]
    assert paper.authors == ["Austin Li", "Amit Levy", "Wyatt Lloyd"]
    assert paper.author_institutions == (
        "Austin Li (Cornell University); "
        "Amit Levy (Princeton University); "
        "Wyatt Lloyd (Princeton University)"
    )
