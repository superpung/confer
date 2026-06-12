import requests

from confer.enrichers import (
    CrossrefEnricher,
    OpenAlexEnricher,
    align_author_ids,
    clean_orcid,
    crossref_item_score,
    crossref_to_metadata,
    inverted_abstract,
    merge_metadata,
    merge_openalex_metadata,
    openalex_to_metadata,
    should_lookup_by_title,
    title_similarity,
    title_query_variants,
)
from confer.config import VenueConfig
from confer.fetcher import Fetcher
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


def test_merge_metadata_fills_missing_authors():
    paper = Paper(id="x", title="T")
    merge_metadata(paper, {"authorships": [
        {"name": "Jane Doe", "id": "0000-0002-1825-0097", "institution": "Example University"},
        {"name": "John Roe", "id": "", "institution": "Example Labs"},
    ]}, "openalex")

    assert paper.authors == ["Jane Doe", "John Roe"]
    assert paper.author_ids == ["0000-0002-1825-0097", ""]
    assert paper.author_institutions == "Jane Doe (Example University); John Roe (Example Labs)"


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


def test_merge_metadata_can_replace_non_title_doi():
    paper = Paper(id="x", title="A Paper", doi="10.1145/proceedings")

    merge_metadata(paper, {"doi": "10.1145/paper", "replace_doi": True}, "crossref")

    assert paper.doi == "10.1145/paper"
    assert paper.urls == ["https://doi.org/10.1145/paper"]


def test_crossref_title_match_fetches_doi_detail(tmp_path):
    class FakeCrossref(CrossrefEnricher):
        def lookup_by_title(self, paper):
            return {
                "DOI": "10.1145/1234567",
                "title": ["A Paper"],
                "URL": "https://doi.org/10.1145/1234567",
            }

        def lookup_by_doi(self, doi):
            return {
                "DOI": doi,
                "title": ["A Paper"],
                "container-title": ["Proceedings of Example"],
                "page": "1-20",
                "URL": f"https://doi.org/{doi}",
            }

    enricher = FakeCrossref(VenueConfig(id="x", name="X", year=2026), Fetcher(tmp_path), {})

    metadata = enricher.lookup(Paper(id="x", title="A Paper"))

    assert metadata["container"] == "Proceedings of Example"
    assert metadata["pages"] == "1-20"


def test_crossref_title_match_prefers_exact_rich_non_ssrn_result(tmp_path):
    title = "Developer Perspectives on Licensing and Copyright Issues Arising from Generative AI for Software Development"
    paper = Paper(id="x", title=title, authors=["Trevor Stalnaker"])
    venue = VenueConfig(id="x", name="X", year=2026, scraper="researchr")
    ssrn = {
        "DOI": "10.2139/ssrn.5353252",
        "title": [title],
        "container-title": ["SSRN Electronic Journal"],
        "published-online": {"date-parts": [[2025]]},
        "author": [{"given": "Trevor", "family": "Stalnaker"}],
        "type": "journal-article",
    }
    acm = {
        "DOI": "10.1145/3743133",
        "title": [title],
        "container-title": ["ACM Transactions on Software Engineering and Methodology"],
        "published-online": {"date-parts": [[2026, 2, 28]]},
        "volume": "35",
        "issue": "2",
        "page": "1-39",
        "author": [
            {
                "given": "Trevor",
                "family": "Stalnaker",
                "ORCID": "https://orcid.org/0009-0005-6000-4227",
            }
        ],
        "type": "journal-article",
    }

    assert crossref_item_score(acm, paper, venue) > crossref_item_score(ssrn, paper, venue)


def test_crossref_replaces_non_title_doi_with_title_specific_doi(tmp_path):
    class FakeCrossref(CrossrefEnricher):
        def lookup_by_doi(self, doi):
            return {
                "DOI": doi,
                "title": ["ICSE 2024 Companion Proceedings"],
                "container-title": ["Proceedings of Example"],
            }

        def lookup_by_title(self, paper):
            return {
                "DOI": "10.1145/3639478.3643105",
                "title": ["Hunting DeFi Vulnerabilities via Context-Sensitive Concolic Verification"],
                "container-title": ["Proceedings of Example"],
                "page": "324-325",
            }

    enricher = FakeCrossref(VenueConfig(id="x", name="X", year=2024), Fetcher(tmp_path), {})
    metadata = enricher.lookup(
        Paper(
            id="x",
            title="Hunting DeFi Vulnerabilities via Context-Sensitive Concolic Verification",
            doi="10.1145/3639478",
        )
    )

    assert metadata["doi"] == "10.1145/3639478.3643105"
    assert metadata["pages"] == "324-325"
    assert metadata["replace_doi"] is True


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
    assert title_similarity(r"Checking $\delta$-Satisfiability", "Checking δ-Satisfiability") == 1.0


def test_title_query_variants_include_math_ascii_fallbacks():
    variants = title_query_variants("Checking δ-Satisfiability of C^3")

    assert "Checking δ-Satisfiability of C^3" in variants
    assert "Checking delta-Satisfiability of C^3" in variants
    assert "Checking delta-Satisfiability of C3" in variants


def test_title_lookup_skips_generic_authorless_events():
    assert not should_lookup_by_title(Paper(id="x", title="Distinguished Papers"))
    assert not should_lookup_by_title(Paper(id="x", title="Relax with Capybaras"))
    assert not should_lookup_by_title(
        Paper(id="x", title="Research/JF/Industry/NIER Posters for Day 1 (17th November)")
    )
    assert should_lookup_by_title(
        Paper(id="x", title="Complementing secure code review with automated program analysis")
    )
    assert should_lookup_by_title(Paper(id="x", title="Short Title", authors=["Jane Doe"]))


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
        "author": [
            {"given": "Jane", "family": "Doe", "ORCID": "https://orcid.org/0000-0002-1825-0097"}
        ],
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
    assert meta["authorships"] == [
        {"name": "Jane Doe", "id": "0000-0002-1825-0097", "institution": ""}
    ]


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
        "authorships": [
            {
                "author": {
                    "display_name": "Jane Doe",
                    "orcid": "https://orcid.org/0000-0002-1825-0097",
                    "id": "https://openalex.org/A123",
                },
                "institutions": [{"display_name": "Example University"}],
            }
        ],
    }
    meta = openalex_to_metadata(item)
    assert meta["doi"] == "10.1145/1234567"
    assert meta["abstract"] == "Precise metadata"
    assert meta["container"] == "Example Journal"
    assert meta["publisher"] == "ACM"
    assert meta["pages"] == "1-20"
    assert meta["pdf_urls"] == ["https://example.org/paper.pdf", "https://example.org/oa.pdf"]
    assert meta["open_access"]["oa_status"] == "gold"
    assert meta["keywords"] == ["Static Analysis"]
    assert meta["authorships"] == [
        {
            "name": "Jane Doe",
            "id": "0000-0002-1825-0097",
            "institution": "Example University",
        }
    ]


def test_openalex_to_metadata_drops_placeholder_doi_urls():
    item = {
        "id": "https://openalex.org/W123",
        "doi": None,
        "primary_location": {
            "landing_page_url": "https://doi.org/None",
            "pdf_url": "https://doi.org/None",
        },
        "open_access": {"is_oa": True, "oa_status": "green", "oa_url": "https://doi.org/None"},
    }

    meta = openalex_to_metadata(item)

    assert "doi" not in meta
    assert meta["urls"] == ["https://openalex.org/W123"]
    assert "pdf_urls" not in meta
    assert meta["open_access"] == {"is_oa": True, "oa_status": "green"}


def test_openalex_to_metadata_derives_arxiv_pdf_from_doi():
    item = {
        "id": "https://openalex.org/W1",
        "doi": "https://doi.org/10.48550/arxiv.2605.19775",
        "title": "A Paper",
        "primary_location": {
            "landing_page_url": "https://doi.org/10.48550/arxiv.2605.19775",
            "pdf_url": None,
            "source": {"display_name": "arXiv (Cornell University)", "host_organization_name": "Cornell University"},
        },
        "open_access": {"is_oa": True, "oa_status": "green", "oa_url": "https://doi.org/10.48550/arxiv.2605.19775"},
    }

    meta = openalex_to_metadata(item)

    assert meta["doi"] == "10.48550/arxiv.2605.19775"
    assert meta["pdf_urls"] == [
        "https://doi.org/10.48550/arxiv.2605.19775",
        "https://arxiv.org/pdf/2605.19775",
    ]


def test_merge_openalex_metadata_combines_same_title_locations():
    doi_item = {
        "id": "https://openalex.org/W1",
        "doi": "https://doi.org/10.5281/zenodo.1",
        "title": "Artifact",
        "primary_location": {
            "landing_page_url": "https://doi.org/10.5281/zenodo.1",
            "source": {"display_name": "Zenodo", "host_organization_name": "CERN"},
        },
        "open_access": {"is_oa": True, "oa_status": "green", "oa_url": "https://doi.org/10.5281/zenodo.1"},
    }
    github_item = {
        "id": "https://openalex.org/W2",
        "doi": "https://doi.org/10.5281/zenodo.2",
        "title": "Artifact",
        "primary_location": {
            "landing_page_url": "https://github.com/example/artifact",
            "source": {"display_name": "Open MIND"},
        },
        "open_access": {"is_oa": True, "oa_status": "green", "oa_url": "https://github.com/example/artifact"},
    }

    meta = merge_openalex_metadata([doi_item, github_item])

    assert meta["doi"] == "10.5281/zenodo.1"
    assert "https://doi.org/10.5281/zenodo.1" in meta["pdf_urls"]
    assert "https://github.com/example/artifact" in meta["pdf_urls"]


def test_openalex_network_disabled_still_reads_cached_json(tmp_path):
    venue = VenueConfig(id="x", name="X", year=2026, scraper="researchr")
    fetcher = Fetcher(tmp_path)
    enricher = OpenAlexEnricher(venue, fetcher, {})
    url = "https://api.openalex.org/works?search=Cached"
    cache_path = tmp_path / enricher.cache_key_for_url(url)
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text('{"results":[{"id":"https://openalex.org/W1"}]}', encoding="utf-8")

    enricher.network_disabled = True

    assert enricher.openalex_json(url) == {"results": [{"id": "https://openalex.org/W1"}]}


def test_openalex_bad_query_does_not_disable_network():
    class BadQueryFetcher:
        def has_shared_cache(self, cache_key):
            return False

        def get_shared_text(self, url, cache_key):
            response = requests.Response()
            response.status_code = 400
            raise requests.HTTPError("400 Client Error", response=response)

    venue = VenueConfig(id="x", name="X", year=2026, scraper="researchr")
    enricher = OpenAlexEnricher(venue, BadQueryFetcher(), {})

    assert enricher.openalex_json("https://api.openalex.org/works?search=bad") is None
    assert not enricher.network_disabled
    assert enricher.failures == 0
