/**
 * Response-model tests for the portcloud-notify SDK: unknown fields are ignored, required
 * fields are enforced, and the shipped `VERSION` matches the package manifest. Runs
 * against the built `dist/` output.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ResponseShapeError,
  VERSION,
  parseEmails,
  parseLimits,
  parseOverview,
  parsePage,
  parsePresetSendAccepted,
  parseSendAccepted,
  parseSendLog,
  parseSendStatus,
} from "../dist/index.js";

const CREATED_AT = "2026-01-02T03:04:05.123456+00:00";

const SEND_ACCEPTED = { log_id: 1, status: "queued" };
const PRESET_ACCEPTED = { log_id: 1, status: "queued", preset_id: 2 };
const SEND_STATUS = { log_id: 1, status: "queued", created_at: CREATED_AT };
const SEND_LOG = { id: 11, status: "success", created_at: CREATED_AT };
const LIMITS = {
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
const PAGE = { items: [SEND_LOG], total: 1, page: 1, page_size: 20, pages: 1 };
const OVERVIEW = {
  range: "7d",
  bucket: "day",
  totals: { attempted: 1, success: 1, failed: 0, rejected: 0, success_rate: 1 },
  series: [{ bucket_start: "2026-01-01", success: 1, failed: 0, rejected: 0 }],
  failure_reasons: [{ reason: "smtp_timeout", count: 0 }],
  today: { attempted: 1, success: 1, failed: 0, rejected: 0, success_rate: 1 },
};

const EXPECTED_LIMITS = {
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
};

const UNKNOWN = { unknown_field: "ignored", another: { nested: [1, 2, 3] } };

test("every parser ignores unknown fields", () => {
  assert.deepEqual(parseSendAccepted({ ...SEND_ACCEPTED, ...UNKNOWN }), {
    logId: 1,
    status: "queued",
  });
  assert.deepEqual(parsePresetSendAccepted({ ...PRESET_ACCEPTED, ...UNKNOWN }), {
    logId: 1,
    presetId: 2,
    status: "queued",
  });
  assert.deepEqual(parseSendStatus({ ...SEND_STATUS, ...UNKNOWN }), {
    logId: 1,
    status: "queued",
    createdAt: CREATED_AT,
  });
  assert.deepEqual(parseSendLog({ ...SEND_LOG, ...UNKNOWN }), {
    id: 11,
    status: "success",
    createdAt: CREATED_AT,
  });
  assert.deepEqual(parseLimits({ ...LIMITS, ...UNKNOWN }), EXPECTED_LIMITS);
  assert.deepEqual(parsePage({ ...PAGE, ...UNKNOWN, items: [{ ...SEND_LOG, ...UNKNOWN }] }), {
    items: [{ id: 11, status: "success", createdAt: CREATED_AT }],
    total: 1,
    page: 1,
    pageSize: 20,
    pages: 1,
  });
  assert.deepEqual(parseOverview({ ...OVERVIEW, ...UNKNOWN }), {
    range: "7d",
    bucket: "day",
    totals: { attempted: 1, success: 1, failed: 0, rejected: 0, successRate: 1 },
    series: [{ bucketStart: "2026-01-01", success: 1, failed: 0, rejected: 0 }],
    failureReasons: [{ reason: "smtp_timeout", count: 0 }],
    today: { attempted: 1, success: 1, failed: 0, rejected: 0, successRate: 1 },
  });
  assert.deepEqual(parseEmails(["a@b.c", "d@e.f"]), ["a@b.c", "d@e.f"]);
});

test("parsers fill in the optional fields they document", () => {
  assert.deepEqual(
    parseSendStatus({
      ...SEND_STATUS,
      status: "failed",
      duration_ms: 12,
      failure_reason: "smtp_timeout",
      message_id: "<mid@example>",
      smtp_response: "451 4.4.1 timeout",
    }),
    {
      logId: 1,
      status: "failed",
      createdAt: CREATED_AT,
      durationMs: 12,
      failureReason: "smtp_timeout",
      messageId: "<mid@example>",
      smtpResponse: "451 4.4.1 timeout",
    },
  );
  assert.deepEqual(
    parseSendLog({
      ...SEND_LOG,
      api_key_id: 3,
      client_ip: "203.0.113.7",
      duration_ms: 9,
      failure_reason: "smtp_timeout",
      message_size_bytes: 512,
      recipient: "a@b.c",
      smtp_response: "250 2.0.0 OK",
      subject: "T",
    }),
    {
      id: 11,
      status: "success",
      createdAt: CREATED_AT,
      apiKeyId: 3,
      clientIp: "203.0.113.7",
      durationMs: 9,
      failureReason: "smtp_timeout",
      messageSizeBytes: 512,
      recipient: "a@b.c",
      smtpResponse: "250 2.0.0 OK",
      subject: "T",
    },
  );
  assert.deepEqual(
    parseOverview({
      ...OVERVIEW,
      today: { ...OVERVIEW.today, reset_at: "2026-01-03T00:00:00Z" },
    }).today,
    { attempted: 1, success: 1, failed: 0, rejected: 0, successRate: 1, resetAt: "2026-01-03T00:00:00Z" },
  );
});

test("parseSendStatus throws ResponseShapeError on a missing field, a wrong type, and non-objects", () => {
  assert.throws(
    () => parseSendStatus({ status: "queued", created_at: CREATED_AT }),
    ResponseShapeError,
  );
  assert.throws(
    () => parseSendStatus({ ...SEND_STATUS, status: 7 }),
    ResponseShapeError,
  );
  assert.throws(() => parseSendStatus(null), ResponseShapeError);
  assert.throws(() => parseSendStatus([]), ResponseShapeError);
  assert.throws(() => parseSendStatus("queued"), ResponseShapeError);
  assert.throws(() => parseSendStatus(42), ResponseShapeError);
});

test("parsePage throws ResponseShapeError on a missing field, a wrong type, and non-objects", () => {
  assert.throws(
    () => parsePage({ items: [], page: 1, page_size: 20, pages: 1 }),
    ResponseShapeError,
  );
  assert.throws(() => parsePage({ ...PAGE, items: {} }), ResponseShapeError);
  assert.throws(() => parsePage({ ...PAGE, total: "1" }), ResponseShapeError);
  assert.throws(() => parsePage(null), ResponseShapeError);
  assert.throws(() => parsePage([]), ResponseShapeError);
  assert.throws(() => parsePage("page"), ResponseShapeError);
});

test("parseOverview throws ResponseShapeError on a missing field, a wrong type, and non-objects", () => {
  const { totals, ...withoutTotals } = OVERVIEW;
  assert.throws(() => parseOverview(withoutTotals), ResponseShapeError);
  assert.throws(() => parseOverview({ ...OVERVIEW, series: {} }), ResponseShapeError);
  assert.throws(
    () => parseOverview({ ...OVERVIEW, totals: { ...totals, success_rate: "0.8" } }),
    ResponseShapeError,
  );
  assert.throws(() => parseOverview(null), ResponseShapeError);
  assert.throws(() => parseOverview([]), ResponseShapeError);
  assert.throws(() => parseOverview("overview"), ResponseShapeError);
});

test("parseLimits throws ResponseShapeError on a missing field, a wrong type, and non-objects", () => {
  const { is_admin, ...withoutIsAdmin } = LIMITS;
  assert.throws(() => parseLimits(withoutIsAdmin), ResponseShapeError);
  assert.throws(() => parseLimits({ ...LIMITS, is_admin: "false" }), ResponseShapeError);
  assert.throws(() => parseLimits({ ...LIMITS, credits_per_target: [] }), ResponseShapeError);
  assert.throws(() => parseLimits(null), ResponseShapeError);
  assert.throws(() => parseLimits([]), ResponseShapeError);
  assert.throws(() => parseLimits("limits"), ResponseShapeError);
});

test("parseEmails rejects anything that is not an array of strings", () => {
  assert.throws(() => parseEmails(["a@b.c", 7]), ResponseShapeError);
  assert.throws(() => parseEmails([{}]), ResponseShapeError);
  assert.throws(() => parseEmails([null]), ResponseShapeError);
  assert.throws(() => parseEmails("a@b.c"), ResponseShapeError);
  assert.throws(() => parseEmails({}), ResponseShapeError);
  assert.deepEqual(parseEmails([]), []);
});

test("VERSION matches the package manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(VERSION, manifest.version);
});
