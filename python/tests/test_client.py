"""Request shaping, polling, and configuration of :class:`Client`."""

from __future__ import annotations

import time

import pytest

from conftest import (
    API_KEY,
    LIMITS_PAYLOAD,
    OVERVIEW_PAYLOAD,
    PAGE_PAYLOAD,
    MockService,
    send_status_payload,
)
from portcloud_notify import (
    DEFAULT_BASE_URL,
    Client,
    ConfigurationError,
    Limits,
    NotificationsDisabledError,
    Page,
    PollTimeoutError,
    PresetSendAccepted,
    SendAccepted,
    SendLog,
    SendStatus,
)

SEND_PATH = "/api/v1/send"
PRESET_PATH = "/api/v1/send-preset"


# ------------------------------------------------------------------- sending


def test_send_posts_minimal_payload_and_headers(client: Client, service: MockService) -> None:
    service.queued(status=201, payload={"log_id": 7, "status": "queued"})

    accepted = client.send("email", "T", body="B")

    assert accepted == SendAccepted(log_id=7, status="queued")
    assert service.count() == 1
    request = service.requests[0]
    assert request["method"] == "POST"
    assert request["path"] == SEND_PATH
    assert request["query"] == {}
    assert request["headers"]["authorization"] == f"Bearer {API_KEY}"
    assert request["headers"]["content-type"] == "application/json"
    assert request["body"] == {"type": "email", "title": "T", "body": "B"}
    assert "to" not in request["body"]


def test_send_email_html_with_target(client: Client, service: MockService) -> None:
    service.queued(status=201, payload={"log_id": 8, "status": "queued"})

    accepted = client.send("email", "T", html="<b>x</b>", to="a@b.c")

    assert accepted.log_id == 8
    assert service.requests[0]["body"] == {
        "type": "email",
        "title": "T",
        "html": "<b>x</b>",
        "to": "a@b.c",
    }


def test_send_ntfy_with_target_has_no_html(client: Client, service: MockService) -> None:
    service.queued(status=201, payload={"log_id": 9, "status": "queued"})

    client.send("ntfy", "T", body="B", to="topic")

    body = service.requests[0]["body"]
    assert body == {"type": "ntfy", "title": "T", "body": "B", "to": "topic"}
    assert "html" not in body


def test_send_preset_posts_exact_payload(client: Client, service: MockService) -> None:
    service.queued(status=201, payload={"log_id": 12, "preset_id": 3, "status": "queued"})

    accepted = client.send_preset("T", "B")

    assert accepted == PresetSendAccepted(log_id=12, preset_id=3, status="queued")
    request = service.requests[0]
    assert request["method"] == "POST"
    assert request["path"] == PRESET_PATH
    assert request["body"] == {"title": "T", "body": "B"}


# -------------------------------------------------------------------- status


@pytest.mark.parametrize(
    "status,terminal,succeeded",
    [
        ("queued", False, False),
        ("sending", False, False),
        ("success", True, True),
        ("failed", True, False),
        ("rejected", True, False),
    ],
)
def test_get_status_parses_and_reports_flags(
    client: Client, service: MockService, status: str, terminal: bool, succeeded: bool
) -> None:
    service.queued(payload=send_status_payload(status))

    parsed = client.get_status(123)

    assert isinstance(parsed, SendStatus)
    assert parsed == SendStatus(log_id=123, status=status, created_at="2026-10-16T10:00:00Z")
    assert parsed.is_terminal is terminal
    assert parsed.succeeded is succeeded
    assert service.requests[0]["method"] == "GET"
    assert service.requests[0]["path"] == "/api/v1/send/123"


def test_get_status_parses_optional_fields(client: Client, service: MockService) -> None:
    service.queued(
        payload=send_status_payload(
            "failed",
            duration_ms=310,
            failure_reason="smtp_550",
            message_id="<1@x>",
            smtp_response="550 rejected",
        )
    )

    parsed = client.get_status(123)

    assert parsed.duration_ms == 310
    assert parsed.failure_reason == "smtp_550"
    assert parsed.message_id == "<1@x>"
    assert parsed.smtp_response == "550 rejected"


# ---------------------------------------------------------------------- wait


def test_wait_polls_until_terminal(client: Client, service: MockService) -> None:
    service.queued(payload=send_status_payload("sending"))
    service.queued(payload=send_status_payload("success"))

    final = client.wait(123, interval=0.01)

    assert final.status == "success"
    assert final.is_terminal is True
    assert service.count("/api/v1/send/123") == 2
    assert [request["method"] for request in service.requests] == ["GET", "GET"]


def test_wait_sleeps_out_retry_after(client: Client, service: MockService) -> None:
    service.error(429, "RATE_LIMITED", "Slow down.", headers={"Retry-After": "1"})
    service.queued(payload=send_status_payload("success"))

    started = time.monotonic()
    final = client.wait(123, interval=0.01)
    elapsed = time.monotonic() - started

    assert final.status == "success"
    assert elapsed >= 0.9
    assert service.count("/api/v1/send/123") == 2


def test_wait_times_out(client: Client, service: MockService) -> None:
    service.route("GET", "/api/v1/send/1", payload=send_status_payload("sending", log_id=1))

    with pytest.raises(PollTimeoutError) as excinfo:
        client.wait(1, timeout=0.05, interval=0.01)

    assert excinfo.value.log_id == 1
    assert excinfo.value.last_status == "sending"
    assert service.count("/api/v1/send/1") >= 1


# --------------------------------------------------------------------- reads


def test_me_parses_every_limits_field(client: Client, service: MockService) -> None:
    service.queued(payload=dict(LIMITS_PAYLOAD))

    limits = client.me()

    assert limits == Limits(**LIMITS_PAYLOAD)
    assert service.requests[0]["method"] == "GET"
    assert service.requests[0]["path"] == "/api/v1/me"


def test_emails_returns_strings(client: Client, service: MockService) -> None:
    service.queued(payload=["a@b.c"])

    assert client.emails() == ["a@b.c"]
    assert service.requests[0]["path"] == "/api/v1/emails"


def test_logs_sends_only_provided_filters(client: Client, service: MockService) -> None:
    service.queued(payload=dict(PAGE_PAYLOAD))

    page = client.logs(page=2, page_size=5, status="success", order="asc")

    request = service.requests[0]
    assert request["path"] == "/api/v1/logs"
    assert request["query"] == {
        "page": ["2"],
        "page_size": ["5"],
        "status": ["success"],
        "order": ["asc"],
    }
    assert page == Page(
        items=[
            SendLog(
                id=11,
                status="success",
                created_at="2026-10-16T10:00:00Z",
                api_key_id=4,
                client_ip="127.0.0.1",
                duration_ms=120,
                failure_reason=None,
                message_size_bytes=42,
                recipient="a@b.c",
                smtp_response="250 OK",
                subject="Deploy done",
            )
        ],
        total=1,
        page=2,
        page_size=5,
        pages=1,
    )


def test_logs_defaults_and_optional_filters(client: Client, service: MockService) -> None:
    service.queued(payload=dict(PAGE_PAYLOAD))

    client.logs()

    assert service.requests[0]["query"] == {
        "page": ["1"],
        "page_size": ["20"],
        "order": ["desc"],
    }

    service.queued(payload=dict(PAGE_PAYLOAD))
    client.logs(reason="smtp_550", api_key_id=4)

    assert service.requests[1]["query"] == {
        "page": ["1"],
        "page_size": ["20"],
        "order": ["desc"],
        "reason": ["smtp_550"],
        "api_key_id": ["4"],
    }


def test_stats_overview_sends_range_and_parses_nested(client: Client, service: MockService) -> None:
    service.queued(payload=dict(OVERVIEW_PAYLOAD))

    overview = client.stats_overview("30d")

    request = service.requests[0]
    assert request["path"] == "/api/v1/stats/overview"
    assert request["query"] == {"range": ["30d"]}
    assert overview.range == "30d"
    assert overview.bucket == "day"
    assert overview.totals.attempted == 10
    assert overview.totals.success_rate == 0.8
    assert overview.today.success == 2
    assert overview.today.reset_at == "2026-10-17T00:00:00Z"
    assert overview.series[0].bucket_start == "2026-10-15T00:00:00Z"
    assert overview.series[0].success == 4
    assert overview.failure_reasons[0].reason == "smtp_550"
    assert overview.failure_reasons[0].count == 1


# ---------------------------------------------------------- local validation


@pytest.mark.parametrize(
    "type,title,kwargs",
    [
        ("email", "T", {"body": "B", "html": "<b>x</b>"}),
        ("email", "T", {}),
        ("sms", "T", {"body": "B"}),
        ("ntfy", "T", {"html": "<b>x</b>"}),
        ("email", "T\nline", {"body": "B"}),
        ("email", "x" * 201, {"body": "B"}),
    ],
)
def test_send_validation_rejects_locally(
    client: Client, service: MockService, type: str, title: str, kwargs: dict
) -> None:
    with pytest.raises(ValueError):
        client.send(type, title, **kwargs)

    assert service.requests == []


@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.logs(page_size=0),
        lambda c: c.logs(page_size=101),
        lambda c: c.logs(status="bogus"),
        lambda c: c.logs(order="up"),
        lambda c: c.stats_overview("1d"),
        lambda c: c.get_status(0),
        lambda c: c.wait(1, interval=0),
    ],
    ids=[
        "logs-page-size-0",
        "logs-page-size-101",
        "logs-bad-status",
        "logs-bad-order",
        "stats-bad-range",
        "get-status-zero",
        "wait-zero-interval",
    ],
)
def test_read_validation_rejects_locally(client: Client, service: MockService, call) -> None:
    with pytest.raises(ValueError):
        call(client)

    assert service.requests == []


# -------------------------------------------------------------- configuration


def test_missing_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PORTCLOUD_NOTIFY_API_KEY", raising=False)

    with pytest.raises(ConfigurationError):
        Client()


def test_api_key_with_whitespace() -> None:
    with pytest.raises(ConfigurationError):
        Client(api_key="pck_ a")


def test_base_url_with_path_rejected() -> None:
    with pytest.raises(ConfigurationError):
        Client(api_key=API_KEY, base_url="https://host/api/v1")


def test_base_url_remote_http_rejected() -> None:
    with pytest.raises(ConfigurationError):
        Client(api_key=API_KEY, base_url="http://example.com")


def test_base_url_loopback_http_accepted() -> None:
    client = Client(api_key=API_KEY, base_url="http://127.0.0.1:8000")

    assert client.base_url == "http://127.0.0.1:8000"


def test_base_url_credentials_rejected() -> None:
    with pytest.raises(ConfigurationError):
        Client(api_key=API_KEY, base_url="https://user:pw@host")


def test_env_base_url_is_honored(monkeypatch: pytest.MonkeyPatch, service: MockService) -> None:
    monkeypatch.setenv("PORTCLOUD_NOTIFY_BASE_URL", service.url)

    client = Client(api_key=API_KEY)

    assert client.base_url == service.url


def test_empty_env_base_url_falls_back_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORTCLOUD_NOTIFY_BASE_URL", "")

    client = Client(api_key=API_KEY)

    assert client.base_url == DEFAULT_BASE_URL == "https://notify.portcloud.online"


def test_env_key_is_honored(monkeypatch: pytest.MonkeyPatch, service: MockService) -> None:
    monkeypatch.setenv("PORTCLOUD_NOTIFY_API_KEY", API_KEY)
    monkeypatch.setenv("PORTCLOUD_NOTIFY_BASE_URL", service.url)
    service.queued(payload=dict(LIMITS_PAYLOAD))

    client = Client()

    assert client.me() == Limits(**LIMITS_PAYLOAD)


def test_env_disabled_blocks_sending(monkeypatch: pytest.MonkeyPatch, service: MockService) -> None:
    monkeypatch.setenv("PORTCLOUD_NOTIFY_ENABLED", "0")
    client = Client(api_key=API_KEY, base_url=service.url)

    assert client.enabled is False
    with pytest.raises(NotificationsDisabledError):
        client.send("email", "T", body="B")
    with pytest.raises(NotificationsDisabledError):
        client.send_preset("T", "B")
    assert service.requests == []

    service.queued(payload=dict(LIMITS_PAYLOAD))
    assert client.me() == Limits(**LIMITS_PAYLOAD)
    assert service.count("/api/v1/me") == 1


def test_enabled_false_blocks_sending(service: MockService) -> None:
    client = Client(api_key=API_KEY, base_url=service.url, enabled=False)

    assert client.enabled is False
    with pytest.raises(NotificationsDisabledError):
        client.send("email", "T", body="B")
    with pytest.raises(NotificationsDisabledError):
        client.send_preset("T", "B")
    assert service.requests == []

    service.queued(payload=dict(LIMITS_PAYLOAD))
    assert client.me() == Limits(**LIMITS_PAYLOAD)


def test_repr_hides_the_api_key(client: Client) -> None:
    text = repr(client)

    assert API_KEY not in text
    assert "***" in text
    assert client.base_url in text
