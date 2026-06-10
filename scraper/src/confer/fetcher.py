"""HTTP client with a simple on-disk cache, shared by every adapter."""

from __future__ import annotations

import random
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import requests


DEFAULT_USER_AGENT = "confer/0.1 (+https://github.com/superpung/confer)"
#: Transient HTTP statuses worth retrying (rate limit + gateway/server errors).
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


class Fetcher:
    def __init__(
        self,
        cache_dir: Path,
        *,
        refresh: bool = False,
        timeout: int = 30,
        delay: float = 0.0,
        retries: int = 4,
        backoff: float = 1.0,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.timeout = timeout
        self.delay = delay
        self.retries = max(int(retries), 0)
        self.backoff = max(float(backoff), 0.0)
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def get_text(self, url: str, cache_key: str) -> str:
        return self._cached(cache_key, lambda: self._request("GET", url))

    def post_text(
        self,
        url: str,
        cache_key: str,
        data: Mapping[str, Any] | Sequence[tuple[str, Any]],
    ) -> str:
        return self._cached(cache_key, lambda: self._request("POST", url, data=data))

    # -- internals ---------------------------------------------------------
    def _cached(self, cache_key: str, produce: Any) -> str:
        cache_path = self.cache_dir / cache_key
        if cache_path.exists() and not self.refresh:
            return cache_path.read_text(encoding="utf-8", errors="replace")
        text = produce()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(text, encoding="utf-8")
        return text

    def _request(self, method: str, url: str, **kwargs: Any) -> str:
        """Fetch with bounded retry on transient failures.

        Only successful responses are ever cached, so a transient miss heals on
        the next run; retrying in-run means a single cold build still reaches full
        coverage without leaning on previously written output.
        """
        last_exc: Exception | None = None
        for attempt in range(self.retries + 1):
            if self.delay:
                time.sleep(self.delay)
            try:
                response = self.session.request(method, url, timeout=self.timeout, **kwargs)
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_exc = exc
                if attempt < self.retries:
                    time.sleep(self._wait(attempt))
                    continue
                raise
            if response.status_code in RETRY_STATUSES and attempt < self.retries:
                time.sleep(self._wait(attempt, response))
                continue
            response.raise_for_status()
            return response.text
        if last_exc:
            raise last_exc
        raise RuntimeError(f"request to {url} exhausted retries")

    def _wait(self, attempt: int, response: requests.Response | None = None) -> float:
        """Exponential backoff with jitter, honoring Retry-After when present."""
        if response is not None:
            header = response.headers.get("Retry-After")
            if header:
                try:
                    return min(float(header), 60.0)
                except ValueError:
                    pass
        return self.backoff * (2 ** attempt) + random.uniform(0, self.backoff)
