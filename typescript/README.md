# Portcloud Notify — JavaScript/TypeScript SDK

ESM client for the [Portcloud Notify](https://notify.portcloud.online/docs/) public HTTP API
(`/api/v1/*`), which sends email and ntfy notifications. Package `portcloud-notify`, version
`0.1.0`, Node >= 22, Cloudflare Workers, and Bun. It has **no runtime dependencies**: the
transport is the global `fetch`, which you can replace (Workers bindings, tests).

Sending is asynchronous: `send` and `sendPreset` return an accepted `logId`, and you poll for
the delivery result.

## Install

```bash
# from npm, once the first release is published
npm install portcloud-notify

# or from this repository today
npm install ./typescript
npm pack ./typescript && npm install ./portcloud-notify-0.1.0.tgz
```

TypeScript types ship with the package (`dist/index.d.ts`). The package is ESM-only.

## Quick start

1. Unlock your account and add an email or ntfy channel in the console
   (`/app/channels`); email channels must be verified.
2. Create an API key in the console ("API Keys") and store it server-side.
3. Run:

```ts
import { Client } from "portcloud-notify";

const client = new Client(); // reads PORTCLOUD_NOTIFY_API_KEY

const accepted = await client.sendPreset("Deploy done", "Service is live.");
console.log(accepted.logId, accepted.status); // queued — accepted, not delivered

const status = await client.waitForStatus(accepted.logId, { timeoutMs: 120_000 });
console.log(status.status, status.failureReason);
```

`sendPreset` requires the account's sending preset to exist (otherwise the service answers
`400 NO_PRESET`). To send without a preset, name a channel explicitly:

```ts
const accepted = await client.send("email", "Deploy done", {
  body: "Service is live.",
  to: "you@example.com",
});
```

### Cloudflare Workers

Workers have no `process.env`; pass the values from your bindings (and keep the injectable
`fetch`, which is the Worker's own):

```ts
import { Client } from "portcloud-notify";

export default {
  async fetch(_request: Request, env: Env) {
    const client = new Client({ apiKey: env.NOTIFY_KEY, baseUrl: env.NOTIFY_URL });
    const accepted = await client.sendPreset("Deploy done", "Service is live.");
    return Response.json(accepted);
  },
};
```

`sleep` and `now` are injectable too, so a Worker can drive `waitForStatus` with its own
timers — or skip polling entirely and query the status from a later cron run.

## Configuration

Only the API key is configured locally; channels and the send preset are account settings
managed in the console.

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `PORTCLOUD_NOTIFY_API_KEY` | Bearer key (`pck_...`). |
| `baseUrl` | `PORTCLOUD_NOTIFY_BASE_URL`, then `https://notify.portcloud.online` | Site **origin only** (scheme + host); paths, queries, fragments and credentials are rejected. HTTPS is required, except an explicitly configured loopback HTTP address. |
| `timeoutMs` | `30000` | Per-request timeout. |
| `enabled` | `true` | `false` refuses sending (`NotificationsDisabledError`); `PORTCLOUD_NOTIFY_ENABLED=0` cannot be overridden. Read-only calls still work. |
| `fetch` | global `fetch` | Transport override. |
| `sleep` / `now` | `setTimeout` / `Date.now` | Polling clock overrides. |
| `env` | `process.env` when available | Environment source; Workers pass their own object or use explicit options. |

A missing or blank API key raises `ConfigurationError` before any request is sent.

## Methods

| Method | HTTP | Returns |
| --- | --- | --- |
| `send(type, title, { body?, html?, to? })` | `POST /api/v1/send` | `SendAccepted` (`logId`, `status`) |
| `sendPreset(title, body)` | `POST /api/v1/send-preset` | `PresetSendAccepted` (`logId`, `presetId`, `status`) |
| `getStatus(logId)` | `GET /api/v1/send/{logId}` | `SendStatus` |
| `waitForStatus(logId, { timeoutMs?, intervalMs? })` | polls `GET /api/v1/send/{logId}` | `SendStatus` (terminal) |
| `me()` | `GET /api/v1/me` | `Limits` |
| `emails()` | `GET /api/v1/emails` | `string[]` (verified addresses) |
| `logs({ page?, pageSize?, status?, reason?, apiKeyId?, order? })` | `GET /api/v1/logs` | `Page` |
| `statsOverview(range?)` | `GET /api/v1/stats/overview` | `Overview` |

Details:

- `send`: `type` is `"email"` or `"ntfy"`; `title` is 1–200 characters with no line breaks;
  supply exactly one of `body` (plain text) or `html` (email only); `to` is one channel the
  account already added — omit it to use the saved default channels matching `type`. The
  returned `logId` is the **first** target.
- `sendPreset`: the account's single preset owns the ordered channel chain, so only `title`
  and `body` are supplied. The returned `logId` represents the whole chain.
- `waitForStatus`: polls until `status` is terminal (`success`, `failed`, `rejected`), waiting
  out `Retry-After` on a 429 and re-querying the same id. Throws `PollTimeoutError` on
  timeout; pass `timeoutMs: null` to poll indefinitely. `isTerminalStatus(status)` exposes the
  same check.
- `logs`: `pageSize` is 1–100, `status` is one of `queued`, `sending`, `success`, `failed`,
  `rejected`, `order` is `asc` or `desc`.
- `statsOverview`: `range` is one of `7d`, `14d`, `30d`, `60d`, `90d`.
- Local argument validation throws `RangeError` (not an `APIError`) before any request.

## Errors

Every SDK error derives from `PortcloudNotifyError`.

| Error | Raised for |
| --- | --- |
| `ConfigurationError` | Local configuration missing/invalid. No request was sent. |
| `NotificationsDisabledError` | Sending disabled by `PORTCLOUD_NOTIFY_ENABLED=0` or `enabled: false`. |
| `TransportError` | No usable response (network failure, unparsable body). |
| `AcceptanceUnknownError` (a `TransportError`) | A send POST may already have been queued: timeout, dropped connection, `408`, `5xx`, a redirect, a 2xx that is not `201`, or an unparsable acceptance body. |
| `PollTimeoutError` | `waitForStatus` gave up before a terminal state (`logId`, `lastStatus`). |
| `APIError` | The service's `{ error: { ... } }` envelope. Base for the errors below. |
| `ValidationError` | `400` / `422` — rejected before any delivery was queued. |
| `AuthenticationError` | `401` — key missing, invalid, or expired. |
| `AuthorizationError` | `403` — account disabled or Star eligibility refusal. |
| `NotFoundError` | `404` — unknown `logId`, or a target not owned by the account. |
| `PayloadTooLargeError` | `413` — message or request body too large. |
| `RateLimitError` | `429` — rate, Message Credits, or daily attempt limit. |
| `ServerError` | `5xx` — service-side failure. |
| `ResponseShapeError` | A response body did not match the documented shape (thrown by the parsers, surfaced as `TransportError`/`AcceptanceUnknownError` by the client). |

`APIError` exposes `httpStatus`, `code` (the stable machine-readable service code — branch on
this, not on the message), `serviceMessage`, `details`, and, when the service supplied them,
`retryAfter` (seconds) and `resetAt` (ISO 8601) — normally on a `429` `RateLimitError`. When a
response has no parsable envelope, `code` is `HTTP_<status>`.

```ts
import { APIError, Client, RateLimitError } from "portcloud-notify";

const client = new Client();

try {
  await client.send("email", "Deploy done", { body: "Service is live.", to: "you@example.com" });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log("wait", error.retryAfter, "seconds; resets at", error.resetAt);
  } else if (error instanceof APIError && error.code === "NO_DEFAULT_CHANNEL") {
    // pass an explicit `to` (or add a channel in the console)
  } else {
    throw error;
  }
}
```

## Asynchronous delivery semantics

- `201` (and the returned `status: "queued"`) means **accepted, not delivered**. Poll the
  `logId` with `waitForStatus` (or `getStatus`) for the real result.
- States: `queued` and `sending` are in flight; `success`, `failed`, and `rejected` are
  terminal. Fast deliveries may already be terminal on the first query.
- POSTs are **never retried automatically** — the API has no idempotency key, so another POST
  is a new send that can duplicate a message.
- `AcceptanceUnknownError` means the notification may already be queued: check `logs()` (and
  the recipient's inbox) before resending.
- `success` means the SMTP or ntfy service accepted the message — not that a human read it.
- `failed` does not always prove nothing was sent: `interrupted`, `smtp_timeout`, and
  `smtp_connection_error` may mean the remote service accepted the message while this service
  never saw a complete response.

## Notes

- Channels and the sending preset are configured in the console, not by this SDK.
- `body` is plain text: HTML is never parsed. Email wraps it in the service template; ntfy
  receives the original plaintext.
- `html` is email-only and is sent verbatim — no service template, no escaping, no plaintext
  fallback. You own the content, links, and styling.
- Sending consumes Message Credits; read the current prices from `(await client.me()).creditsPerTarget`
  (`0` means that channel type is disabled).

## License

WTFPL — Do What The Fuck You Want To Public License, Version 2. The full text lives at
<https://github.com/portcloud-labs/portcloud-notify-sdk/blob/main/LICENSE>.
