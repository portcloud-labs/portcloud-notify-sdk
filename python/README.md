# Portcloud Notify — Python SDK

Synchronous Python client for the [Portcloud Notify](https://notify.portcloud.online/docs/)
public HTTP API (`/api/v1/*`), which sends email and ntfy notifications. Distribution
name `portcloud-notify`, import name `portcloud_notify`, version `0.1.1`, Python >= 3.9.
It uses only the standard library (`urllib`), so it has zero runtime dependencies.
Sending is asynchronous: `send` and `send_preset` return an accepted `log_id`, and you
poll for the delivery result.

## Install

Not published to PyPI, so install from source:

```bash
# straight from GitHub
pip install "git+https://github.com/portcloud-labs/portcloud-notify-sdk.git#subdirectory=python"

# or from a local checkout, inside this directory
pip install .

# editable, for development
pip install -e .
```

## Quick start

1. Unlock your account and add an email or ntfy channel in the console
   (`/app/channels`); email channels must be verified.
2. Create an API key in the console ("API Keys") and store it server-side.
3. Run:

```python
from portcloud_notify import Client

client = Client()  # reads PORTCLOUD_NOTIFY_API_KEY

accepted = client.send_preset("Deploy done", "Service is live.")
print(accepted.log_id, accepted.status)  # queued — accepted, not delivered

status = client.wait(accepted.log_id, timeout=120)
print(status.status, status.failure_reason)
```

`send_preset` requires the account's sending preset to exist (otherwise the service
returns `400 NO_PRESET`). To send without a preset, name a channel explicitly — this
continues the quick start above, so `client` is already configured:

```python
accepted = client.send("email", "Deploy done", body="Service is live.", to="you@example.com")
```

## Configuration

Only the API key is configured locally; channels and the send preset are account
settings managed in the console.

| Setting | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PORTCLOUD_NOTIFY_API_KEY` | yes | — | Bearer key (`pck_...`). Also accepted as `Client(api_key=...)`. |
| `PORTCLOUD_NOTIFY_BASE_URL` | no | `https://notify.portcloud.online` | Site **origin only** (scheme + host); paths, queries, fragments and credentials are rejected. HTTPS is required, except an explicitly configured loopback HTTP address. |
| `PORTCLOUD_NOTIFY_ENABLED` | no | unset | Set to `0` to refuse sending: `send` and `send_preset` raise `NotificationsDisabledError`. Read-only calls (`get_status`, `wait`, `me`, `emails`, `logs`, `stats_overview`) still work. Cannot be overridden by `Client(enabled=True)`. |

Constructor: `Client(api_key=None, base_url=None, *, timeout=30.0, enabled=True, user_agent=None)`.
A missing/blank API key raises `ConfigurationError` before any request is sent.

## Methods

| Method | HTTP | Returns |
| --- | --- | --- |
| `send(type, title, *, body=None, html=None, to=None)` | `POST /api/v1/send` | `SendAccepted` (`log_id`, `status`) |
| `send_preset(title, body)` | `POST /api/v1/send-preset` | `PresetSendAccepted` (`log_id`, `preset_id`, `status`) |
| `get_status(log_id)` | `GET /api/v1/send/{log_id}` | `SendStatus` |
| `wait(log_id, *, timeout=60.0, interval=2.0)` | polls `GET /api/v1/send/{log_id}` | `SendStatus` (terminal) |
| `me()` | `GET /api/v1/me` | `Limits` |
| `emails()` | `GET /api/v1/emails` | `list[str]` (verified addresses) |
| `logs(*, page=1, page_size=20, status=None, reason=None, api_key_id=None, order="desc")` | `GET /api/v1/logs` | `Page` (`items`, `total`, `page`, `page_size`, `pages`) |
| `stats_overview(range="7d")` | `GET /api/v1/stats/overview` | `Overview` (`range`, `bucket`, `totals`, `series`, `failure_reasons`, `today`) |

Details:

- `send`: `type` is `"email"` or `"ntfy"`; `title` is 1–200 characters with no line
  breaks; supply exactly one of `body` (plain text) or `html` (email only); `to` is one
  channel the account already added — omit it to use the saved default channels matching
  `type` (the console no longer configures defaults, so pass `to` explicitly). The
  returned `log_id` is the **first** target.
- `send_preset`: the account's single preset owns the ordered channel chain, so only
  `title` and `body` are supplied. The returned `log_id` represents the whole chain.
- `wait`: polls until `status` is terminal (`success`, `failed`, `rejected`), waiting out
  `Retry-After` on a 429 and re-querying the same id. Raises `PollTimeoutError` on
  timeout; pass `timeout=None` to poll indefinitely. `SendStatus.is_terminal` and
  `SendStatus.succeeded` expose the same checks.
- `logs`: `page_size` is 1–100, `status` is one of `queued`, `sending`, `success`,
  `failed`, `rejected`, `order` is `asc` or `desc`.
- `stats_overview`: `range` is one of `7d`, `14d`, `30d`, `60d`, `90d`.
- Local argument validation raises `ValueError` (not `APIError`) before any request.

## Errors

Every exception derives from `PortcloudNotifyError`.

| Exception | Raised for |
| --- | --- |
| `ConfigurationError` | Local configuration missing/invalid. No request was sent. |
| `NotificationsDisabledError` | Sending disabled by `PORTCLOUD_NOTIFY_ENABLED=0` or `enabled=False`. |
| `TransportError` | No usable response (network failure, unparsable body). |
| `AcceptanceUnknownError` (a `TransportError`) | A send POST may already have been queued: timeout, dropped connection, `408`, `5xx`, a redirect, a 2xx that is not `201`, or an unparsable acceptance body. |
| `PollTimeoutError` | `wait` gave up before a terminal state (`log_id`, `last_status`). |
| `APIError` | The service's `{"error": {...}}` envelope. Base for the classes below. |
| `ValidationError` | `400` / `422` — rejected before any delivery was queued. |
| `AuthenticationError` | `401` — key missing, invalid, or expired. |
| `AuthorizationError` | `403` — account disabled or Star eligibility refusal. |
| `NotFoundError` | `404` — unknown `log_id`, or a target not owned by the account. |
| `PayloadTooLargeError` | `413` — message or request body too large. |
| `RateLimitError` | `429` — rate, Message Credits, or daily attempt limit. |
| `ServerError` | `5xx` — service-side failure. |

`APIError` exposes `http_status`, `code` (the stable machine-readable service code —
branch on this, not on `message`), `message`, `details`, and, when the service supplied
them, `retry_after` (seconds, from the `Retry-After` header or `details.retry_after`) and
`reset_at` (ISO 8601, from `details.reset_at`) — normally on the `429` `RateLimitError`.
When a response has no parsable envelope, `code` is
`HTTP_<status>`. Common codes include `VALIDATION_ERROR`, `NO_DEFAULT_CHANNEL`,
`NO_PRESET`, `RECIPIENT_NOT_VERIFIED`, `CHANNEL_TYPE_DISABLED`, `RATE_LIMITED`,
`MESSAGE_CREDITS_EXHAUSTED`, `DAILY_ATTEMPT_LIMIT_REACHED`,
`GLOBAL_MESSAGE_CREDITS_EXHAUSTED`, and `DEPENDENCY_UNAVAILABLE`.

```python
from portcloud_notify import APIError, Client, RateLimitError

client = Client()

try:
    accepted = client.send("email", "Deploy done", body="Service is live.", to="you@example.com")
except RateLimitError as exc:
    print("wait", exc.retry_after, "seconds; resets at", exc.reset_at)
except APIError as exc:
    if exc.code == "NO_DEFAULT_CHANNEL":
        pass  # pass an explicit `to` (or add a channel in the console)
    elif exc.code == "VALIDATION_ERROR":
        print(exc.details)  # field-level validation issues
    else:
        raise
```

## Asynchronous delivery semantics

- `201` (and the returned `status="queued"`) means **accepted, not delivered**. Poll the
  `log_id` with `wait` (or `get_status`) for the real result. Other targets' logs are in
  `logs()`.
- States: `queued` and `sending` are in flight; `success`, `failed`, and `rejected` are
  terminal. Fast deliveries may already be terminal on the first query.
- POSTs are **never retried automatically** — the API has no idempotency key, so another
  POST is a new send that can duplicate a message.
- `AcceptanceUnknownError` means the notification may already be queued: check `logs()`
  (and the recipient's inbox) before resending.
- `success` means the SMTP or ntfy service accepted the message — not that a human read
  it. There are no read receipts or open tracking.
- `failed` does not always prove nothing was sent: `interrupted`, `smtp_timeout`, and
  `smtp_connection_error` may mean the remote service accepted the message while this
  service never saw a complete response.

## Notes

- Channels and the sending preset are configured in the console, not by this SDK. The
  SDK cannot add channels, verify addresses, or create presets.
- `body` is plain text: HTML is never parsed. Email wraps it in the service template;
  ntfy receives the original plaintext.
- `html` is email-only and is sent verbatim — no service template, no escaping, no
  plaintext fallback. You own the content, links, and styling.
- Sending consumes Message Credits; read the current prices from `me().credits_per_target`
  (`0` means that channel type is disabled). `me()` also reports `max_message_size_bytes`,
  the acceptance-time size cap for a message.

## Documentation

Upstream API and console guides: <https://notify.portcloud.online/docs/>

## License

WTFPL — Do What The Fuck You Want To Public License, Version 2. The full text lives at
<https://github.com/portcloud-labs/portcloud-notify-sdk/blob/main/LICENSE>, and the
package metadata declares the SPDX identifier `WTFPL`.
