"""The unified paper schema shared by every scraper adapter and the site.

Field names are snake_case in Python; :meth:`Paper.to_dict` emits the camelCase
keys the Astro site consumes (see AGENTS.md "Unified Paper schema").
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


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
    tracks: list[str] = field(default_factory=list)
    event_type: str = ""
    session_titles: list[str] = field(default_factory=list)
    sessions: list[str] = field(default_factory=list)
    dates: list[str] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.title = normalize_title(self.title)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "title": self.title,
            "abstract": self.abstract,
            "authors": list(self.authors),
            "authorInstitutions": self.author_institutions,
            "tracks": list(self.tracks),
            "eventType": self.event_type,
            "sessionTitles": list(self.session_titles),
            "sessions": list(self.sessions),
            "dates": list(self.dates),
            "locations": list(self.locations),
            "urls": list(self.urls),
        }
        if self.extra:
            data["extra"] = self.extra
        return data
