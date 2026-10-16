/**
 * Behavioural tests for the portcloud-notify client, driven through a loopback mock
 * service. Everything runs against the built `dist/` output, i.e. what ships.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  Client,
  ConfigurationError,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  NotificationsDisabledError,
  PollTimeoutError,
  isTerminalStatus,
} from "../dist/index.js";
import { startService } from "./helpers.mjs";

const CREATED_AT = "2026-01-02T03:04:05.123456+00:00";

const LIMITS_PAYLOAD = {
  daily_message_credits: 100,
  message_credits_used: 3,
  message_credits_reserved: 1,
  message_credits_remaining: 96,
  credits_per_email: 1,
  credits_per_ntfy: 2,
  credits_per_target: { email: 1, ntfy: 2, sms: 0 },
  daily_reset_at: "2026-01-03T00:00:00Z",
  minute_attempt_limit: 10,
  daily_attempt_limit: 1000,
  daily_attempt_used: 7,
  max_verified_emails: 5,
  max_ntfy_channels: 4,
  max_api_keys: 3,
  max_message_size_bytes: 1048576,
  is_admin: false,
};

async function withService(t) {
  const service = await startService();
  t.after(() => service.close());
  return service;
}

function clientFor(service, options = {}) {
  return new Client({ apiKey: "pck_test", baseUrl: service.url, ...options });
}

// --------------------------------------------------------------- requests

test("send POSTs {type,title,body} to /api/v1/send and parses the acceptance", async (t) => {
  const service = await withService(t);
  service.queued({ status: 201, payload: { log_id: 42, status: "queued" } });

  const accepted = await clientFor(service).send("email", "T", { body: "B" });

  assert.deepEqual(accepted, { logId: 42, status: "queued" });
  assert.equal(service.count(), 1);
  const [request] = service.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/send");
  assert.equal(request.query.toString(), "");
  assert.equal(request.headers.authorization, "Bearer pck_test");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers.accept, "application/json");
  assert.deepEqual(request.body, { type: "email", title: "T", body: "B" });
  assert.equal(Object.hasOwn(request.body, "to"), false);
  assert.equal(Object.hasOwn(request.body, "html"), false);
});

test("send includes html and to when supplied, and never html for ntfy", async (t) => {
  const service = await withService(t);
  service.route("POST", "/api/v1/send", { status: 201, payload: { log_id: 1, status: "queued" } });
  const client = clientFor(service);

  await client.send("email", "T", { html: "<b>x</b>", to: "a@b.c" });
  await client.send("ntfy", "T", { body: "B", to: "topic" });

  assert.deepEqual(service.requests[0].body, {
    type: "email",
    title: "T",
    html: "<b>x</b>",
    to: "a@b.c",
  });
  assert.deepEqual(service.requests[1].body, {
    type: "ntfy",
    title: "T",
    body: "B",
    to: "topic",
  });
  assert.equal(Object.hasOwn(service.requests[1].body, "html"), false);
});

test("sendPreset POSTs {title,body} to /api/v1/send-preset", async (t) => {
  const service = await withService(t);
  service.queued({ status: 201, payload: { log_id: 7, preset_id: 3, status: "queued" } });

  const accepted = await clientFor(service).sendPreset("T", "B");

  assert.deepEqual(accepted, { logId: 7, presetId: 3, status: "queued" });
  assert.equal(service.count(), 1);
  const [request] = service.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/send-preset");
  assert.equal(request.headers.authorization, "Bearer pck_test");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(request.body, { title: "T", body: "B" });
});

test("getStatus GETs /api/v1/send/{logId} and parses every documented field", async (t) => {
  const service = await withService(t);
  service.route("GET", "/api/v1/send/123", {
    payload: {
      log_id: 123,
      status: "success",
      created_at: CREATED_AT,
      duration_ms: 250,
      failure_reason: "smtp_timeout",
      message_id: "<mid@example>",
      smtp_response: "250 2.0.0 OK",
      unknown_field: "ignored",
    },
  });

  const status = await clientFor(service).getStatus(123);

  assert.deepEqual(status, {
    logId: 123,
    status: "success",
    createdAt: CREATED_AT,
    durationMs: 250,
    failureReason: "smtp_timeout",
    messageId: "<mid@example>",
    smtpResponse: "250 2.0.0 OK",
  });
  const [request] = service.requests;
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/api/v1/send/123");
  assert.equal(request.query.toString(), "");
});

test("isTerminalStatus is true only for terminal delivery states", () => {
  assert.equal(isTerminalStatus("queued"), false);
  assert.equal(isTerminalStatus("sending"), false);
  assert.equal(isTerminalStatus("success"), true);
  assert.equal(isTerminalStatus("failed"), true);
  assert.equal(isTerminalStatus("rejected"), true);
});

test("logs sends the documented query params and parses a page with nested logs", async (t) => {
  const service = await withService(t);
  service.route("GET", "/api/v1/logs", {
    payload: {
      items: [
        {
          id: 11,
          status: "success",
          created_at: CREATED_AT,
          api_key_id: 3,
          client_ip: "203.0.113.7",
          duration_ms: 120,
          failure_reason: "smtp_timeout",
          message_size_bytes: 512,
          recipient: "a@b.c",
          smtp_response: "250 2.0.0 OK",
          subject: "T",
          unknown_field: "ignored",
        },
      ],
      total: 51,
      page: 2,
      page_size: 50,
      pages: 2,
      unknown_field: "ignored",
    },
  });
  const client = clientFor(service);

  const page = await client.logs({
    page: 2,
    pageSize: 50,
    status: "success",
    reason: "smtp_timeout",
    apiKeyId: 3,
    order: "asc",
  });

  assert.deepEqual(page, {
    items: [
      {
        id: 11,
        status: "success",
        createdAt: CREATED_AT,
        apiKeyId: 3,
        clientIp: "203.0.113.7",
        durationMs: 120,
        failureReason: "smtp_timeout",
        messageSizeBytes: 512,
        recipient: "a@b.c",
        smtpResponse: "250 2.0.0 OK",
        subject: "T",
      },
    ],
    total: 51,
    page: 2,
    pageSize: 50,
    pages: 2,
  });

  const [request] = service.requests;
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/api/v1/logs");
  assert.deepEqual([...request.query.entries()].sort(), [
    ["api_key_id", "3"],
    ["order", "asc"],
    ["page", "2"],
    ["page_size", "50"],
    ["reason", "smtp_timeout"],
    ["status", "success"],
  ]);

  await client.logs();

  const defaults = service.requests[1];
  assert.deepEqual([...defaults.query.entries()].sort(), [
    ["order", "desc"],
    ["page", "1"],
    ["page_size", "20"],
  ]);
});

test("me, emails, and statsOverview parse their responses", async (t) => {
  const service = await withService(t);
  service.route("GET", "/api/v1/me", {
    payload: { ...LIMITS_PAYLOAD, unknown_field: "ignored" },
  });
  service.route("GET", "/api/v1/emails", { payload: ["a@b.c"] });
  service.route("GET", "/api/v1/stats/overview", {
    payload: {
      range: "30d",
      bucket: "day",
      totals: { attempted: 10, success: 8, failed: 1, rejected: 1, success_rate: 0.8 },
      series: [{ bucket_start: "2026-01-01", success: 4, failed: 1, rejected: 0 }],
      failure_reasons: [{ reason: "smtp_timeout", count: 1 }],
      today: {
        attempted: 2,
        success: 2,
        failed: 0,
        rejected: 0,
        success_rate: 1,
        reset_at: "2026-01-03T00:00:00Z",
      },
    },
  });
  const client = clientFor(service);

  assert.deepEqual(await client.me(), {
    dailyMessageCredits: 100,
    messageCreditsUsed: 3,
    messageCreditsReserved: 1,
    messageCreditsRemaining: 96,
    creditsPerEmail: 1,
    creditsPerNtfy: 2,
    creditsPerTarget: { email: 1, ntfy: 2, sms: 0 },
    dailyResetAt: "2026-01-03T00:00:00Z",
    minuteAttemptLimit: 10,
    dailyAttemptLimit: 1000,
    dailyAttemptUsed: 7,
    maxVerifiedEmails: 5,
    maxNtfyChannels: 4,
    maxApiKeys: 3,
    maxMessageSizeBytes: 1048576,
    isAdmin: false,
  });

  assert.deepEqual(await client.emails(), ["a@b.c"]);

  assert.deepEqual(await client.statsOverview("30d"), {
    range: "30d",
    bucket: "day",
    totals: { attempted: 10, success: 8, failed: 1, rejected: 1, successRate: 0.8 },
    series: [{ bucketStart: "2026-01-01", success: 4, failed: 1, rejected: 0 }],
    failureReasons: [{ reason: "smtp_timeout", count: 1 }],
    today: {
      attempted: 2,
      success: 2,
      failed: 0,
      rejected: 0,
      successRate: 1,
      resetAt: "2026-01-03T00:00:00Z",
    },
  });

  const [overview] = service.requests.filter(
    (request) => request.path === "/api/v1/stats/overview",
  );
  assert.deepEqual([...overview.query.entries()], [["range", "30d"]]);
});

// ---------------------------------------------------------------- polling

test("waitForStatus polls with the injected sleep/now until the status is terminal", async (t) => {
  const service = await withService(t);
  const statuses = ["sending", "success"];
  service.setHandler((method, path, query) => {
    if (method !== "GET" || path !== "/api/v1/send/7") return undefined;
    assert.equal(query.toString(), "");
    return { payload: { log_id: 7, status: statuses.shift(), created_at: CREATED_AT } };
  });
  const sleeps = [];
  const client = clientFor(service, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
  });

  const status = await client.waitForStatus(7, { intervalMs: 25, timeoutMs: 10_000 });

  assert.equal(status.status, "success");
  assert.equal(status.logId, 7);
  assert.equal(service.count("/api/v1/send/7"), 2);
  assert.deepEqual(
    service.requests.map((request) => `${request.method} ${request.path}`),
    ["GET /api/v1/send/7", "GET /api/v1/send/7"],
  );
  assert.deepEqual(sleeps, [25]);
});

test("waitForStatus waits out Retry-After on a 429 before re-querying", async (t) => {
  const service = await withService(t);
  service.queued(
    service.error(429, "RATE_LIMITED", "too many attempts", undefined, { "retry-after": "30" }),
  );
  service.queued({ payload: { log_id: 7, status: "success", created_at: CREATED_AT } });
  const sleeps = [];
  const client = clientFor(service, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
  });

  const status = await client.waitForStatus(7, { intervalMs: 25, timeoutMs: 60_000 });

  assert.equal(status.status, "success");
  assert.equal(service.count(), 2);
  assert.deepEqual(
    service.requests.map((request) => request.path),
    ["/api/v1/send/7", "/api/v1/send/7"],
  );
  assert.deepEqual(sleeps, [30_000]);
});

test("waitForStatus raises PollTimeoutError when the budget is already spent", async (t) => {
  const service = await withService(t);
  service.queued({ payload: { log_id: 7, status: "sending", created_at: CREATED_AT } });
  const client = clientFor(service, {
    sleep: async () => {
      throw new Error("sleep must not be reached once the budget is spent");
    },
    now: () => 0,
  });

  await assert.rejects(
    client.waitForStatus(7, { timeoutMs: 0, intervalMs: 1000 }),
    (error) => {
      assert.ok(error instanceof PollTimeoutError);
      assert.equal(error.logId, 7);
      assert.equal(error.lastStatus, "sending");
      return true;
    },
  );
  assert.equal(service.count(), 1);
});

test("waitForStatus keeps polling when timeoutMs is null", async (t) => {
  const service = await withService(t);
  service.queued({ payload: { log_id: 7, status: "queued", created_at: CREATED_AT } });
  service.queued({ payload: { log_id: 7, status: "sending", created_at: CREATED_AT } });
  service.queued({ payload: { log_id: 7, status: "rejected", created_at: CREATED_AT } });
  const sleeps = [];
  const client = clientFor(service, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
  });

  const status = await client.waitForStatus(7, { timeoutMs: null, intervalMs: 5 });

  assert.equal(status.status, "rejected");
  assert.equal(service.count(), 3);
  assert.deepEqual(sleeps, [5, 5]);
});

test("waitForStatus uses the default sleep/now when none are injected", async (t) => {
  const service = await withService(t);
  service.queued({ payload: { log_id: 3, status: "queued", created_at: CREATED_AT } });
  service.queued({ payload: { log_id: 3, status: "success", created_at: CREATED_AT } });
  const client = clientFor(service);

  const status = await client.waitForStatus(3, { intervalMs: 1 });

  assert.equal(status.status, "success");
  assert.equal(service.count(), 2);
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 2_000);
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 60_000);
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
});

// --------------------------------------------------------------- transport

test("an injected fetch receives the request URL and init", async () => {
  const calls = [];
  const stub = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ log_id: 9, status: "queued" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new Client({
    apiKey: "pck_test",
    baseUrl: "https://notify.test",
    fetch: stub,
  });

  const accepted = await client.send("email", "T", { body: "B" });

  assert.deepEqual(accepted, { logId: 9, status: "queued" });
  assert.equal(calls.length, 1);
  const [{ input, init }] = calls;
  assert.equal(input, "https://notify.test/api/v1/send");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal(init.headers.Authorization, "Bearer pck_test");
  assert.equal(init.headers.Accept, "application/json");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.match(init.headers["User-Agent"], /^portcloud-notify-js\/\d+\.\d+\.\d+$/);
  assert.equal(init.body, JSON.stringify({ type: "email", title: "T", body: "B" }));
  assert.ok(init.signal instanceof AbortSignal);
});

// -------------------------------------------------------- local validation

test("send rejects invalid input locally without issuing a request", async (t) => {
  const service = await withService(t);
  const client = clientFor(service);
  const cases = [
    ["body and html together", () => client.send("email", "T", { body: "B", html: "<b>x</b>" })],
    ["neither body nor html", () => client.send("email", "T")],
    ["an unknown channel type", () => client.send("sms", "T", { body: "B" })],
    ["html for ntfy", () => client.send("ntfy", "T", { html: "<b>x</b>" })],
    ["a title with a line break", () => client.send("email", "a\nb", { body: "B" })],
    ["a 201-character title", () => client.send("email", "x".repeat(201), { body: "B" })],
  ];

  for (const [name, call] of cases) {
    await assert.rejects(call(), (error) => {
      assert.ok(error instanceof RangeError, `${name}: ${error}`);
      return true;
    }, name);
  }

  assert.equal(service.requests.length, 0);
});

test("query and polling options are validated locally without a request", async (t) => {
  const service = await withService(t);
  const client = clientFor(service);
  const cases = [
    ["pageSize 0", () => client.logs({ pageSize: 0 })],
    ["pageSize 101", () => client.logs({ pageSize: 101 })],
    ["an unknown status", () => client.logs({ status: "bogus" })],
    ["an unknown order", () => client.logs({ order: "up" })],
    ["an unknown stats range", () => client.statsOverview("1d")],
    ["logId 0", () => client.getStatus(0)],
    ["intervalMs 0", () => client.waitForStatus(1, { intervalMs: 0 })],
  ];

  for (const [name, call] of cases) {
    await assert.rejects(call(), (error) => {
      assert.ok(error instanceof RangeError, `${name}: ${error}`);
      return true;
    }, name);
  }

  assert.equal(service.requests.length, 0);
});

// ------------------------------------------------------------ configuration

test("the client validates its configuration", async (t) => {
  const service = await withService(t);

  assert.throws(() => new Client({ env: {} }), ConfigurationError);
  assert.throws(
    () => new Client({ apiKey: "pck_ test", baseUrl: service.url }),
    ConfigurationError,
  );
  assert.throws(
    () => new Client({ apiKey: "pck_test", baseUrl: "https://host/api/v1" }),
    ConfigurationError,
  );
  assert.throws(
    () => new Client({ apiKey: "pck_test", baseUrl: "http://example.com" }),
    ConfigurationError,
  );
  assert.throws(
    () => new Client({ apiKey: "pck_test", baseUrl: "https://user:pw@host" }),
    ConfigurationError,
  );

  const loopback = new Client({ apiKey: "pck_test", baseUrl: "http://127.0.0.1:8000" });
  assert.equal(loopback.baseUrl, "http://127.0.0.1:8000");
  assert.equal(service.requests.length, 0);
});

test("the client honours its environment and the disabled flag", async (t) => {
  const service = await withService(t);
  service.route("POST", "/api/v1/send", { status: 201, payload: { log_id: 1, status: "queued" } });
  service.route("POST", "/api/v1/send-preset", {
    status: 201,
    payload: { log_id: 1, preset_id: 1, status: "queued" },
  });
  service.route("GET", "/api/v1/me", { payload: LIMITS_PAYLOAD });

  const fromEnv = new Client({
    env: { PORTCLOUD_NOTIFY_API_KEY: "pck_env", PORTCLOUD_NOTIFY_BASE_URL: service.url },
  });
  assert.equal(fromEnv.baseUrl, service.url);
  await fromEnv.send("email", "T", { body: "B" });
  assert.equal(service.requests[0].headers.authorization, "Bearer pck_env");

  const emptyBaseUrl = new Client({
    env: { PORTCLOUD_NOTIFY_API_KEY: "pck_env", PORTCLOUD_NOTIFY_BASE_URL: "" },
  });
  assert.equal(emptyBaseUrl.baseUrl, "https://notify.portcloud.online");

  for (const options of [
    { env: { PORTCLOUD_NOTIFY_API_KEY: "pck_env", PORTCLOUD_NOTIFY_ENABLED: "0" } },
    { apiKey: "pck_env", enabled: false },
  ]) {
    const client = new Client({ baseUrl: service.url, ...options });
    assert.equal(client.enabled, false);
    await assert.rejects(
      client.send("email", "T", { body: "B" }),
      NotificationsDisabledError,
    );
    await assert.rejects(client.sendPreset("T", "B"), NotificationsDisabledError);
    assert.equal(service.count("/api/v1/send"), 1);
    assert.equal(service.count("/api/v1/send-preset"), 0);
    await client.me();
    assert.equal(service.count("/api/v1/me") >= 1, true);
  }
});

test("String(client) never exposes the API key", async (t) => {
  const service = await withService(t);
  const client = new Client({ apiKey: "pck_supersecret", baseUrl: service.url });

  const text = String(client);

  assert.equal(text.includes("pck_supersecret"), false);
  assert.match(text, /apiKey='\*\*\*'/);
});
