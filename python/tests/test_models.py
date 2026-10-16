"""Model parsing: unknown fields are ignored, invalid input raises ``ValueError``."""

from __future__ import annotations

import pytest

from portcloud_notify import (
    TERMINAL_STATUSES,
    FailureReasonCount,
    Limits,
    Overview,
    Page,
    PresetSendAccepted,
    SendAccepted,
    SendLog,
    SendStatus,
    SeriesPoint,
    TodayStats,
    Totals,
)

FULL_STATUS = {
    "log_id": 5,
    "status": "success",
    "created_at": "2026-10-16T10:00:00Z",
    "duration_ms": 100,
    "failure_reason": None,
    "message_id": "<1@x>",
    "smtp_response": "250 OK",
}


def test_send_status_ignores_unknown_fields() -> None:
    parsed = SendStatus.from_dict(dict(FULL_STATUS, unknown_field="ignored", channel="email"))

    assert parsed == SendStatus(**FULL_STATUS)


def test_send_status_requires_its_core_fields() -> None:
    with pytest.raises(ValueError):
        SendStatus.from_dict({"log_id": 1, "status": "queued"})
    with pytest.raises(ValueError):
        SendStatus.from_dict("not an object")


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
def test_send_status_properties(status: str, terminal: bool, succeeded: bool) -> None:
    parsed = SendStatus.from_dict(
        {"log_id": 1, "status": status, "created_at": "2026-10-16T10:00:00Z"}
    )

    assert parsed.is_terminal is terminal
    assert parsed.succeeded is succeeded
    assert (status in TERMINAL_STATUSES) is terminal


def test_send_accepted_and_preset_accepted() -> None:
    assert SendAccepted.from_dict({"log_id": 1, "status": "queued"}) == SendAccepted(
        log_id=1, status="queued"
    )
    assert SendAccepted.from_dict({"log_id": 1}) == SendAccepted(log_id=1, status="queued")
    assert PresetSendAccepted.from_dict(
        {"log_id": 1, "preset_id": 2, "status": "queued", "extra": 3}
    ) == PresetSendAccepted(log_id=1, preset_id=2, status="queued")
    with pytest.raises(ValueError):
        PresetSendAccepted.from_dict({"log_id": 1})


def test_limits_parses_and_ignores_unknown() -> None:
    payload = {
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
        "unknown": "ignored",
    }

    parsed = Limits.from_dict(payload)

    assert parsed.credits_per_target == {"email": 1, "ntfy": 1}
    assert parsed.is_admin is False
    assert parsed.daily_reset_at == "2026-10-17T00:00:00Z"


def test_page_ignores_unknown_page_and_item_fields() -> None:
    payload = {
        "items": [
            {"id": 1, "status": "failed", "created_at": "2026-10-16T10:00:00Z", "extra": "x"},
            {"id": 2, "status": "success", "created_at": "2026-10-16T10:01:00Z"},
        ],
        "total": 2,
        "page": 1,
        "page_size": 20,
        "pages": 1,
        "unknown": "ignored",
    }

    page = Page.from_dict(payload)

    assert page == Page(
        items=[
            SendLog(id=1, status="failed", created_at="2026-10-16T10:00:00Z"),
            SendLog(id=2, status="success", created_at="2026-10-16T10:01:00Z"),
        ],
        total=2,
        page=1,
        page_size=20,
        pages=1,
    )


def test_page_defaults_items_to_empty() -> None:
    page = Page.from_dict({"total": 0, "page": 1, "page_size": 20, "pages": 0})

    assert page.items == []


@pytest.mark.parametrize(
    "payload",
    [
        {"total": 1, "page": 1, "page_size": 20},  # missing "pages"
        {"page": 1, "page_size": 20, "pages": 1},  # missing "total"
        {"items": "nope", "total": 1, "page": 1, "page_size": 20, "pages": 1},
        {"items": [{}], "total": 1, "page": 1, "page_size": 20, "pages": 1},
    ],
)
def test_page_rejects_invalid_input(payload: dict) -> None:
    with pytest.raises(ValueError):
        Page.from_dict(payload)


@pytest.mark.parametrize("payload", [None, [], "nope", 5])
def test_page_rejects_non_object_input(payload: object) -> None:
    with pytest.raises(ValueError):
        Page.from_dict(payload)


def test_overview_parses_nested_models_and_ignores_unknown() -> None:
    payload = {
        "range": "7d",
        "bucket": "hour",
        "totals": {
            "attempted": 3,
            "success": 2,
            "failed": 1,
            "rejected": 0,
            "success_rate": 0.6667,
            "unknown": "ignored",
        },
        "series": [
            {
                "bucket_start": "2026-10-16T00:00:00Z",
                "success": 2,
                "failed": 1,
                "rejected": 0,
                "unknown": "ignored",
            }
        ],
        "failure_reasons": [{"reason": "smtp_550", "count": 1, "unknown": "ignored"}],
        "today": {
            "attempted": 1,
            "success": 1,
            "failed": 0,
            "rejected": 0,
            "success_rate": 1.0,
        },
        "unknown": "ignored",
    }

    overview = Overview.from_dict(payload)

    assert overview == Overview(
        range="7d",
        bucket="hour",
        totals=Totals(attempted=3, success=2, failed=1, rejected=0, success_rate=0.6667),
        series=[SeriesPoint(bucket_start="2026-10-16T00:00:00Z", success=2, failed=1, rejected=0)],
        failure_reasons=[FailureReasonCount(reason="smtp_550", count=1)],
        today=TodayStats(
            attempted=1, success=1, failed=0, rejected=0, success_rate=1.0, reset_at=None
        ),
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"range": "7d", "bucket": "hour", "series": [], "failure_reasons": [], "today": {}},
        {"bucket": "hour", "totals": {}, "series": [], "failure_reasons": [], "today": {}},
        {"range": "7d", "bucket": "hour", "totals": {}, "failure_reasons": [], "today": {}},
        {"range": "7d", "bucket": "hour", "totals": {}, "series": [], "today": {}},
        {
            "range": "7d",
            "bucket": "hour",
            "totals": {},
            "series": [],
            "failure_reasons": [],
            "today": {},
        },
        {
            "range": "7d",
            "bucket": "hour",
            "totals": {},
            "series": "nope",
            "failure_reasons": [],
            "today": {},
        },
    ],
)
def test_overview_rejects_invalid_input(payload: dict) -> None:
    with pytest.raises(ValueError):
        Overview.from_dict(payload)


@pytest.mark.parametrize("payload", [None, [], "nope", 5])
def test_overview_rejects_non_object_input(payload: object) -> None:
    with pytest.raises(ValueError):
        Overview.from_dict(payload)
