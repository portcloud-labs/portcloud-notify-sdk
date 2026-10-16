/**
 * Response models for the Portcloud Notify public API.
 *
 * Plain data interfaces plus explicit parsers: the parsers accept the documented JSON
 * shape, ignore unknown fields so a service that adds a field does not break callers, and
 * throw `ResponseShapeError` when a required field is missing or has the wrong type.
 * Timestamps stay ISO 8601 strings exactly as the service returned them.
 */

/** Thrown by a parser when the service response does not match the documented shape. */
export class ResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseShapeError";
  }
}

export interface SendAccepted {
  logId: number;
  status: string;
}

export interface PresetSendAccepted {
  logId: number;
  presetId: number;
  status: string;
}

export interface SendStatus {
  logId: number;
  /** `queued` / `sending` (in flight) or `success` / `failed` / `rejected` (terminal). */
  status: string;
  createdAt: string;
  durationMs?: number;
  failureReason?: string;
  messageId?: string;
  smtpResponse?: string;
}

export interface Limits {
  dailyMessageCredits: number;
  messageCreditsUsed: number;
  messageCreditsReserved: number;
  messageCreditsRemaining: number;
  creditsPerEmail: number;
  creditsPerNtfy: number;
  /** Credits per successful target keyed by channel type; 0 means the type is disabled. */
  creditsPerTarget: Record<string, number>;
  dailyResetAt: string;
  minuteAttemptLimit: number;
  dailyAttemptLimit: number;
  dailyAttemptUsed: number;
  maxVerifiedEmails: number;
  maxNtfyChannels: number;
  maxApiKeys: number;
  maxMessageSizeBytes: number;
  isAdmin: boolean;
}

export interface SendLog {
  id: number;
  status: string;
  createdAt: string;
  apiKeyId?: number;
  clientIp?: string;
  durationMs?: number;
  failureReason?: string;
  messageSizeBytes?: number;
  recipient?: string;
  smtpResponse?: string;
  subject?: string;
}

export interface Page {
  items: SendLog[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface SeriesPoint {
  bucketStart: string;
  success: number;
  failed: number;
  rejected: number;
}

export interface TodayStats {
  attempted: number;
  success: number;
  failed: number;
  rejected: number;
  successRate: number;
  resetAt?: string;
}

export interface Totals {
  attempted: number;
  success: number;
  failed: number;
  rejected: number;
  successRate: number;
}

export interface FailureReasonCount {
  reason: string;
  count: number;
}

export interface Overview {
  range: string;
  bucket: string;
  totals: Totals;
  series: SeriesPoint[];
  failureReasons: FailureReasonCount[];
  today: TodayStats;
}

/** Delivery states that end polling: the result will not change again. */
export const TERMINAL_STATUSES: Record<string, true> = {
  success: true,
  failed: true,
  rejected: true,
};

/** Whether a delivery status is terminal (stop polling). */
export function isTerminalStatus(status: string): boolean {
  return Object.hasOwn(TERMINAL_STATUSES, status);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponseShapeError(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireInt(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ResponseShapeError(`${what}.${key} must be an integer.`);
  }
  return value;
}

function optionalInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function requireString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new ResponseShapeError(`${what}.${key} must be a string.`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function requireNumber(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResponseShapeError(`${what}.${key} must be a number.`);
  }
  return value;
}

function requireBoolean(source: Record<string, unknown>, key: string, what: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    throw new ResponseShapeError(`${what}.${key} must be a boolean.`);
  }
  return value;
}

/** A positive log id, as returned at acceptance. */
function requireLogId(source: Record<string, unknown>, what: string): number {
  const logId = requireInt(source, "log_id", what);
  if (logId <= 0) {
    throw new ResponseShapeError(`${what}.log_id must be a positive integer.`);
  }
  return logId;
}

export function parseSendAccepted(payload: unknown): SendAccepted {
  const source = asRecord(payload, "SendAccepted");
  const logId = requireLogId(source, "SendAccepted");
  const status = source["status"] ?? "queued";
  if (status !== "queued") {
    throw new ResponseShapeError(`SendAccepted.status must be "queued".`);
  }
  return { logId, status };
}

export function parsePresetSendAccepted(payload: unknown): PresetSendAccepted {
  const source = asRecord(payload, "PresetSendAccepted");
  const accepted = parseSendAccepted(source);
  const presetId = requireInt(source, "preset_id", "PresetSendAccepted");
  if (presetId <= 0) {
    throw new ResponseShapeError("PresetSendAccepted.preset_id must be a positive integer.");
  }
  return { ...accepted, presetId };
}

export function parseSendStatus(payload: unknown): SendStatus {
  const source = asRecord(payload, "SendStatus");
  const status: SendStatus = {
    logId: requireInt(source, "log_id", "SendStatus"),
    status: requireString(source, "status", "SendStatus"),
    createdAt: requireString(source, "created_at", "SendStatus"),
  };
  const durationMs = optionalInt(source, "duration_ms");
  if (durationMs !== undefined) status.durationMs = durationMs;
  const failureReason = optionalString(source, "failure_reason");
  if (failureReason !== undefined) status.failureReason = failureReason;
  const messageId = optionalString(source, "message_id");
  if (messageId !== undefined) status.messageId = messageId;
  const smtpResponse = optionalString(source, "smtp_response");
  if (smtpResponse !== undefined) status.smtpResponse = smtpResponse;
  return status;
}

export function parseLimits(payload: unknown): Limits {
  const source = asRecord(payload, "Limits");
  const rawTargets = asRecord(source["credits_per_target"], "Limits.credits_per_target");
  const creditsPerTarget: Record<string, number> = {};
  for (const [type, cost] of Object.entries(rawTargets)) {
    if (typeof cost === "number" && Number.isSafeInteger(cost)) creditsPerTarget[type] = cost;
  }
  return {
    dailyMessageCredits: requireInt(source, "daily_message_credits", "Limits"),
    messageCreditsUsed: requireInt(source, "message_credits_used", "Limits"),
    messageCreditsReserved: requireInt(source, "message_credits_reserved", "Limits"),
    messageCreditsRemaining: requireInt(source, "message_credits_remaining", "Limits"),
    creditsPerEmail: requireInt(source, "credits_per_email", "Limits"),
    creditsPerNtfy: requireInt(source, "credits_per_ntfy", "Limits"),
    creditsPerTarget,
    dailyResetAt: requireString(source, "daily_reset_at", "Limits"),
    minuteAttemptLimit: requireInt(source, "minute_attempt_limit", "Limits"),
    dailyAttemptLimit: requireInt(source, "daily_attempt_limit", "Limits"),
    dailyAttemptUsed: requireInt(source, "daily_attempt_used", "Limits"),
    maxVerifiedEmails: requireInt(source, "max_verified_emails", "Limits"),
    maxNtfyChannels: requireInt(source, "max_ntfy_channels", "Limits"),
    maxApiKeys: requireInt(source, "max_api_keys", "Limits"),
    maxMessageSizeBytes: requireInt(source, "max_message_size_bytes", "Limits"),
    isAdmin: requireBoolean(source, "is_admin", "Limits"),
  };
}

export function parseEmails(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    throw new ResponseShapeError("Emails must be a JSON array of strings.");
  }
  const emails: string[] = [];
  for (const item of payload) {
    if (typeof item !== "string") {
      throw new ResponseShapeError("Emails must be a JSON array of strings.");
    }
    emails.push(item);
  }
  return emails;
}

export function parseSendLog(payload: unknown): SendLog {
  const source = asRecord(payload, "SendLog");
  const log: SendLog = {
    id: requireInt(source, "id", "SendLog"),
    status: requireString(source, "status", "SendLog"),
    createdAt: requireString(source, "created_at", "SendLog"),
  };
  const apiKeyId = optionalInt(source, "api_key_id");
  if (apiKeyId !== undefined) log.apiKeyId = apiKeyId;
  const clientIp = optionalString(source, "client_ip");
  if (clientIp !== undefined) log.clientIp = clientIp;
  const durationMs = optionalInt(source, "duration_ms");
  if (durationMs !== undefined) log.durationMs = durationMs;
  const failureReason = optionalString(source, "failure_reason");
  if (failureReason !== undefined) log.failureReason = failureReason;
  const messageSizeBytes = optionalInt(source, "message_size_bytes");
  if (messageSizeBytes !== undefined) log.messageSizeBytes = messageSizeBytes;
  const recipient = optionalString(source, "recipient");
  if (recipient !== undefined) log.recipient = recipient;
  const smtpResponse = optionalString(source, "smtp_response");
  if (smtpResponse !== undefined) log.smtpResponse = smtpResponse;
  const subject = optionalString(source, "subject");
  if (subject !== undefined) log.subject = subject;
  return log;
}

export function parsePage(payload: unknown): Page {
  const source = asRecord(payload, "Page");
  const rawItems = source["items"];
  if (!Array.isArray(rawItems)) {
    throw new ResponseShapeError("Page.items must be a JSON array.");
  }
  return {
    items: rawItems.map(parseSendLog),
    total: requireInt(source, "total", "Page"),
    page: requireInt(source, "page", "Page"),
    pageSize: requireInt(source, "page_size", "Page"),
    pages: requireInt(source, "pages", "Page"),
  };
}

function parseSeriesPoint(payload: unknown): SeriesPoint {
  const source = asRecord(payload, "SeriesPoint");
  return {
    bucketStart: requireString(source, "bucket_start", "SeriesPoint"),
    success: requireInt(source, "success", "SeriesPoint"),
    failed: requireInt(source, "failed", "SeriesPoint"),
    rejected: requireInt(source, "rejected", "SeriesPoint"),
  };
}

function parseTodayStats(payload: unknown): TodayStats {
  const source = asRecord(payload, "TodayStats");
  const today: TodayStats = {
    attempted: requireInt(source, "attempted", "TodayStats"),
    success: requireInt(source, "success", "TodayStats"),
    failed: requireInt(source, "failed", "TodayStats"),
    rejected: requireInt(source, "rejected", "TodayStats"),
    successRate: requireNumber(source, "success_rate", "TodayStats"),
  };
  const resetAt = optionalString(source, "reset_at");
  if (resetAt !== undefined) today.resetAt = resetAt;
  return today;
}

function parseTotals(payload: unknown): Totals {
  const source = asRecord(payload, "Totals");
  return {
    attempted: requireInt(source, "attempted", "Totals"),
    success: requireInt(source, "success", "Totals"),
    failed: requireInt(source, "failed", "Totals"),
    rejected: requireInt(source, "rejected", "Totals"),
    successRate: requireNumber(source, "success_rate", "Totals"),
  };
}

function parseFailureReasonCount(payload: unknown): FailureReasonCount {
  const source = asRecord(payload, "FailureReasonCount");
  return {
    reason: requireString(source, "reason", "FailureReasonCount"),
    count: requireInt(source, "count", "FailureReasonCount"),
  };
}

export function parseOverview(payload: unknown): Overview {
  const source = asRecord(payload, "Overview");
  const rawSeries = source["series"];
  const rawReasons = source["failure_reasons"];
  if (!Array.isArray(rawSeries) || !Array.isArray(rawReasons)) {
    throw new ResponseShapeError("Overview.series and Overview.failure_reasons must be arrays.");
  }
  return {
    range: requireString(source, "range", "Overview"),
    bucket: requireString(source, "bucket", "Overview"),
    totals: parseTotals(source["totals"]),
    series: rawSeries.map(parseSeriesPoint),
    failureReasons: rawReasons.map(parseFailureReasonCount),
    today: parseTodayStats(source["today"]),
  };
}
