/**
 * Error-taxonomy tests for the portcloud-notify SDK: the status → class mapping, the
 * unknown-outcome contract for send POSTs, and the transport failures that are never
 * retried. Runs against the built `dist/` output.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
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
  errorFromResponse,
} from "../dist/index.js";
import { startService } from "./helpers.mjs";

const STATUS_CASES = [
  [400, "NO_DEFAULT_CHANNEL", ValidationError],
  [422, "VALIDATION_ERROR", ValidationError],
  [401, "INVALID_API_KEY", AuthenticationError],
  [403, "ACCOUNT_DISABLED", AuthorizationError],
  [404, "LOG_NOT_FOUND", NotFoundError],
  [413, "PAYLOAD_TOO_LARGE", PayloadTooLargeError],
  [429, "RATE_LIMITED", RateLimitError],
  [500, "INTERNAL_ERROR", ServerError],
  [503, "DEPENDENCY_UNAVAILABLE", ServerError],
];

async function withService(t) {
  const service = await startService();
  t.after(() => service.close());
  return service;
}

function clientFor(service, options = {}) {
  return new Client({ apiKey: "pck_test", baseUrl: service.url, ...options });
}

async function capture(promise) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

// ------------------------------------------------------- status → class map

test("errorFromResponse maps every documented status to its class", () => {
  for (const [status, code, Expected] of STATUS_CASES) {
    const error = errorFromResponse(
      status,
      { error: { code, message: `${code} happened`, details: { field: "title" } } },
      new Headers(),
    );

    assert.ok(error instanceof Expected, `HTTP ${status} should be ${Expected.name}`);
    assert.ok(error instanceof PortcloudNotifyError);
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, status);
    assert.deepEqual(error.details, { field: "title" });
    assert.equal(error.serviceMessage, `${code} happened`);
  }
});

test("a 429 takes retryAfter from the header and resetAt from details", () => {
  const error = errorFromResponse(
    429,
    {
      error: {
        code: "RATE_LIMITED",
        message: "slow down",
        details: { reset_at: "2026-01-02T03:04:05Z", retry_after: 12 },
      },
    },
    new Headers({ "retry-after": "30" }),
  );

  assert.ok(error instanceof RateLimitError);
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.httpStatus, 429);
  assert.equal(error.retryAfter, 30);
  assert.equal(error.resetAt, "2026-01-02T03:04:05Z");
  assert.deepEqual(error.details, { reset_at: "2026-01-02T03:04:05Z", retry_after: 12 });

  const fallback = errorFromResponse(429, {
    error: { code: "RATE_LIMITED", message: "slow down", details: { retry_after: 12 } },
  });
  assert.equal(fallback.retryAfter, 12);
  assert.equal(fallback.resetAt, undefined);
});

test("the client raises the mapped class for every documented status", async (t) => {
  const service = await withService(t);

  for (const [status, code, Expected] of STATUS_CASES) {
    service.queued({
      status,
      payload: { error: { code, message: `${code} happened`, details: { field: "title" } } },
    });
    const error = await capture(clientFor(service).me());

    assert.ok(error instanceof Expected, `HTTP ${status} should be ${Expected.name}`);
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, status);
    assert.deepEqual(error.details, { field: "title" });
  }

  assert.equal(service.count(), STATUS_CASES.length);
});

test("every SDK error derives from PortcloudNotifyError", () => {
  const errors = [
    new ConfigurationError("x"),
    new NotificationsDisabledError("x"),
    new TransportError("x"),
    new AcceptanceUnknownError("x"),
    new PollTimeoutError("x"),
    errorFromResponse(500, undefined),
    errorFromResponse(400, undefined),
  ];

  for (const error of errors) {
    assert.ok(error instanceof PortcloudNotifyError, error.constructor.name);
    assert.ok(error instanceof Error, error.constructor.name);
    assert.equal(error.name, error.constructor.name);
  }

  assert.ok(errors[5] instanceof APIError);
  assert.ok(errors[6] instanceof ValidationError);
  assert.ok(errors[3] instanceof TransportError);
  assert.ok(errors[3] instanceof PortcloudNotifyError);

  const transport = new TransportError("x");
  assert.equal(transport.outcomeUnknown, false);
  assert.equal(transport.httpStatus, undefined);
  const acceptance = new AcceptanceUnknownError("x");
  assert.equal(acceptance.outcomeUnknown, true);
  assert.equal(acceptance.code, undefined);
  assert.deepEqual(acceptance.details, {});
  const poll = new PollTimeoutError("x");
  assert.equal(poll.logId, undefined);
  assert.equal(poll.lastStatus, undefined);
});

// ------------------------------------------------------------ send outcome

test("a 5xx send POST is an unknown outcome while the same status on a read is not", async (t) => {
  const service = await withService(t);

  service.queued(
    service.error(503, "DEPENDENCY_UNAVAILABLE", "upstream down", { upstream: "smtp" }),
  );
  const sendError = await capture(clientFor(service).send("email", "T", { body: "B" }));

  assert.ok(sendError instanceof AcceptanceUnknownError);
  assert.equal(sendError.outcomeUnknown, true);
  assert.equal(sendError.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(sendError.httpStatus, 503);
  assert.deepEqual(sendError.details, { upstream: "smtp" });

  service.queued(service.error(503, "DEPENDENCY_UNAVAILABLE", "upstream down"));
  const readError = await capture(clientFor(service).me());

  assert.ok(readError instanceof ServerError);
  assert.equal(readError instanceof AcceptanceUnknownError, false);
  assert.equal(readError instanceof TransportError, false);
  assert.equal(readError.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(readError.httpStatus, 503);
});

test("a 400 send POST stays a validation error", async (t) => {
  const service = await withService(t);
  service.queued(service.error(400, "NO_DEFAULT_CHANNEL", "no channel configured"));

  const error = await capture(clientFor(service).send("email", "T", { body: "B" }));

  assert.ok(error instanceof ValidationError);
  assert.equal(error instanceof AcceptanceUnknownError, false);
  assert.equal(error.code, "NO_DEFAULT_CHANNEL");
  assert.equal(error.httpStatus, 400);
});

test("a non-JSON error body degrades to HTTP_<status>", async (t) => {
  const service = await withService(t);
  const html = { status: 502, body: "<html><body>bad gateway</body></html>", headers: { "content-type": "text/html" } };

  service.queued(html);
  const readError = await capture(clientFor(service).me());

  assert.ok(readError instanceof ServerError);
  assert.equal(readError.code, "HTTP_502");
  assert.equal(readError.httpStatus, 502);
  assert.deepEqual(readError.details, {});

  service.queued(html);
  const sendError = await capture(clientFor(service).send("email", "T", { body: "B" }));

  assert.ok(sendError instanceof AcceptanceUnknownError);
  assert.equal(sendError.outcomeUnknown, true);
  assert.equal(sendError.code, "HTTP_502");
  assert.equal(sendError.httpStatus, 502);
});

test("a 201 acceptance without a usable log_id is an unknown outcome", async (t) => {
  const service = await withService(t);
  const payloads = [
    { status: "queued" },
    { log_id: null, status: "queued" },
    { log_id: 0, status: "queued" },
    { log_id: -1, status: "queued" },
    { log_id: "1", status: "queued" },
  ];

  for (const payload of payloads) {
    service.queued({ status: 201, payload });
    const error = await capture(clientFor(service).send("email", "T", { body: "B" }));

    assert.ok(error instanceof AcceptanceUnknownError, JSON.stringify(payload));
    assert.equal(error.outcomeUnknown, true, JSON.stringify(payload));
    assert.equal(error.httpStatus, 201, JSON.stringify(payload));
  }

  assert.equal(service.count(), payloads.length);
});

test("only HTTP 201 is an acceptance, and only on a send POST", async (t) => {
  const service = await withService(t);

  for (const status of [200, 202]) {
    service.queued({ status, payload: { log_id: 5, status: "queued" } });
    const error = await capture(clientFor(service).send("email", "T", { body: "B" }));

    assert.ok(error instanceof AcceptanceUnknownError, `send answered ${status}`);
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.httpStatus, status);
  }

  service.queued({ status: 201, payload: { log_id: 5, status: "queued" } });
  const readError = await capture(clientFor(service).me());

  assert.ok(readError instanceof TransportError);
  assert.equal(readError instanceof AcceptanceUnknownError, false);
  assert.equal(readError.outcomeUnknown, false);
  assert.equal(readError.httpStatus, 201);
});

test("a 302 is never followed and poisons the send outcome", async (t) => {
  const service = await withService(t);
  service.queued({ status: 302, headers: { location: `${service.url}/redirect-target` } });

  const error = await capture(clientFor(service).send("email", "T", { body: "B" }));

  assert.ok(error instanceof AcceptanceUnknownError);
  assert.equal(error.outcomeUnknown, true);
  assert.equal(error.httpStatus, 302);
  assert.equal(service.count(), 1);
  assert.equal(service.count("/redirect-target"), 0);
});

test("a 302 on a read is a transport error and is never followed", async (t) => {
  const service = await withService(t);
  service.queued({ status: 302, headers: { location: `${service.url}/redirect-target` } });

  const error = await capture(clientFor(service).me());

  assert.ok(error instanceof TransportError);
  assert.equal(error instanceof AcceptanceUnknownError, false);
  assert.equal(error.outcomeUnknown, false);
  assert.equal(error.httpStatus, 302);
  assert.equal(service.count(), 1);
  assert.equal(service.count("/redirect-target"), 0);
});

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a dead loopback port is an unknown outcome for a send and a transport error for a read", async () => {
  const port = await unusedPort();
  const client = new Client({
    apiKey: "pck_test",
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 2_000,
  });

  const sendError = await capture(client.send("email", "T", { body: "B" }));
  assert.ok(sendError instanceof AcceptanceUnknownError);
  assert.equal(sendError.outcomeUnknown, true);
  assert.equal(sendError.httpStatus, undefined);

  const readError = await capture(client.me());
  assert.ok(readError instanceof TransportError);
  assert.equal(readError instanceof AcceptanceUnknownError, false);
  assert.equal(readError.outcomeUnknown, false);
  assert.equal(readError.httpStatus, undefined);
});
