"""Error mapping, unknown send outcomes, and transport failures."""

from __future__ import annotations

import pytest

from conftest import API_KEY, MockService
from portcloud_notify import (
    AcceptanceUnknownError,
    APIError,
    AuthenticationError,
    AuthorizationError,
    Client,
    ConfigurationError,
    NotFoundError,
    NotificationsDisabledError,
    PayloadTooLargeError,
    PollTimeoutError,
    PortcloudNotifyError,
    RateLimitError,
    ServerError,
    TransportError,
    ValidationError,
)

ERROR_CASES = [
    {
        "id": "400-no-default-channel",
        "status": 400,
        "code": "NO_DEFAULT_CHANNEL",
        "expected": ValidationError,
    },
    {
        "id": "422-validation-error",
        "status": 422,
        "code": "VALIDATION_ERROR",
        "expected": ValidationError,
    },
    {
        "id": "401-invalid-api-key",
        "status": 401,
        "code": "INVALID_API_KEY",
        "expected": AuthenticationError,
    },
    {
        "id": "403-star-required",
        "status": 403,
        "code": "STAR_REQUIRED",
        "expected": AuthorizationError,
    },
    {
        "id": "404-not-found",
        "status": 404,
        "code": "NOT_FOUND",
        "expected": NotFoundError,
    },
    {
        "id": "413-payload-too-large",
        "status": 413,
        "code": "PAYLOAD_TOO_LARGE",
        "expected": PayloadTooLargeError,
    },
    {
        "id": "429-rate-limited-retry-after",
        "status": 429,
        "code": "RATE_LIMITED",
        "expected": RateLimitError,
        "headers": {"Retry-After": "30"},
        "retry_after": 30,
    },
    {
        "id": "429-message-credits-exhausted",
        "status": 429,
        "code": "MESSAGE_CREDITS_EXHAUSTED",
        "expected": RateLimitError,
        "details": {"reset_at": "2026-10-17T00:00:00Z", "remaining": 0},
        "reset_at": "2026-10-17T00:00:00Z",
    },
    {
        "id": "500-internal-error",
        "status": 500,
        "code": "INTERNAL_ERROR",
        "expected": ServerError,
    },
    {
        "id": "503-dependency-unavailable",
        "status": 503,
        "code": "DEPENDENCY_UNAVAILABLE",
        "expected": ServerError,
    },
]


@pytest.mark.parametrize("case", ERROR_CASES, ids=[case["id"] for case in ERROR_CASES])
def test_error_mapping(client: Client, service: MockService, case: dict) -> None:
    details = case.get("details", {})
    service.error(
        case["status"],
        case["code"],
        "Service refused the request.",
        details,
        headers=case.get("headers"),
    )

    with pytest.raises(case["expected"]) as excinfo:
        client.me()

    error = excinfo.value
    assert error.code == case["code"]
    assert error.http_status == case["status"]
    assert error.retry_after == case.get("retry_after")
    assert error.reset_at == case.get("reset_at")
    assert error.details == details


def test_all_errors_share_the_base_class() -> None:
    for cls in (
        ConfigurationError,
        NotificationsDisabledError,
        TransportError,
        AcceptanceUnknownError,
        PollTimeoutError,
        APIError,
        ValidationError,
        AuthenticationError,
        AuthorizationError,
        NotFoundError,
        PayloadTooLargeError,
        RateLimitError,
        ServerError,
    ):
        assert issubclass(cls, PortcloudNotifyError)


def test_api_error_details_hold_the_envelope_details(client: Client, service: MockService) -> None:
    service.error(404, "NOT_FOUND", "No such log.", {"log_id": 7})

    with pytest.raises(NotFoundError) as excinfo:
        client.me()

    error = excinfo.value
    assert isinstance(error, APIError)
    assert error.details == {"log_id": 7}
    assert error.message == "No such log."
    assert "NOT_FOUND" in str(error)


# ------------------------------------------------------- unknown send outcomes


def test_send_503_is_acceptance_unknown(client: Client, service: MockService) -> None:
    service.error(503, "DEPENDENCY_UNAVAILABLE", "Upstream down.", {"upstream": "smtp"})

    with pytest.raises(AcceptanceUnknownError) as excinfo:
        client.send("email", "T", body="B")

    error = excinfo.value
    assert error.outcome_unknown is True
    assert error.code == "DEPENDENCY_UNAVAILABLE"
    assert error.http_status == 503
    assert error.details == {"upstream": "smtp"}
    assert isinstance(error, TransportError)


def test_get_503_is_a_plain_server_error(client: Client, service: MockService) -> None:
    service.error(503, "DEPENDENCY_UNAVAILABLE", "Upstream down.")

    with pytest.raises(ServerError) as excinfo:
        client.me()

    error = excinfo.value
    assert not isinstance(error, AcceptanceUnknownError)
    assert getattr(error, "outcome_unknown", False) is False
    assert error.code == "DEPENDENCY_UNAVAILABLE"
    assert error.http_status == 503


def test_send_400_is_definitely_not_queued(client: Client, service: MockService) -> None:
    service.error(400, "NO_DEFAULT_CHANNEL", "Add a channel first.")

    with pytest.raises(ValidationError) as excinfo:
        client.send("email", "T", body="B")

    error = excinfo.value
    assert not isinstance(error, AcceptanceUnknownError)
    assert error.code == "NO_DEFAULT_CHANNEL"
    assert error.http_status == 400


def test_send_422_is_definitely_not_queued(client: Client, service: MockService) -> None:
    service.error(422, "VALIDATION_ERROR", "Bad title.")

    with pytest.raises(ValidationError) as excinfo:
        client.send_preset("T", "B")

    assert not isinstance(excinfo.value, AcceptanceUnknownError)


# ------------------------------------------------------------ unparsable bodies


def test_non_json_error_body_on_get(client: Client, service: MockService) -> None:
    service.queued(
        status=502,
        body=b"<html><body>Bad Gateway</body></html>",
        content_type="text/html",
    )

    with pytest.raises(ServerError) as excinfo:
        client.me()

    error = excinfo.value
    assert error.code == "HTTP_502"
    assert error.http_status == 502
    assert error.details == {}


def test_non_json_error_body_on_send(client: Client, service: MockService) -> None:
    service.queued(
        status=502,
        body=b"<html><body>Bad Gateway</body></html>",
        content_type="text/html",
    )

    with pytest.raises(AcceptanceUnknownError) as excinfo:
        client.send("email", "T", body="B")

    error = excinfo.value
    assert error.outcome_unknown is True
    assert error.code == "HTTP_502"
    assert error.http_status == 502


@pytest.mark.parametrize("payload", [{}, {"status": "queued"}, {"log_id": None}, {"log_id": 0}])
def test_send_201_without_a_usable_log_id(
    client: Client, service: MockService, payload: dict
) -> None:
    service.queued(status=201, payload=payload)

    with pytest.raises(AcceptanceUnknownError) as excinfo:
        client.send("email", "T", body="B")

    assert excinfo.value.outcome_unknown is True


def test_send_success_body_that_is_not_json(client: Client, service: MockService) -> None:
    service.queued(status=200, body=b"not json", content_type="text/plain")

    with pytest.raises(AcceptanceUnknownError):
        client.send("email", "T", body="B")


# ------------------------------------------------------------------ transport


def test_connection_refused_on_send_is_acceptance_unknown(dead_url: str) -> None:
    client = Client(api_key=API_KEY, base_url=dead_url, timeout=5)

    with pytest.raises(AcceptanceUnknownError) as excinfo:
        client.send("email", "T", body="B")

    error = excinfo.value
    assert error.outcome_unknown is True
    assert error.http_status is None


def test_connection_refused_on_get_is_a_plain_transport_error(dead_url: str) -> None:
    client = Client(api_key=API_KEY, base_url=dead_url, timeout=5)

    with pytest.raises(TransportError) as excinfo:
        client.me()

    error = excinfo.value
    assert type(error) is TransportError
    assert error.outcome_unknown is False
    assert error.http_status is None


# ------------------------------------------------------------------- redirect


def test_redirect_is_never_followed_on_send(client: Client, service: MockService) -> None:
    service.queued(status=302, headers={"Location": "/api/v1/redirected"})

    with pytest.raises(AcceptanceUnknownError) as excinfo:
        client.send("email", "T", body="B")

    error = excinfo.value
    assert error.http_status == 302
    assert error.outcome_unknown is True
    assert service.count() == 1
    assert service.count("/api/v1/send") == 1
    assert service.count("/api/v1/redirected") == 0


def test_redirect_is_never_followed_on_get(client: Client, service: MockService) -> None:
    service.queued(status=302, headers={"Location": "/api/v1/redirected"})

    with pytest.raises(TransportError) as excinfo:
        client.me()

    error = excinfo.value
    assert not isinstance(error, AcceptanceUnknownError)
    assert error.http_status == 302
    assert error.outcome_unknown is False
    assert service.count() == 1
    assert service.count("/api/v1/me") == 1
    assert service.count("/api/v1/redirected") == 0
