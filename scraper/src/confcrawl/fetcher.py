"""HTTP client with a simple on-disk cache, shared by every adapter."""

from __future__ import annotations

import time
from pathlib import Path

import requests


DEFAULT_USER_AGENT = "confcrawl/0.1 (+https://github.com/superpung/confcrawl)"


class Fetcher:
    def __init__(
        self,
        cache_dir: Path,
        *,
        refresh: bool = False,
        timeout: int = 30,
        delay: float = 0.0,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.timeout = timeout
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def get_text(self, url: str, cache_key: str) -> str:
        cache_path = self.cache_dir / cache_key
        if cache_path.exists() and not self.refresh:
            return cache_path.read_text(encoding="utf-8", errors="replace")

        if self.delay:
            time.sleep(self.delay)
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        text = response.text
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(text, encoding="utf-8")
        return text
