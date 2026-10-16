"""Shared fixtures: a loopback mock of the Portcloud Notify HTTP API.

The mock is a :class:`http.server.ThreadingHTTPServer` bound to
``127.0.0.1:0`` (never a fixed port) running in a daemon thread.  Tests script
its answers with either a FIFO queue (:meth:`MockService.queued`), per-path
routes (:meth:`MockService.route`), or a callable handler
(:meth:`MockService.set_handler`).
"""

from __future__ import annotations

import json
import socket
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlsplit

import pytest

from portcloud_notify import Client

API_KEY = "pck_test"

HandlerFn = Callable[[str, str, dict[str, list[str]], Any], Optional["Response"]]


@dataclass
class Response:
    """One scripted HTTP response.

    ``body`` (raw bytes) wins over ``payload`` (JSON-encoded).  ``content_type``
    is overridden by ``headers`` when the same header is given there.
    """

    status: int = 200
    payload: Any = None
    body: Optional[bytes] = None
    headers: dict[str, str] = field(default_factory=dict)
    content_type: str = "application/json"

    def render(self) -> tuple[int, dict[str, str], bytes]:
        if self.body is not None:
            raw = self.body
        elif self.payload is None:
            raw = b""
        else:
            raw = json.dumps(self.payload).encode("utf-8")
        headers = {"Content-Type": self.content_type, "Content-Length": str(len(raw))}
        headers.update(self.headers)
        return self.status, headers, raw


class MockService:
    """Records every request and answers from the scripted responses."""

    def __init__(self) -> None:
        self.url: str = ""
        self.requests: list[dict[str, Any]] = []
        self._queue: list[Response] = []
        self._routes: dict[tuple[str, str], Response] = {}
        self._handler: Optional[HandlerFn] = None
        self._lock = threading.Lock()
        service = self

        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:  # silence stderr noise
                pass

            def _dispatch(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                parsed: Any = None
                if raw:
                    try:
                        parsed = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, ValueError):
                        parsed = None
                parts = urlsplit(self.path)
                query = parse_qs(parts.query)
                service.requests.append(
                    {
                        "method": self.command,
                        "path": parts.path,
                        "query": query,
                        "headers": {name.lower(): value for name, value in self.headers.items()},
                        "body": parsed,
                    }
                )
                response = service._resolve(self.command, parts.path, query, parsed)
                status, headers, body = response.render()
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                if body:
                    self.wfile.write(body)
                self.close_connection = True

            do_GET = _dispatch
            do_POST = _dispatch

        self.handler_class = _Handler

    # ------------------------------------------------------------- scripting

    def queued(
        self,
        status: int = 200,
        payload: Any = None,
        *,
        body: Optional[bytes] = None,
        headers: Optional[dict[str, str]] = None,
        content_type: str = "application/json",
    ) -> Response:
        """Append one response to the FIFO queue and return it."""
        response = Response(
            status=status,
            payload=payload,
            body=body,
            headers=dict(headers or {}),
            content_type=content_type,
        )
        with self._lock:
            self._queue.append(response)
        return response

    def route(self, method: str, path: str, **kwargs: Any) -> Response:
        """Answer every request for ``method``+``path`` with the same response."""
        response = Response(**kwargs)
        with self._lock:
            self._routes[(method.upper(), path)] = response
        return response

    def set_handler(self, handler: Optional[HandlerFn]) -> None:
        """Install a callable consulted before the queue; ``None`` falls through."""
        with self._lock:
            self._handler = handler

    def error(
        self,
        status: int,
        code: str,
        message: str,
        details: Optional[dict[str, Any]] = None,
        *,
        headers: Optional[dict[str, str]] = None,
    ) -> Response:
        """Queue the standard ``{"error": {...}}`` envelope."""
        return self.queued(
            status=status,
            payload=self.error_envelope(code, message, details),
            headers=headers,
        )

    @staticmethod
    def error_envelope(
        code: str, message: str, details: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        """Build the documented error envelope."""
        return {"error": {"code": code, "message": message, "details": dict(details or {})}}

    # ------------------------------------------------------------ inspection

    def count(self, path: Optional[str] = None) -> int:
        """Number of recorded requests, optionally for one path."""
        if path is None:
            return len(self.requests)
        return sum(1 for request in self.requests if request["path"] == path)

    def paths(self) -> list[str]:
        return [request["path"] for request in self.requests]

    def _resolve(self, method: str, path: str, query: dict[str, list[str]], body: Any) -> Response:
        with self._lock:
            route = self._routes.get((method.upper(), path))
            handler = self._handler
        if route is not None:
            return route
        if handler is not None:
            response = handler(method, path, query, body)
            if response is not None:
                return response
        with self._lock:
            if self._queue:
                return self._queue.pop(0)
        return Response(
            status=500,
            payload=self.error_envelope(
                "NO_SCRIPTED_RESPONSE",
                f"The mock service has no scripted response for {method} {path}.",
            ),
        )


# ------------------------------------------------------------------ fixtures


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never let the developer's real environment leak into a test."""
    for name in (
        "PORTCLOUD_NOTIFY_API_KEY",
        "PORTCLOUD_NOTIFY_BASE_URL",
        "PORTCLOUD_NOTIFY_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def service() -> MockService:
    mock = MockService()
    server = ThreadingHTTPServer(("127.0.0.1", 0), mock.handler_class)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    mock.url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        yield mock
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def client(service: MockService) -> Client:
    return Client(api_key=API_KEY, base_url=service.url)


@pytest.fixture
def dead_url() -> str:
    """A loopback URL whose port was just released, so connections are refused."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return f"http://127.0.0.1:{port}"


# ------------------------------------------------------------- shared payloads

LIMITS_PAYLOAD: dict[str, Any] = {
    "daily_message_credits": 100,
    "message_credits_used": 10,
    "message_credits_reserved": 2,
    "message_credits_remaining": 88,
    "credits_per_email": 1,
    "credits_per_ntfy": 1,
    "credits_per_target": {"email": 1, "ntfy": 1},
    "daily_reset_at": "2026-10-17T00:00:00Z",
    "minute_attempt_limit": 10,
    "daily_attempt_limit": 100,
    "daily_attempt_used": 3,
    "max_verified_emails": 5,
    "max_ntfy_channels": 5,
    "max_api_keys": 3,
    "max_message_size_bytes": 1048576,
    "is_admin": False,
}

PAGE_PAYLOAD: dict[str, Any] = {
    "items": [
        {
            "id": 11,
            "status": "success",
            "created_at": "2026-10-16T10:00:00Z",
            "api_key_id": 4,
            "client_ip": "127.0.0.1",
            "duration_ms": 120,
            "failure_reason": None,
            "message_size_bytes": 42,
            "recipient": "a@b.c",
            "smtp_response": "250 OK",
            "subject": "Deploy done",
            "unknown_item_field": "ignored",
        }
    ],
    "total": 1,
    "page": 2,
    "page_size": 5,
    "pages": 1,
    "unknown_page_field": "ignored",
}

OVERVIEW_PAYLOAD: dict[str, Any] = {
    "range": "30d",
    "bucket": "day",
    "totals": {
        "attempted": 10,
        "success": 8,
        "failed": 1,
        "rejected": 1,
        "success_rate": 0.8,
    },
    "series": [
        {
            "bucket_start": "2026-10-15T00:00:00Z",
            "success": 4,
            "failed": 1,
            "rejected": 0,
        }
    ],
    "failure_reasons": [{"reason": "smtp_550", "count": 1}],
    "today": {
        "attempted": 2,
        "success": 2,
        "failed": 0,
        "rejected": 0,
        "success_rate": 1.0,
        "reset_at": "2026-10-17T00:00:00Z",
    },
}


def send_status_payload(
    status: str = "queued", log_id: int = 123, **overrides: Any
) -> dict[str, Any]:
    """A ``GET /api/v1/send/{log_id}`` body."""
    payload: dict[str, Any] = {
        "log_id": log_id,
        "status": status,
        "created_at": "2026-10-16T10:00:00Z",
    }
    payload.update(overrides)
    return payload
