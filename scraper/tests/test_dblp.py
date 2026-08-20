from pathlib import Path

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.models import Paper
from confer.scrapers.dblp import DblpScraper, format_usenix_people

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
        },
    )
    return DblpScraper(venue, Fetcher(tmp_path, refresh=False))


def make_conference_scraper(tmp_path: Path) -> DblpScraper:
    venue = VenueConfig(
        id="exampleconf2026",
        name="ExampleConf 2026",
        series="EXAMPLECONF",
        year=2026,
        kind="conference",
        scraper="dblp",
        source={
            "toc_url": "https://dblp.org/db/conf/example/exampleconf2026.xml",
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
    assert paper.tracks == ["Volume 1, Number 1, January 2026"]
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


def test_parse_toc_keeps_conference_toc_records(tmp_path):
    scraper = make_conference_scraper(tmp_path)
    xml = """
    <bht>
      <h2>Keynote Talks</h2>
      <dblpcites>
        <r><inproceedings key="conf/example/Keynote26">
          <author>Ada Keynote</author>
          <title>Autonomous Vulnerability Analysis: A Historical Perspective.</title>
          <year>2026</year><booktitle>ExampleConf</booktitle>
        </inproceedings></r>
      </dblpcites>
      <h2>Session A1: Systems Security</h2>
      <dblpcites>
        <r><inproceedings key="conf/example/Paper26">
          <author>Jane Doe</author>
          <title>A Real Security Paper.</title>
          <year>2026</year><booktitle>ExampleConf</booktitle>
          <ee>https://doi.org/10.1145/1234567.1234568</ee>
        </inproceedings></r>
        <r><inproceedings key="conf/example/Workshop26">
          <author>Workshop Chair</author>
          <title>RICSS'26: 4th International Workshop on Re-design Industrial Control Systems with Security.</title>
          <year>2026</year><booktitle>ExampleConf</booktitle>
        </inproceedings></r>
      </dblpcites>
      <h2>Poster &amp; Demo Session</h2>
      <dblpcites>
        <r><inproceedings key="conf/example/Poster26">
          <author>Poster Author</author>
          <title>Poster: A Short Security Abstract.</title>
          <year>2026</year><booktitle>ExampleConf</booktitle>
        </inproceedings></r>
      </dblpcites>
      <h2>Workshop Summaries</h2>
      <dblpcites>
        <r><inproceedings key="conf/example/Summary26">
          <author>Summary Chair</author>
          <title>The 20th Workshop on Programming Languages and Analysis for Security (PLAS 2026).</title>
          <year>2026</year><booktitle>ExampleConf</booktitle>
        </inproceedings></r>
      </dblpcites>
      <h2>Doctoral Symposium</h2>
      <dblpcites>
        <r><inproceedings key="conf/example/Doctoral26">
          <author>Doctoral Student</author>
          <title>Towards Practical Security Measurements.</title>
          <year>2026</year><booktitle>ExampleConf</booktitle>
        </inproceedings></r>
      </dblpcites>
    </bht>
    """
    papers = scraper.parse_toc(xml)

    assert [paper.id for paper in papers] == [
        "conf_example_Doctoral26",
        "conf_example_Keynote26",
        "conf_example_Paper26",
        "conf_example_Poster26",
        "conf_example_Summary26",
        "conf_example_Workshop26",
    ]
    assert {paper.event_type for paper in papers} == {"Paper"}
    assert {paper.tracks[0] for paper in papers} == {
        "Doctoral Symposium",
        "Keynote Talks",
        "Poster & Demo Session",
        "Session A1: Systems Security",
        "Workshop Summaries",
    }


def test_usenix_detail_metadata_enriches_paper():
    html = """
    <html>
      <head>
        <meta name="citation_title" content="{FRCC}: Towards Provably Fair and Robust Congestion Control" />
        <meta name="citation_author" content="Anup Agarwal" />
        <meta name="citation_author_institution" content="Carnegie Mellon University" />
        <meta name="citation_publication_date" content="2026" />
        <meta name="citation_conference_title" content="23rd USENIX Symposium on Networked Systems Design and Implementation (NSDI 26)" />
        <meta name="citation_firstpage" content="2755" />
        <meta name="citation_lastpage" content="2778" />
        <meta name="citation_pdf_url" content="https://www.usenix.org/system/files/nsdi26-agarwal-anup.pdf" />
      </head>
      <body>
        <div class="field-name-field-paper-people-text">
          <p>Anup Agarwal, <em>Carnegie Mellon University</em></p>
        </div>
        <div class="field-name-field-paper-description">
          <p>Congestion control algorithms need fair and robust behavior.</p>
        </div>
        <div class="field-name-field-presentation-pdf">
          <a href="/system/files/conference/nsdi26/nsdi26spring_agarwal-anup_prepub.pdf">Prepublication PDF</a>
        </div>
      </body>
    </html>
    """
    paper = Paper(
        id="conf_nsdi_AgarwalAS26",
        title="FRCC: Towards Provably Fair and Robust Congestion Control",
        authors=["Anup Agarwal"],
        urls=["https://www.usenix.org/conference/nsdi26/presentation/agarwal-anup"],
    )

    metadata = DblpScraper.usenix_detail_metadata(
        html,
        "https://www.usenix.org/conference/nsdi26/presentation/agarwal-anup",
    )
    DblpScraper.apply_usenix_detail(paper, metadata)

    assert paper.abstract == "Congestion control algorithms need fair and robust behavior."
    assert paper.author_institutions == "Anup Agarwal (Carnegie Mellon University)"
    assert paper.publisher == "USENIX Association"
    assert paper.pages == "2755-2778"
    assert paper.pdf_urls == [
        "https://www.usenix.org/system/files/nsdi26-agarwal-anup.pdf",
        "https://www.usenix.org/system/files/conference/nsdi26/nsdi26spring_agarwal-anup_prepub.pdf",
    ]
    assert paper.extra["officialSources"] == ["usenix"]


def test_usenix_people_are_split_per_author():
    people = (
        "Jiawei Tyler Gu, Zhen Tang, and William X. Zheng, University of Illinois "
        "Urbana-Champaign; Yue Zhang and Akond Rahman, Auburn University; "
        "Chen Wang, IBM Research"
    )
    authors = [
        "Jiawei Tyler Gu",
        "Zhen Tang",
        "William X. Zheng",
        "Yue Zhang",
        "Akond Rahman",
        "Chen Wang",
    ]

    assert format_usenix_people(people, authors) == "; ".join(
        [
            "Jiawei Tyler Gu (University of Illinois Urbana-Champaign)",
            "Zhen Tang (University of Illinois Urbana-Champaign)",
            "William X. Zheng (University of Illinois Urbana-Champaign)",
            "Yue Zhang (Auburn University)",
            "Akond Rahman (Auburn University)",
            "Chen Wang (IBM Research)",
        ]
    )


def test_usenix_people_match_across_diacritics_and_bail_out_when_unknown():
    # The byline spells a name with diacritics the citation_author tag drops.
    assert format_usenix_people(
        "I\u015f\u0131l Dillig and Venkat Arun, The University of Texas at Austin",
        ["Is\u0131l Dillig", "Venkat Arun"],
    ) == "Is\u0131l Dillig (The University of Texas at Austin); Venkat Arun (The University of Texas at Austin)"

    # An unlisted author means the grouping cannot be trusted -- keep the byline.
    assert format_usenix_people(
        "Yuanbo Wen and Jun Bi, Institute of Computing Technology",
        ["Jun Bi"],
    ) == ""
