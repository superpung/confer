import json
from pathlib import Path

from bs4 import BeautifulSoup

from confer.config import VenueConfig
from confer.fetcher import Fetcher
from confer.models import Paper
from confer.scrapers.researchr import ResearchrScraper

FIXTURES = Path(__file__).parent / "fixtures"


def make_scraper(
    tmp_path: Path,
    *,
    series: str = "ICSE",
    source: dict[str, object] | None = None,
) -> ResearchrScraper:
    source_config: dict[str, object] = {
        "program_url": "https://conf.researchr.org/program/icse-2026/program-icse-2026/",
    }
    if source:
        source_config.update(source)
    venue = VenueConfig(
        id="test",
        name="Test",
        series=series,
        scraper="researchr",
        source=source_config,
    )
    return ResearchrScraper(venue, Fetcher(tmp_path, refresh=False))


def test_parse_program_extracts_occurrence_and_modal_config(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "researchr_program.html").read_text(encoding="utf-8")
    occurrences, modal_config = scraper.parse_program(html)

    assert modal_config is not None
    assert modal_config.action_name == "modal_action"
    assert modal_config.event_input_name == "event_field"
    assert modal_config.form_name == "form_modal"
    assert modal_config.context == "icse-2026"

    assert len(occurrences) == 1
    occurrence = occurrences[0]
    assert occurrence.event_id == "event-1"
    assert occurrence.slot_id == "slot-1"
    assert occurrence.title == (
        "MazeBreaker: Multi-Agent Reinforcement Learning for Dynamic Jailbreaking "
        "of LLM Security Defenses"
    )
    assert occurrence.event_type == "Talk"
    assert occurrence.tracks == ["Research Track"]
    assert occurrence.facet_tracks == ["Research Track", "SE In Practice (SEIP)"]
    assert occurrence.authors == ["Zhihao Lin", "Wei Ma"]
    assert occurrence.author_institutions == "Zhihao Lin; Wei Ma (Singapore Management University)"
    assert occurrence.session_title == "Software Engineering for AI 2"
    assert occurrence.date == "Wed 15 Apr 2026 14:00 - 14:15"
    assert occurrence.location == "Oceania VII"
    assert occurrence.urls == ["https://arxiv.org/pdf/2503.17953"]
    assert scraper.keep_occurrence(occurrence)


def test_modal_response_and_paper_schema(tmp_path):
    scraper = make_scraper(tmp_path)
    html = (FIXTURES / "researchr_program.html").read_text(encoding="utf-8")
    occurrences, _ = scraper.parse_program(html)
    event = scraper.merge_occurrences([occurrences[0]])[0]
    modal_html = """
    <div class="modal">
      <div class="modal-body">
        <div class="bg-primary event-title"><h4>MazeBreaker</h4></div>
        <div class="bg-info event-description">
          <p>Adaptive jailbreak attack abstract.</p>
          <div class="row"><a href="/profile/icse-2026/zhihaolin1">Zhihao Lin</a></div>
          <a href="https://example.org/artifact">Artifact</a>
        </div>
      </div>
      <div class="modal-footer">
        <a href="https://conf.researchr.org/details/icse-2026/icse-2026-research-track/41/MazeBreaker">All Details</a>
      </div>
    </div>
    """
    detail = scraper.parse_modal_response(
        json.dumps([{"action": "append", "id": "event-modals", "value": modal_html}])
    )
    paper = scraper.to_paper(event, detail)

    assert detail.abstract == "Adaptive jailbreak attack abstract."
    assert paper.id == "event-1"
    assert paper.abstract == "Adaptive jailbreak attack abstract."
    assert paper.urls[0].endswith("/MazeBreaker")
    assert paper.urls[1] == "https://arxiv.org/pdf/2503.17953"
    assert paper.urls[2] == "https://example.org/artifact"
    assert paper.tracks == ["Research Track"]
    assert paper.event_type == "Talk"
    assert paper.sessions == ["Wed_15_Apr_2026-Oceania_VII-14_00_-_15_30-Software_Engineering_for_AI_2"]

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


def test_timeline_program_uses_modal_details_for_schema(tmp_path):
    scraper = make_scraper(
        tmp_path,
        series="FSE",
        source={
            "program_url": "https://conf.researchr.org/program/fse-2026/program-fse-2026/Detailed-Timeline",
        },
    )
    html = (FIXTURES / "researchr_timeline_program.html").read_text(encoding="utf-8")
    occurrences, modal_config = scraper.parse_program(html)

    assert modal_config is not None
    assert len(occurrences) == 1
    occurrence = occurrences[0]
    assert occurrence.event_id == "timeline-event"
    assert occurrence.slot_id == "timeline-slot"
    assert occurrence.title == "Short timeline title"
    assert occurrence.tracks == ["Research Papers"]
    assert occurrence.date == "Mon 6 Jul 2026 10:00 - 10:15"
    assert occurrence.location == "Room A"
    assert occurrence.authors == []
    assert scraper.keep_occurrence(occurrence)

    event = scraper.merge_occurrences([occurrence])[0]
    modal_html = """
    <div class="modal">
      <div class="modal-header">
        <p class="text-muted"><span></span> FSE Research Papers</p>
        <strong>Mon 6 Jul 2026 10:00 - 10:15 at <a class="room-link">Room A</a></strong>
        - <a class="navigate" href="/track/fse-2026/research#program">Session Alpha</a>
      </div>
      <div class="modal-body">
        <div class="bg-primary event-title"><h4><strong>Full Modal Paper Title</strong></h4></div>
        <div class="bg-info event-description">
          <p>Timeline abstract.</p>
          <div class="row">
            <div class="col-sm-6">
              <a href="https://conf.researchr.org/profile/fse-2026/alice">
                <div class="media">
                  <div class="media-body">
                    <h5 class="media-heading">Alice <span class="name-visual-sep"></span> Example</h5>
                    <h5 class="media-heading"><span class="text-black">Example University</span></h5>
                  </div>
                </div>
              </a>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <a href="https://conf.researchr.org/details/fse-2026/fse-2026-research-papers/1/Full">All Details</a>
      </div>
    </div>
    """
    detail = scraper.parse_modal_response(
        json.dumps([{"action": "append", "id": "event-modals", "value": modal_html}])
    )
    paper = scraper.to_paper(event, detail)

    assert paper.title == "Full Modal Paper Title"
    assert paper.abstract == "Timeline abstract."
    assert paper.authors == ["Alice Example"]
    assert paper.author_institutions == "Alice Example (Example University)"
    assert paper.tracks == ["Research Papers"]
    assert paper.event_type == "Paper"
    assert paper.session_titles == ["Research Papers", "Session Alpha"]
    assert paper.dates == ["Mon 6 Jul 2026 10:00 - 10:15"]
    assert paper.locations == ["Room A"]


def test_modal_people_splits_visual_institution_when_institution_field_is_empty():
    soup = BeautifulSoup(
        """
        <div>
          <a href="https://conf.researchr.org/profile/fse-2026/cuiyungao">
            <div class="media">
              <div class="media-body">
                <h5 class="media-heading">Cuiyun Gao <span class="name-visual-sep"></span>Harbin Institute of Technology, Shenzhen</h5>
                <h5 class="media-heading"><span class="text-black"></span></h5>
              </div>
            </div>
          </a>
        </div>
        """,
        "html.parser",
    )

    assert ResearchrScraper.parse_modal_people(soup) == [
        {"name": "Cuiyun Gao", "institution": "Harbin Institute of Technology, Shenzhen"}
    ]


def test_overview_program_extracts_accepted_papers(tmp_path):
    scraper = make_scraper(
        tmp_path,
        series="OOPSLA",
        source={
            "program_url": "https://conf.researchr.org/track/splash-2026/oopsla-2026",
        },
    )
    html = (FIXTURES / "researchr_overview_program.html").read_text(encoding="utf-8")
    occurrences, modal_config = scraper.parse_program(html)

    assert modal_config is not None
    assert len(occurrences) == 1
    occurrence = occurrences[0]
    assert occurrence.event_id == "overview-event"
    assert occurrence.title == "Accepted OOPSLA Paper"
    assert occurrence.event_type == "Paper"
    assert occurrence.tracks == ["OOPSLA"]
    assert occurrence.authors == ["Ada Lovelace", "Grace Hopper"]
    assert occurrence.session_title == "OOPSLA"
    assert occurrence.date == ""
    assert occurrence.location == ""
    assert scraper.keep_occurrence(occurrence)


def test_placeholder_abstracts_and_nonpaper_titles(tmp_path):
    scraper = make_scraper(tmp_path)
    modal_html = """
    <div class="modal">
      <div class="modal-body">
        <div class="bg-primary event-title"><h4>Q&A</h4></div>
        <div class="bg-info event-description"><p>No description available.</p></div>
      </div>
    </div>
    """
    detail = scraper.parse_modal_response(
        json.dumps([{"action": "append", "id": "event-modals", "value": modal_html}])
    )

    assert detail.abstract == ""
    assert not scraper.keep_paper(Paper(id="qa", title="Q&A", event_type="Paper"))
    assert scraper.keep_paper(
        Paper(
            id="paper",
            title="Domain Specific Languages for Optimisation Modelling",
            event_type="Paper",
        )
    )
