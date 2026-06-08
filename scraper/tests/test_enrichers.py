from confer.enrichers import merge_metadata
from confer.models import Paper


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
