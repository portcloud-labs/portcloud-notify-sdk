"""HTTP client for the Portcloud Notify public API.

Synchronous, standard library only. Delivery is asynchronous: ``send`` and
``send_preset`` return an accepted ``log_id`` before delivery happens, so use
:meth:`Client.get_status` or :meth:`Client.wait` for the real result.

The client never retries a POST: the API has no idempotency key, so a lost
response may already have queued a notification. Failures where that is
possible raise :class:`~portcloud_notify.errors.AcceptanceUnknownError`.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any, Callable, Optional, TypeVar

from . import models
from ._version import __version__
from .errors import (
    AcceptanceUnknownError,
    ConfigurationError,
    NotificationsDisabledError,
    PollTimeoutError,
    PortcloudNotifyError,
    RateLimitError,
    TransportError,
    error_from_response,
)

__all__ = ["DEFAULT_BASE_URL", "DEFAULT_TIMEOUT", "Client", "normalize_base_url"]

#: Production site. Override with ``base_url`` or ``PORTCLOUD_NOTIFY_BASE_URL``.
DEFAULT_BASE_URL = "https://notify.portcloud.online"

#: Per-request timeout in seconds.
DEFAULT_TIMEOUT = 30.0

#: Default poll interval for :meth:`Client.wait`, matching the documented guidance.
DEFAULT_POLL_INTERVAL = 2.0

DEFAULT_WAIT_TIMEOUT = 60.0

USER_AGENT = f"portcloud-notify-python/{__version__}"

CHANNEL_TYPES = ("email", "ntfy")
LOG_STATUSES = ("queued", "sending", "success", "failed", "rejected")
STATS_RANGES = ("7d", "14d", "30d", "60d", "90d")
LOG_ORDERS = ("asc", "desc")

TITLE_MAX_LENGTH = 200
BODY_MAX_LENGTH = 1_048_576
TARGET_MAX_LENGTH = 254
PAGE_SIZE_MAX = 100

_ORIGIN_PATTERN = re.compile(r"^https?://[^/?#\s\\]+/?$", re.IGNORECASE)
_INVALID_KEY_PATTERN = re.compile(r"[\s\u0000-\u001f\u007f]")
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)

T = TypeVar("T")


class _RedirectRefusedError(Exception):
    """Internal marker: the service answered a redirect, which is never followed."""

    def __init__(self, url: str, status: int) -> None:
        super().__init__("redirect refused")
        self.url = url
        self.status = status


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects instead of replaying credentials to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        raise _RedirectRefusedError(newurl, code)


def _is_loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host in ("localhost", "::1"):
        return True
    return bool(re.match(r"^127(?:\.\d{1,3}){3}$", host))


def normalize_base_url(value: Optional[str] = None) -> str:
    """Validate and normalize a site origin.

    Returns the origin (scheme and authority only). HTTPS is required unless the
    caller explicitly configured a loopback HTTP address for local development.
    Credentials, paths, queries, and fragments are rejected.
    """
    if value is not None and not isinstance(value, str):
        raise ConfigurationError("base_url must be a string.")
    explicit = bool(value)
    raw = value if explicit else DEFAULT_BASE_URL
    assert raw is not None
    if not _ORIGIN_PATTERN.match(raw):
        raise ConfigurationError(
            "base_url must be a site origin without a path, query, or fragment."
        )
    try:
        parts = urllib.parse.urlsplit(raw)
    except ValueError as exc:
        raise ConfigurationError(f"base_url is invalid: {exc}") from exc
    if parts.username or parts.password or "@" in raw:
        raise ConfigurationError("base_url must not contain credentials.")
    if parts.scheme != "https" and not (
        explicit and parts.scheme == "http" and _is_loopback(parts.hostname)
    ):
        raise ConfigurationError(
            "base_url requires HTTPS, except explicitly configured loopback HTTP."
        )
    return f"{parts.scheme}://{parts.netloc}"


def _require_positive_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("log_id must be a positive integer.")
    return value


def _parse_acceptance(data: Any) -> models.SendAccepted:
    if not isinstance(data, dict):
        raise ValueError("acceptance response must be a JSON object.")
    log_id = _require_positive_int(data.get("log_id"))
    status = data.get("status", "queued")
    if status != "queued":
        raise ValueError(f"unexpected acceptance status {status!r}.")
    return models.SendAccepted(log_id=log_id, status=status)


def _parse_preset_acceptance(data: Any) -> models.PresetSendAccepted:
    accepted = _parse_acceptance(data)
    preset_id = _require_positive_int(data.get("preset_id"))
    return models.PresetSendAccepted(
        log_id=accepted.log_id, preset_id=preset_id, status=accepted.status
    )


class Client:
    """Client for the Portcloud Notify public API (``/api/v1/*``).

    Args:
        api_key: ``pck_...`` API key. Defaults to ``PORTCLOUD_NOTIFY_API_KEY``.
        base_url: Site origin. Defaults to ``PORTCLOUD_NOTIFY_BASE_URL`` and then
            to the production site.
        timeout: Per-request timeout in seconds.
        enabled: Set to ``False`` to refuse sending. Sending is also refused when
            ``PORTCLOUD_NOTIFY_ENABLED=0``, which cannot be overridden here.
        user_agent: Override the ``User-Agent`` header.

    Only the API key is configured locally: channels and the send preset are
    owned by the account and managed in the console.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        enabled: bool = True,
        user_agent: Optional[str] = None,
    ) -> None:
        resolved_key = (
            api_key if api_key is not None else os.environ.get("PORTCLOUD_NOTIFY_API_KEY")
        )
        if not isinstance(resolved_key, str) or not resolved_key.strip():
            raise ConfigurationError(
                "An API key is required: pass api_key= or set PORTCLOUD_NOTIFY_API_KEY."
            )
        if _INVALID_KEY_PATTERN.search(resolved_key):
            raise ConfigurationError(
                "The API key must not contain whitespace or control characters."
            )
        self.api_key = resolved_key
        configured_base = (
            base_url if base_url is not None else os.environ.get("PORTCLOUD_NOTIFY_BASE_URL")
        )
        self.base_url = normalize_base_url(configured_base)
        self.timeout = float(timeout)
        self.user_agent = user_agent or USER_AGENT
        self.enabled = bool(enabled) and os.environ.get("PORTCLOUD_NOTIFY_ENABLED") != "0"
        self._opener = urllib.request.build_opener(_NoRedirectHandler())

    def __repr__(self) -> str:
        return f"Client(base_url={self.base_url!r}, api_key='***', enabled={self.enabled!r})"

    # ------------------------------------------------------------------ send

    def send(
        self,
        type: str,
        title: str,
        *,
        body: Optional[str] = None,
        html: Optional[str] = None,
        to: Optional[str] = None,
    ) -> models.SendAccepted:
        """Queue a notification (``POST /api/v1/send``).

        Args:
            type: ``"email"`` or ``"ntfy"``.
            title: 1-200 characters, no line breaks.
            body: Plain-text content; required for ntfy, one of body/html for email.
            html: Custom email HTML sent verbatim. Email only.
            to: One destination the account already added — a verified email
                address, or the full canonical ntfy topic. Omit to deliver the
                saved default channels matching ``type``.

        Returns:
            Acceptance with the ``log_id`` of the first target; poll it for the
            real result.
        """
        self._require_enabled()
        payload = self._send_payload(type, title, body, html, to)
        return self._request(
            "POST",
            "/api/v1/send",
            json_body=payload,
            send=True,
            parse=_parse_acceptance,
        )

    def send_preset(self, title: str, body: str) -> models.PresetSendAccepted:
        """Queue the account's preset chain (``POST /api/v1/send-preset``).

        The account's single preset owns the ordered channel chain, so only
        content is supplied. Returns one ``log_id`` for the whole chain.
        """
        self._require_enabled()
        self._check_title(title)
        self._check_body(body, "body")
        return self._request(
            "POST",
            "/api/v1/send-preset",
            json_body={"title": title, "body": body},
            send=True,
            parse=_parse_preset_acceptance,
        )

    def get_status(self, log_id: int) -> models.SendStatus:
        """Query one delivery (``GET /api/v1/send/{log_id}``)."""
        return self._request(
            "GET",
            f"/api/v1/send/{_require_positive_int(log_id)}",
            parse=models.SendStatus.from_dict,
        )

    def wait(
        self,
        log_id: int,
        *,
        timeout: float = DEFAULT_WAIT_TIMEOUT,
        interval: float = DEFAULT_POLL_INTERVAL,
    ) -> models.SendStatus:
        """Poll until the delivery reaches a terminal state.

        Waits out ``Retry-After`` on a 429 and re-queries the same id. Raises
        :class:`~portcloud_notify.errors.PollTimeoutError` when ``timeout``
        seconds elapse first; pass ``timeout=None`` to poll indefinitely.
        """
        log_id = _require_positive_int(log_id)
        if interval <= 0:
            raise ValueError("interval must be greater than zero.")
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        last: Optional[models.SendStatus] = None
        while True:
            try:
                last = self.get_status(log_id)
            except RateLimitError as exc:
                self._sleep_until(exc.retry_after or interval, deadline, log_id, last)
                continue
            if last.is_terminal:
                return last
            self._sleep_until(interval, deadline, log_id, last)

    # ------------------------------------------------------------------ reads

    def me(self) -> models.Limits:
        """Account snapshot and Message Credits (``GET /api/v1/me``)."""
        return self._request("GET", "/api/v1/me", parse=models.Limits.from_dict)

    def emails(self) -> list[str]:
        """Verified recipient addresses (``GET /api/v1/emails``)."""
        return self._request("GET", "/api/v1/emails", parse=self._parse_emails)

    def logs(
        self,
        *,
        page: int = 1,
        page_size: int = 20,
        status: Optional[str] = None,
        reason: Optional[str] = None,
        api_key_id: Optional[int] = None,
        order: str = "desc",
    ) -> models.Page:
        """Query send logs (``GET /api/v1/logs``)."""
        if not isinstance(page, int) or isinstance(page, bool) or page < 1:
            raise ValueError("page must be an integer >= 1.")
        if (
            not isinstance(page_size, int)
            or isinstance(page_size, bool)
            or not 1 <= page_size <= PAGE_SIZE_MAX
        ):
            raise ValueError("page_size must be an integer between 1 and 100.")
        if status is not None and status not in LOG_STATUSES:
            raise ValueError("status must be one of {}.".format(", ".join(LOG_STATUSES)))
        if order not in LOG_ORDERS:
            raise ValueError("order must be 'asc' or 'desc'.")
        if api_key_id is not None and (
            not isinstance(api_key_id, int) or isinstance(api_key_id, bool)
        ):
            raise ValueError("api_key_id must be an integer.")
        params: dict[str, Any] = {"page": page, "page_size": page_size, "order": order}
        if status is not None:
            params["status"] = status
        if reason is not None:
            params["reason"] = reason
        if api_key_id is not None:
            params["api_key_id"] = api_key_id
        return self._request("GET", "/api/v1/logs", params=params, parse=models.Page.from_dict)

    def stats_overview(self, range: str = "7d") -> models.Overview:
        """Account statistics (``GET /api/v1/stats/overview``)."""
        if range not in STATS_RANGES:
            raise ValueError("range must be one of {}.".format(", ".join(STATS_RANGES)))
        return self._request(
            "GET",
            "/api/v1/stats/overview",
            params={"range": range},
            parse=models.Overview.from_dict,
        )

    # ------------------------------------------------------------- internals

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise NotificationsDisabledError(
                "Sending is disabled (PORTCLOUD_NOTIFY_ENABLED=0 or enabled=False)."
            )

    @staticmethod
    def _check_title(title: Any) -> None:
        if not isinstance(title, str) or not title.strip():
            raise ValueError("title must be a nonempty string.")
        if len(title) > TITLE_MAX_LENGTH:
            raise ValueError(f"title must be at most {TITLE_MAX_LENGTH} characters.")
        if "\n" in title or "\r" in title:
            raise ValueError("title must be a single line without line breaks.")

    @staticmethod
    def _check_body(value: Any, name: str) -> None:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a nonempty string.")
        if len(value) > BODY_MAX_LENGTH:
            raise ValueError(f"{name} must be at most {BODY_MAX_LENGTH} characters.")

    def _send_payload(
        self,
        type: Any,
        title: Any,
        body: Optional[str],
        html: Optional[str],
        to: Optional[str],
    ) -> dict[str, Any]:
        if type not in CHANNEL_TYPES:
            raise ValueError("type must be one of {}.".format(", ".join(CHANNEL_TYPES)))
        self._check_title(title)
        if body is not None:
            self._check_body(body, "body")
        if html is not None:
            self._check_body(html, "html")
        if (body is None) == (html is None):
            raise ValueError("supply exactly one of body or html.")
        if html is not None and type != "email":
            raise ValueError("html is only supported for type='email'.")
        if to is not None:
            if not isinstance(to, str) or not to.strip():
                raise ValueError("to must be a nonempty string.")
            if len(to) > TARGET_MAX_LENGTH:
                raise ValueError(f"to must be at most {TARGET_MAX_LENGTH} characters.")
        payload: dict[str, Any] = {"type": type, "title": title}
        if body is not None:
            payload["body"] = body
        if html is not None:
            payload["html"] = html
        if to is not None:
            payload["to"] = to
        return payload

    @staticmethod
    def _parse_emails(data: Any) -> list[str]:
        if not isinstance(data, list) or not all(isinstance(item, str) for item in data):
            raise ValueError("emails response must be a JSON array of strings.")
        return list(data)

    def _sleep_until(
        self,
        seconds: float,
        deadline: Optional[float],
        log_id: int,
        last: Optional[models.SendStatus],
    ) -> None:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PollTimeoutError(
                    f"Delivery {log_id} did not reach a terminal state in time.",
                    log_id=log_id,
                    last_status=last.status if last is not None else None,
                )
            seconds = min(seconds, remaining)
        time.sleep(seconds)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Mapping[str, Any]] = None,
        send: bool = False,
        parse: Optional[Callable[[Any], T]] = None,
    ) -> Any:
        url = self.base_url + path
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        data = None
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read()
        except _RedirectRefusedError as exc:
            raise self._transport_error(
                f"The service answered HTTP {exc.status} with a redirect; it is never followed.",
                http_status=exc.status,
                send=send,
            ) from exc
        except urllib.error.HTTPError as exc:
            try:
                status = exc.code
                error_headers = exc.headers
                raw = exc.read()
            finally:
                exc.close()
            raise self._http_error(status, raw, error_headers, send=send) from exc
        except (OSError, http.client.HTTPException) as exc:
            raise self._transport_error(
                f"Request to {self.base_url} failed: {exc}", send=send
            ) from exc

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise self._transport_error(
                "The service returned a response that is not valid JSON.", send=send
            ) from exc
        if parse is None:
            return payload
        try:
            return parse(payload)
        except ValueError as exc:
            if send:
                raise AcceptanceUnknownError(
                    f"The service acceptance response was invalid ({exc}); do not resend "
                    "automatically."
                ) from exc
            raise self._transport_error(
                "The service returned an unexpected response body.", send=send
            ) from exc

    def _http_error(
        self,
        status: int,
        raw: bytes,
        headers: Mapping[str, str],
        *,
        send: bool,
    ) -> PortcloudNotifyError:
        try:
            payload: Any = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            payload = None
        error = error_from_response(status, payload, headers)
        if send and (status == 408 or status >= 500):
            # The service answered, but the notification may already be queued.
            return AcceptanceUnknownError(
                f"The send outcome is unknown ({error}); do not resend automatically.",
                http_status=status,
                code=error.code,
                details=error.details,
            )
        return error

    def _transport_error(
        self, message: str, *, http_status: Optional[int] = None, send: bool
    ) -> PortcloudNotifyError:
        if send:
            return AcceptanceUnknownError(
                f"{message} The send outcome is unknown; do not resend automatically.",
                http_status=http_status,
            )
        return TransportError(message, http_status=http_status)
