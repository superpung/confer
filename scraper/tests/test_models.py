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
