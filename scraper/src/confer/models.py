"""The unified paper schema shared by every scraper adapter and the site.

Field names are snake_case in Python; :meth:`Paper.to_dict` emits the camelCase
keys the Astro site consumes (see AGENTS.md "Unified Paper schema").
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .util import clean_doi, doi_from_url, split_author_names, strip_markup, unique_preserve_order


SMALL_TITLE_WORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "or",
    "the",
    "to",
    "via",
    "with",
}
TITLE_ACRONYMS = {
    "ai": "AI",
    "api": "API",
    "asic": "ASIC",
    "cgra": "CGRA",
    "cim": "CIM",
    "cpu": "CPU",
    "cpus": "CPUs",
    "dac": "DAC",
    "date": "DATE",
    "dma": "DMA",
    "dnn": "DNN",
    "dnns": "DNNs",
    "dram": "DRAM",
    "edram": "eDRAM",
    "edrams": "eDRAMs",
    "eda": "EDA",
    "fpga": "FPGA",
    "fpgas": "FPGAs",
    "gemm": "GEMM",
    "gpu": "GPU",
    "gpus": "GPUs",
    "hbm": "HBM",
    "ic": "IC",
    "ics": "ICs",
    "igzo": "IGZO",
    "iiot": "IIoT",
    "iot": "IoT",
    "isw": "ISW",
    "llm": "LLM",
    "llms": "LLMs",
    "lut": "LUT",
    "luts": "LUTs",
    "mram": "MRAM",
    "noc": "NoC",
    "nocs": "NoCs",
    "npu": "NPU",
    "npus": "NPUs",
    "onn": "ONN",
    "pcie": "PCIe",
    "qos": "QoS",
    "ram": "RAM",
    "rf": "RF",
    "risc": "RISC",
    "sram": "SRAM",
    "sot": "SOT",
    "soc": "SoC",
    "socs": "SoCs",
    "tpu": "TPU",
    "tsmc": "TSMC",
    "vlsi": "VLSI",
}
WORD_RE = r"[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?[A-Za-z]*"
LATEX_SYMBOLS = {
    r"\alpha": "α",
    r"\beta": "β",
    r"\delta": "δ",
    r"\epsilon": "ε",
    r"\varepsilon": "ε",
    r"\lambda": "λ",
    r"\mu": "μ",
    r"\nabla": "∇",
    r"\partial": "∂",
    r"\pi": "π",
    r"\Psi": "Psi",
    r"\ell": "ell",
    r"\infty": "∞",
    r"\forall": "∀",
    r"\exists": "∃",
    r"\times": "x",
    r"\sim": "~",
    r"\&": "&",
}
LATEX_ACCENTS = {
    r"\"a": "a",
    r"\"e": "e",
    r"\"i": "i",
    r"\"o": "o",
    r"\"u": "u",
    r"\'a": "a",
    r"\'e": "e",
    r"\'i": "i",
    r"\'o": "o",
    r"\'u": "u",
}
LATEX_UNDERLINE_WORD_RE = re.compile(r"\\?underline\{([^{}]*)\}([A-Za-z]*)", re.IGNORECASE)
LATEX_WRAPPER_RE = re.compile(
    r"\\?(?:boldsymbol|mathbf|mathrm|mathit|mathsf|mathcal|mathbb|operatorname|textit|textbf|text|underline)\{([^{}]*)\}",
    re.IGNORECASE,
)


def clean_title(title: str) -> str:
    """Normalize source titles for display without losing common technical notation."""
    text = strip_markup(title)
    text = strip_latex_math_delimiters(text)
    text = simplify_latex(text)
    text = re.sub(r"\$(?=\d)", "USD ", text)
    text = text.replace("$", "USD")
    text = re.sub(r"\s*:\s*:\s*", ": ", text)
    text = re.sub(r"\s+([:;,.)\]])", r"\1", text)
    text = re.sub(r"([(\[])\s+", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return normalize_title(text)


def strip_latex_math_delimiters(value: str) -> str:
    text = value
    for _ in range(4):
        updated = re.sub(r"\${1,2}([^$]+?)\${1,2}", r"\1", text)
        updated = re.sub(r"\\\((.+?)\\\)", r"\1", updated)
        updated = re.sub(r"\\\[(.+?)\\\]", r"\1", updated)
        if updated == text:
            break
        text = updated
    return text


def simplify_latex(value: str) -> str:
    text = value.replace(r"\text{-}", "-")
    text = LATEX_UNDERLINE_WORD_RE.sub(merge_underlined_word, text)
    for _ in range(6):
        updated = LATEX_WRAPPER_RE.sub(r"\1", text)
        if updated == text:
            break
        text = updated
    for source, replacement in LATEX_SYMBOLS.items():
        text = text.replace(source, replacement)
    for source, replacement in LATEX_ACCENTS.items():
        text = text.replace(source, replacement)
    text = re.sub(r"\^\{([^{}]+)\}", r"^\1", text)
    text = re.sub(r"_\{([^{}]+)\}", r"_\1", text)
    text = text.replace(r"\\", " ")
    text = re.sub(r"\\([A-Za-z]+)", r"\1", text)
    text = text.replace("{", "").replace("}", "")
    return text


def merge_underlined_word(match: re.Match[str]) -> str:
    word = f"{match.group(1)}{match.group(2)}"
    if not word or word.isupper():
        return word
    if any(char.islower() for char in word) and any(char.isupper() for char in word[1:]):
        return word[0].upper() + word[1:].lower()
    return word


def clean_display_text(value: str) -> str:
    return strip_markup(str(value or ""))


def clean_text_list(values: list[str]) -> list[str]:
    return unique_preserve_order([text for value in values if (text := clean_display_text(value))])


def clean_author_ids(values: list[str], author_count: int) -> list[str]:
    ids = [clean_display_text(value) for value in values]
    if not ids:
        return []
    if author_count:
        if len(ids) < author_count:
            ids.extend([""] * (author_count - len(ids)))
        elif len(ids) > author_count:
            ids = ids[:author_count]
    return ids


def clean_author_list(authors: list[str]) -> list[str]:
    cleaned = [text for value in authors if (text := clean_display_text(value))]
    if len(cleaned) == 1 and ("," in cleaned[0] or ";" in cleaned[0] or " and " in cleaned[0]):
        return split_author_names(cleaned[0].replace(";", ","))
    return cleaned


def clean_extra(value: Any) -> Any:
    if isinstance(value, str):
        return strip_markup(value)
    if isinstance(value, list):
        return [clean_extra(item) for item in value]
    if isinstance(value, dict):
        return {key: clean_extra(item) for key, item in value.items()}
    return value


def normalize_title(title: str) -> str:
    """Convert all-caps titles to readable title case while keeping common acronyms."""
    if not is_all_caps_title(title):
        return title

    parts = re.split(f"({WORD_RE})", title.lower())
    word_indexes = [index for index, part in enumerate(parts) if re.fullmatch(WORD_RE, part)]
    if not word_indexes:
        return title

    first_word = word_indexes[0]
    last_word = word_indexes[-1]
    previous_separator = ""
    for index in word_indexes:
        word = parts[index]
        separator = previous_separator.strip()
        is_boundary = index in {first_word, last_word} or separator.endswith(":") or separator in {
            "-",
            "–",
            "—",
        }
        parts[index] = normalize_title_word(word, force_capitalize=is_boundary)
        previous_separator = parts[index + 1] if index + 1 < len(parts) else ""
    return "".join(parts)


def is_all_caps_title(title: str) -> bool:
    letters = [char for char in title if char.isalpha()]
    return bool(letters) and any(char.isupper() for char in letters) and not any(
        char.islower() for char in letters
    )


def normalize_title_word(word: str, *, force_capitalize: bool = False) -> str:
    mapped = TITLE_ACRONYMS.get(word)
    if mapped:
        return mapped
    if word in SMALL_TITLE_WORDS and not force_capitalize:
        return word
    if re.fullmatch(r"\d+(?:\.\d+)?d", word):
        return word[:-1] + "D"
    if not word:
        return word
    return word[0].upper() + word[1:]


@dataclass
class Paper:
    id: str
    title: str = ""
    abstract: str = ""
    authors: list[str] = field(default_factory=list)
    author_institutions: str = ""
    author_ids: list[str] = field(default_factory=list)
    tracks: list[str] = field(default_factory=list)
    event_type: str = ""
    session_titles: list[str] = field(default_factory=list)
    sessions: list[str] = field(default_factory=list)
    dates: list[str] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    doi: str = ""
    publication_date: str = ""
    publisher: str = ""
    container: str = ""
    volume: str = ""
    issue: str = ""
    pages: str = ""
    pdf_urls: list[str] = field(default_factory=list)
    artifact_urls: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.title = clean_title(self.title)
        self.abstract = strip_markup(self.abstract)
        self.authors = clean_author_list(self.authors)
        self.author_institutions = clean_display_text(self.author_institutions)
        self.author_ids = clean_author_ids(self.author_ids, len(self.authors))
        self.tracks = clean_text_list(self.tracks)
        self.event_type = clean_display_text(self.event_type)
        self.session_titles = clean_text_list(self.session_titles)
        self.sessions = clean_text_list(self.sessions)
        self.dates = clean_text_list(self.dates)
        self.locations = clean_text_list(self.locations)
        self.urls = unique_preserve_order(self.urls)
        self.pdf_urls = unique_preserve_order(self.pdf_urls)
        self.artifact_urls = unique_preserve_order(self.artifact_urls)
        self.publisher = clean_display_text(self.publisher)
        self.container = clean_display_text(self.container)
        self.volume = clean_display_text(self.volume)
        self.issue = clean_display_text(self.issue)
        self.pages = clean_display_text(self.pages)
        self.keywords = clean_text_list(self.keywords)
        self.doi = clean_doi(self.doi) or next((d for url in self.urls if (d := doi_from_url(url))), "")

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "title": clean_title(self.title),
            "abstract": strip_markup(self.abstract),
            "authors": clean_author_list(self.authors),
            "authorInstitutions": clean_display_text(self.author_institutions),
            "tracks": clean_text_list(self.tracks),
            "eventType": clean_display_text(self.event_type),
            "sessionTitles": clean_text_list(self.session_titles),
            "sessions": clean_text_list(self.sessions),
            "dates": clean_text_list(self.dates),
            "locations": clean_text_list(self.locations),
            "urls": list(self.urls),
        }
        author_ids = clean_author_ids(self.author_ids, len(data["authors"]))
        if any(author_ids):
            data["authorIds"] = author_ids
        if self.doi:
            data["doi"] = self.doi
        if self.publication_date:
            data["publicationDate"] = self.publication_date
        if self.publisher:
            data["publisher"] = clean_display_text(self.publisher)
        if self.container:
            data["container"] = clean_display_text(self.container)
        if self.volume:
            data["volume"] = clean_display_text(self.volume)
        if self.issue:
            data["issue"] = clean_display_text(self.issue)
        if self.pages:
            data["pages"] = clean_display_text(self.pages)
        if self.pdf_urls:
            data["pdfUrls"] = list(self.pdf_urls)
        if self.artifact_urls:
            data["artifactUrls"] = list(self.artifact_urls)
        if self.keywords:
            data["keywords"] = clean_text_list(self.keywords)
        if self.extra:
            data["extra"] = clean_extra(self.extra)
        return data
