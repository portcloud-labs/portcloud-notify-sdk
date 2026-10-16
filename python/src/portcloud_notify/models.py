"""Response models for the Portcloud Notify public API.

Plain frozen dataclasses — no third-party dependency, no validation framework.
Each model parses the documented JSON shape and ignores unknown fields so a
service that adds a field does not break existing callers. Timestamps stay ISO
8601 strings exactly as the service returned them.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any, Optional

__all__ = [
    "TERMINAL_STATUSES",
    "FailureReasonCount",
    "Limits",
    "Overview",
    "Page",
    "PresetSendAccepted",
    "SendAccepted",
    "SendLog",
    "SendStatus",
    "SeriesPoint",
    "TodayStats",
    "Totals",
]

#: Delivery states that end polling: the result will not change again.
TERMINAL_STATUSES = ("success", "failed", "rejected")


class _Model:
    """Base for JSON-parsed response models."""

    @classmethod
    def from_dict(cls, data: Any):
        if not isinstance(data, dict):
            raise ValueError(f"{cls.__name__} expects a JSON object.")
        kwargs = {field.name: data[field.name] for field in fields(cls) if field.name in data}
        try:
            return cls(**kwargs)
        except TypeError as exc:
            raise ValueError(f"Invalid {cls.__name__} response: {exc}") from exc


@dataclass(frozen=True)
class SendAccepted(_Model):
    """``POST /api/v1/send`` acceptance: queued, not delivered."""

    log_id: int
    status: str = "queued"


@dataclass(frozen=True)
class PresetSendAccepted(_Model):
    """``POST /api/v1/send-preset`` acceptance: one log for the whole chain."""

    log_id: int
    preset_id: int
    status: str = "queued"


@dataclass(frozen=True)
class SendStatus(_Model):
    """``GET /api/v1/send/{log_id}`` delivery state.

    ``success`` means the SMTP or ntfy service accepted the message, not that a
    human read it. ``failed`` does not always prove nothing was sent.
    """

    log_id: int
    status: str
    created_at: str
    duration_ms: Optional[int] = None
    failure_reason: Optional[str] = None
    message_id: Optional[str] = None
    smtp_response: Optional[str] = None

    @property
    def is_terminal(self) -> bool:
        """Whether the delivery reached a final state (stop polling)."""
        return self.status in TERMINAL_STATUSES

    @property
    def succeeded(self) -> bool:
        return self.status == "success"


@dataclass(frozen=True)
class Limits(_Model):
    """``GET /api/v1/me`` account snapshot and Message Credits."""

    daily_message_credits: int
    message_credits_used: int
    message_credits_reserved: int
    message_credits_remaining: int
    credits_per_email: int
    credits_per_ntfy: int
    credits_per_target: dict[str, int]
    daily_reset_at: str
    minute_attempt_limit: int
    daily_attempt_limit: int
    daily_attempt_used: int
    max_verified_emails: int
    max_ntfy_channels: int
    max_api_keys: int
    max_message_size_bytes: int
    is_admin: bool


@dataclass(frozen=True)
class SendLog(_Model):
    """One row of ``GET /api/v1/logs``."""

    id: int
    status: str
    created_at: str
    api_key_id: Optional[int] = None
    client_ip: Optional[str] = None
    duration_ms: Optional[int] = None
    failure_reason: Optional[str] = None
    message_size_bytes: Optional[int] = None
    recipient: Optional[str] = None
    smtp_response: Optional[str] = None
    subject: Optional[str] = None


@dataclass(frozen=True)
class Page(_Model):
    """Paginated ``GET /api/v1/logs`` result."""

    items: list[SendLog]
    total: int
    page: int
    page_size: int
    pages: int

    @classmethod
    def from_dict(cls, data: Any) -> Page:
        if not isinstance(data, dict):
            raise ValueError("Page expects a JSON object.")
        raw_items = data.get("items", [])
        if not isinstance(raw_items, list):
            raise ValueError("Page items must be a list.")
        try:
            return cls(
                items=[SendLog.from_dict(item) for item in raw_items],
                total=data["total"],
                page=data["page"],
                page_size=data["page_size"],
                pages=data["pages"],
            )
        except (KeyError, ValueError) as exc:
            raise ValueError(f"Invalid Page response: {exc}") from exc


@dataclass(frozen=True)
class SeriesPoint(_Model):
    """One statistics bucket."""

    bucket_start: str
    success: int
    failed: int
    rejected: int


@dataclass(frozen=True)
class TodayStats(_Model):
    """Today's counters from ``GET /api/v1/stats/overview``."""

    attempted: int
    success: int
    failed: int
    rejected: int
    success_rate: float
    reset_at: Optional[str] = None


@dataclass(frozen=True)
class Totals(_Model):
    """Totals for the requested statistics range."""

    attempted: int
    success: int
    failed: int
    rejected: int
    success_rate: float


@dataclass(frozen=True)
class FailureReasonCount(_Model):
    """Failure-reason histogram entry."""

    reason: str
    count: int


@dataclass(frozen=True)
class Overview(_Model):
    """``GET /api/v1/stats/overview`` account statistics."""

    range: str
    bucket: str
    totals: Totals
    series: list[SeriesPoint]
    failure_reasons: list[FailureReasonCount]
    today: TodayStats

    @classmethod
    def from_dict(cls, data: Any) -> Overview:
        if not isinstance(data, dict):
            raise ValueError("Overview expects a JSON object.")
        raw_series = data.get("series", [])
        raw_reasons = data.get("failure_reasons", [])
        if not isinstance(raw_series, list) or not isinstance(raw_reasons, list):
            raise ValueError("Overview series and failure_reasons must be lists.")
        try:
            return cls(
                range=data["range"],
                bucket=data["bucket"],
                totals=Totals.from_dict(data["totals"]),
                series=[SeriesPoint.from_dict(point) for point in raw_series],
                failure_reasons=[FailureReasonCount.from_dict(item) for item in raw_reasons],
                today=TodayStats.from_dict(data["today"]),
            )
        except (KeyError, ValueError) as exc:
            raise ValueError(f"Invalid Overview response: {exc}") from exc
