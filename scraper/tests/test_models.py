from confer.models import Paper


def test_paper_normalizes_all_caps_title():
    paper = Paper(
        id="x",
        title="3D INTEGRATION OF HYBRID IGZO/SI AND IGZO EDRAMS FOR AI-DRIVEN DNN ACCELERATION",
    )

    assert paper.title == (
        "3D Integration of Hybrid IGZO/Si and IGZO eDRAMs for AI-Driven DNN Acceleration"
    )


def test_paper_keeps_mixed_case_title():
    title = "MazeBreaker: Multi-Agent Reinforcement Learning for Dynamic Jailbreaking"
    assert Paper(id="x", title=title).title == title


def test_paper_strips_markup_from_title():
    paper = Paper(
        id="x",
        title="<i>TAEFuzz:</i> Automatic Fuzzing and D<sup>3</sup> Testing",
    )

    assert paper.title == "TAEFuzz: Automatic Fuzzing and D3 Testing"


def test_paper_cleans_latex_title_delimiters():
    paper = Paper(
        id="x",
        title=r"NaVLA$^2$: $\pi$-Invariant Test-Time Projection for $O(n^{2})$ Models",
    )

    assert paper.title == "NaVLA^2: π-Invariant Test-Time Projection for O(n^2) Models"
    assert "$" not in paper.to_dict()["title"]


def test_paper_cleans_latex_wrappers_and_escapes():
    paper = Paper(
        id="x",
        title=r"TORAI: \textit{Blind Spots} in Schr\"odinger Layers:\\ \(\epsilon\)-Optimal",
    )

    assert paper.title == "TORAI: Blind Spots in Schrodinger Layers: ε-Optimal"


def test_paper_cleans_underlined_word_fragments():
    paper = Paper(
        id="x",
        title=r"SAGA: A Memory-Efficient \underline{A}ccelerator for \underline{GA}NN Construction",
    )
    date_paper = Paper(
        id="y",
        title="LAMOS: ENABLING EFFICIENT UNDERLINE{LA}RGE NUMBER UNDERLINE{MO}DULAR MULTIPLICATION",
    )

    assert paper.title == "SAGA: A Memory-Efficient Accelerator for GANN Construction"
    assert date_paper.title == "Lamos: Enabling Efficient Large Number Modular Multiplication"


def test_paper_cleans_double_escaped_entities():
    paper = Paper(
        id="x",
        title="A &amp;amp; B",
        container="IEEE/ACM CSEE&amp;amp;T",
    )

    data = paper.to_dict()
    assert data["title"] == "A & B"
    assert data["container"] == "IEEE/ACM CSEE&T"


def test_paper_cleans_joined_author_string():
    paper = Paper(id="x", authors=["Jane Doe, John Roe, Richard Kubina, Jr."])

    assert paper.to_dict()["authors"] == ["Jane Doe", "John Roe", "Richard Kubina, Jr."]


def test_paper_preserves_duplicate_author_names_for_id_alignment():
    paper = Paper(
        id="x",
        authors=["Jane Doe", "Jane Doe"],
        author_ids=["~Jane_Doe1", "~Jane_Doe2"],
    )

    assert paper.to_dict()["authors"] == ["Jane Doe", "Jane Doe"]
    assert paper.to_dict()["authorIds"] == ["~Jane_Doe1", "~Jane_Doe2"]


def test_paper_preserves_aligned_author_id_slots():
    paper = Paper(id="x", authors=["Jane Doe", "John Roe", "Zed"], author_ids=["id-1", "", "id-3"])

    assert paper.to_dict()["authorIds"] == ["id-1", "", "id-3"]


def test_paper_cleans_extra_text_entities():
    paper = Paper(id="x", extra={"tldr": "Fixes &lt;eos&gt; overflow"})

    assert paper.to_dict()["extra"]["tldr"] == "Fixes <eos> overflow"
