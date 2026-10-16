"""Python SDK for the Portcloud Notify public HTTP API.

```python
from portcloud_notify import Client

client = Client()  # reads PORTCLOUD_NOTIFY_API_KEY
accepted = client.send_preset("Deploy done", "Service is live.")
status = client.wait(accepted.log_id)
print(status.status, status.failure_reason)
```

Delivery is asynchronous: acceptance returns a ``log_id`` before the message is
delivered, and a successful acceptance is not proof of delivery. POST requests
are never retried automatically because the API provides no idempotency key.
"""

from ._version import __version__
from .client import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, Client, normalize_base_url
from .errors import (
    AcceptanceUnknownError,
    APIError,
    AuthenticationError,
    AuthorizationError,
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
from .models import (
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

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "TERMINAL_STATUSES",
    "APIError",
    "AcceptanceUnknownError",
    "AuthenticationError",
    "AuthorizationError",
    "Client",
    "ConfigurationError",
    "FailureReasonCount",
    "Limits",
    "NotFoundError",
    "NotificationsDisabledError",
    "Overview",
    "Page",
    "PayloadTooLargeError",
    "PollTimeoutError",
    "PortcloudNotifyError",
    "PresetSendAccepted",
    "RateLimitError",
    "SendAccepted",
    "SendLog",
    "SendStatus",
    "SeriesPoint",
    "ServerError",
    "TodayStats",
    "Totals",
    "TransportError",
    "ValidationError",
    "__version__",
    "normalize_base_url",
]
