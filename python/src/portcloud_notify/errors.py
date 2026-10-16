"""Exceptions raised by the Portcloud Notify SDK.

Every failure is a :class:`PortcloudNotifyError`. Callers can branch on the
exception type, on ``APIError.code`` (the stable service error code, e.g.
``NO_PRESET``), or on ``APIError.http_status``; the service documents that the
machine-readable ``code`` is the contract and the human ``message`` is not.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Optional

__all__ = [
    "APIError",
    "AcceptanceUnknownError",
    "AuthenticationError",
    "AuthorizationError",
    "ConfigurationError",
    "NotFoundError",
    "NotificationsDisabledError",
    "PayloadTooLargeError",
    "PollTimeoutError",
    "PortcloudNotifyError",
    "RateLimitError",
    "ServerError",
    "TransportError",
    "ValidationError",
    "error_from_response",
]

_RETRY_AFTER_PATTERN = re.compile(r"^\d{1,9}$")
_RESET_AT_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")


class PortcloudNotifyError(Exception):
    """Base class for every error raised by this SDK."""


class ConfigurationError(PortcloudNotifyError):
    """Local configuration is missing or invalid. No request was sent."""


class NotificationsDisabledError(PortcloudNotifyError):
    """Sending is disabled by ``PORTCLOUD_NOTIFY_ENABLED=0`` or ``enabled=False``."""


class TransportError(PortcloudNotifyError):
    """The request produced no usable response.

    Attributes:
        http_status: HTTP status when a response was received but unusable.
        outcome_unknown: ``True`` when the request was a send POST that the
            service may still have queued (timeout, dropped connection, a 5xx or
            408 answer, a redirect, or an unparsable success body). Never resend
            automatically while this is ``True``.
    """

    def __init__(
        self,
        message: str,
        *,
        http_status: Optional[int] = None,
        outcome_unknown: bool = False,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.outcome_unknown = outcome_unknown


class AcceptanceUnknownError(TransportError):
    """A send POST may have been queued; check the logs before resending.

    ``code`` and ``details`` carry the service error envelope when one was
    received (for example a ``503 DEPENDENCY_UNAVAILABLE``).
    """

    def __init__(
        self,
        message: str,
        *,
        http_status: Optional[int] = None,
        code: Optional[str] = None,
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(message, http_status=http_status, outcome_unknown=True)
        self.code = code
        self.details = dict(details or {})


class PollTimeoutError(PortcloudNotifyError):
    """``Client.wait`` gave up before the delivery reached a terminal state."""

    def __init__(
        self,
        message: str,
        *,
        log_id: Optional[int] = None,
        last_status: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.log_id = log_id
        self.last_status = last_status


class APIError(PortcloudNotifyError):
    """The service answered with its documented ``{"error": {...}}`` envelope.

    Attributes:
        http_status: HTTP status code of the response.
        code: Stable machine-readable error code (``VALIDATION_ERROR``,
            ``NO_PRESET``, ``RATE_LIMITED``, ...). ``HTTP_<status>`` when the
            response carried no parsable envelope (for example a gateway error).
        message: Human-readable service message; not part of the stable contract.
        details: Envelope ``details`` object (may be empty).
        retry_after: Seconds to wait, from the ``Retry-After`` header or
            ``details.retry_after`` (429 responses).
        reset_at: ``details.reset_at`` ISO 8601 timestamp (credits or attempt
            exhaustion), when provided.
    """

    def __init__(
        self,
        http_status: int,
        code: str,
        message: str,
        *,
        details: Optional[Mapping[str, Any]] = None,
        retry_after: Optional[int] = None,
        reset_at: Optional[str] = None,
    ) -> None:
        super().__init__(f"{code} (HTTP {http_status}): {message}")
        self.http_status = http_status
        self.code = code
        self.message = message
        self.details = dict(details or {})
        self.retry_after = retry_after
        self.reset_at = reset_at


class ValidationError(APIError):
    """HTTP 400/422: the request was rejected before any delivery was queued."""


class AuthenticationError(APIError):
    """HTTP 401: API key missing, invalid, or expired."""


class AuthorizationError(APIError):
    """HTTP 403: account disabled or Star eligibility refusal."""


class NotFoundError(APIError):
    """HTTP 404: unknown ``log_id`` or a target not owned by the account."""


class PayloadTooLargeError(APIError):
    """HTTP 413: message or request body too large."""


class RateLimitError(APIError):
    """HTTP 429: rate, Message Credits, or daily attempt limit reached.

    Check ``retry_after`` and ``reset_at``.
    """


class ServerError(APIError):
    """HTTP 5xx: service-side failure. A send may have been queued."""


_ERROR_CLASS_BY_STATUS: dict[int, type] = {
    400: ValidationError,
    401: AuthenticationError,
    403: AuthorizationError,
    404: NotFoundError,
    413: PayloadTooLargeError,
    422: ValidationError,
    429: RateLimitError,
}


def error_from_response(
    http_status: int,
    payload: Any,
    headers: Optional[Mapping[str, str]] = None,
) -> APIError:
    """Build the mapped :class:`APIError` from an error response.

    Unknown fields and unparsable bodies degrade gracefully: the HTTP status is
    always reported, the envelope is used when it has the documented shape.
    """
    code: Optional[str] = None
    message: Optional[str] = None
    details: dict[str, Any] = {}
    if isinstance(payload, Mapping):
        envelope = payload.get("error")
        if isinstance(envelope, Mapping):
            raw_code = envelope.get("code")
            if isinstance(raw_code, str) and raw_code:
                code = raw_code
            raw_message = envelope.get("message")
            if isinstance(raw_message, str) and raw_message:
                message = raw_message
            raw_details = envelope.get("details")
            if isinstance(raw_details, Mapping):
                details = dict(raw_details)

    retry_after: Optional[int] = None
    if headers:
        header = headers.get("Retry-After")
        if header is None:
            header = headers.get("retry-after")
        if isinstance(header, str) and _RETRY_AFTER_PATTERN.match(header) and int(header) > 0:
            retry_after = int(header)
    if retry_after is None:
        candidate = details.get("retry_after")
        if isinstance(candidate, int) and not isinstance(candidate, bool) and candidate > 0:
            retry_after = candidate

    reset_at: Optional[str] = None
    candidate_reset = details.get("reset_at")
    if isinstance(candidate_reset, str) and _RESET_AT_PATTERN.match(candidate_reset):
        reset_at = candidate_reset

    resolved_code = code if code is not None else f"HTTP_{http_status}"
    resolved_message = message if message is not None else "The service returned an error response."

    if http_status >= 500:
        error_class: type = ServerError
    else:
        error_class = _ERROR_CLASS_BY_STATUS.get(http_status, APIError)
    return error_class(
        http_status,
        resolved_code,
        resolved_message,
        details=details,
        retry_after=retry_after,
        reset_at=reset_at,
    )
