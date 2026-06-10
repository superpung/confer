from confer.enrichers import (
    align_author_ids,
    clean_orcid,
    crossref_to_metadata,
    inverted_abstract,
    merge_metadata,
    openalex_to_metadata,
    title_similarity,
)
from confer.models import Paper


def test_clean_orcid_extracts_from_url():
    assert clean_orcid("https://orcid.org/0000-0002-1825-0097") == "0000-0002-1825-0097"
    assert clean_orcid("0000-0002-1694-233X") == "0000-0002-1694-233X"
    assert clean_orcid("") == ""


def test_align_author_ids_by_position_and_name():
    # equal length -> positional
    assert align_author_ids(["A", "B"], [{"name": "A", "id": "x"}, {"name": "B", "id": "y"}]) == ["x", "y"]
    # unequal -> match by normalized name
    ids = align_author_ids(["Jane Doe", "Zed"], [{"name": "jane  doe", "id": "j"}])
    assert ids == ["j", ""]


def test_merge_metadata_sets_author_ids():
    paper = Paper(id="x", title="T", authors=["Jane Doe", "John Roe"])
    merge_metadata(paper, {"authorships": [
        {"name": "Jane Doe", "id": "0000-0002-1825-0097"},
        {"name": "John Roe", "id": "A123"},
    ]}, "openalex")
    assert paper.author_ids == ["0000-0002-1825-0097", "A123"]


def test_merge_metadata_fills_publication_fields():
    paper = Paper(
        id="x",
        title="A Paper",
        urls=["https://example.org/program"],
    )

    merge_metadata(
        paper,
        {
            "doi": "https://doi.org/10.1145/1234567",
            "abstract": "A precise abstract.",
            "publication_date": "2026-01-02",
            "publisher": "ACM",
            "container": "Proceedings of Example",
            "volume": "1",
            "issue": "2",
            "pages": "3-10",
            "urls": ["https://doi.org/10.1145/1234567"],
            "pdf_urls": ["https://example.org/paper.pdf"],
            "keywords": ["Software engineering"],
        },
        "crossref",
    )

    assert paper.doi == "10.1145/1234567"
    assert paper.abstract == "A precise abstract."
    assert paper.publication_date == "2026-01-02"
    assert paper.publisher == "ACM"
    assert paper.container == "Proceedings of Example"
    assert paper.volume == "1"
    assert paper.issue == "2"
    assert paper.pages == "3-10"
    assert paper.urls == ["https://doi.org/10.1145/1234567", "https://example.org/program"]
    assert paper.pdf_urls == ["https://example.org/paper.pdf"]
    assert paper.keywords == ["Software engineering"]
    assert paper.extra == {"metadataSources": ["crossref"]}


def test_merge_metadata_replaces_truncated_title():
    paper = Paper(id="x", title="SLR: From Saltzer & Schoeder to 2021…")
    merge_metadata(
        paper,
        {
            "title": (
                "SLR: From Saltzer and Schroeder to 2021... 47 Years of Research "
                "on the Development and Validation of Security API Recommendations"
            ),
        },
        "crossref",
    )

    assert paper.title.endswith("Security API Recommendations")


def test_inverted_abstract_reconstructs_word_order():
    index = {"Static": [0], "paper": [1], "sites": [2], "rock": [3]}
    assert inverted_abstract(index) == "Static paper sites rock"
    assert inverted_abstract({}) == ""


def test_title_similarity_ignores_case_and_punctuation():
    assert title_similarity("Hello, World!", "hello world") == 1.0
    assert title_similarity("", "anything") == 0.0
    assert title_similarity("Graph Neural Networks", "Quantum Error Correction") < 0.5


def test_crossref_to_metadata_maps_fields():
    item = {
        "DOI": "10.1145/1234567",
        "abstract": "<jats:p>An &amp; abstract.</jats:p>",
        "published-print": {"date-parts": [[2026, 3]]},
        "publisher": "ACM",
        "container-title": ["Proc. of Example"],
        "volume": "12",
        "issue": "3",
        "page": "1-20",
        "URL": "https://doi.org/10.1145/1234567",
        "link": [
            {"URL": "https://example.org/p.pdf", "content-type": "application/pdf"},
            {"URL": "https://example.org/p.html", "content-type": "text/html"},
        ],
        "subject": ["Software Engineering"],
    }
    meta = crossref_to_metadata(item)
    assert meta["doi"] == "10.1145/1234567"
    assert meta["abstract"] == "An & abstract."
    assert meta["publication_date"] == "2026-03-01"
    assert meta["container"] == "Proc. of Example"
    assert meta["pages"] == "1-20"
    assert meta["pdf_urls"] == ["https://example.org/p.pdf"]
    assert meta["keywords"] == ["Software Engineering"]


def test_openalex_to_metadata_maps_fields():
    item = {
        "doi": "https://doi.org/10.1145/1234567",
        "abstract_inverted_index": {"Precise": [0], "metadata": [1]},
        "publication_date": "2026-01-02",
        "primary_location": {
            "landing_page_url": "https://example.org/paper",
            "pdf_url": "https://example.org/paper.pdf",
            "source": {"display_name": "Example Journal", "host_organization_name": "ACM"},
        },
        "biblio": {"first_page": "1", "last_page": "20"},
        "open_access": {"is_oa": True, "oa_status": "gold", "oa_url": "https://example.org/oa.pdf"},
        "keywords": [{"display_name": "Static Analysis"}],
    }
    meta = openalex_to_metadata(item)
    assert meta["doi"] == "10.1145/1234567"
    assert meta["abstract"] == "Precise metadata"
    assert meta["container"] == "Example Journal"
    assert meta["publisher"] == "ACM"
    assert meta["pages"] == "1-20"
    assert meta["pdf_urls"] == ["https://example.org/paper.pdf"]
    assert meta["open_access"]["oa_status"] == "gold"
    assert meta["keywords"] == ["Static Analysis"]
