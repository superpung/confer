"""Tests for the Fetcher's transient-retry + cache behavior."""

from __future__ import annotations

import requests

from confer.fetcher import Fetcher


class FakeResponse:
    def __init__(self, status_code: int, text: str = "", headers: dict | None = None) -> None:
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"status {self.status_code}")


def make_fetcher(tmp_path, responses, monkeypatch):
    monkeypatch.setattr("confer.fetcher.time.sleep", lambda *_: None)
    fetcher = Fetcher(tmp_path, retries=3, backoff=0.0)
    calls = {"n": 0}

    def fake_request(method, url, **kwargs):
        calls["n"] += 1
        return responses[min(calls["n"] - 1, len(responses) - 1)]

    monkeypatch.setattr(fetcher.session, "request", fake_request)
    return fetcher, calls


def test_retries_on_429_then_succeeds(tmp_path, monkeypatch):
    fetcher, calls = make_fetcher(
        tmp_path, [FakeResponse(429), FakeResponse(200, "ok")], monkeypatch
    )
    assert fetcher.get_text("http://x", "a.txt") == "ok"
    assert calls["n"] == 2
    # only the successful body is cached
    assert (tmp_path / "a.txt").read_text() == "ok"


def test_retries_on_5xx(tmp_path, monkeypatch):
    fetcher, calls = make_fetcher(
        tmp_path, [FakeResponse(503), FakeResponse(502), FakeResponse(200, "done")], monkeypatch
    )
    assert fetcher.get_text("http://x", "b.txt") == "done"
    assert calls["n"] == 3


def test_persistent_error_raises_and_does_not_cache(tmp_path, monkeypatch):
    fetcher, calls = make_fetcher(tmp_path, [FakeResponse(500)], monkeypatch)
    try:
        fetcher.get_text("http://x", "c.txt")
        assert False, "expected HTTPError"
    except requests.HTTPError:
        pass
    assert calls["n"] == 4  # initial + 3 retries
    assert not (tmp_path / "c.txt").exists()


def test_honors_retry_after_header(tmp_path, monkeypatch):
    waits: list[float] = []
    monkeypatch.setattr("confer.fetcher.time.sleep", lambda s: waits.append(s))
    fetcher = Fetcher(tmp_path, retries=2, backoff=1.0)
    responses = [FakeResponse(429, headers={"Retry-After": "2"}), FakeResponse(200, "ok")]
    calls = {"n": 0}

    def fake_request(method, url, **kwargs):
        calls["n"] += 1
        return responses[min(calls["n"] - 1, len(responses) - 1)]

    monkeypatch.setattr(fetcher.session, "request", fake_request)
    assert fetcher.get_text("http://x", "d.txt") == "ok"
    assert 2.0 in waits  # honored the Retry-After value
