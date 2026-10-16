/**
 * JavaScript/TypeScript SDK for the Portcloud Notify public HTTP API.
 *
 * ```ts
 * import { Client } from "portcloud-notify";
 *
 * const client = new Client(); // reads PORTCLOUD_NOTIFY_API_KEY
 * const accepted = await client.sendPreset("Deploy done", "Service is live.");
 * const status = await client.waitForStatus(accepted.logId);
 * console.log(status.status, status.failureReason);
 * ```
 *
 * Delivery is asynchronous: acceptance returns a `logId` before the message is delivered,
 * and a successful acceptance is not proof of delivery. POSTs are never retried
 * automatically because the API provides no idempotency key.
 */

export {
  Client,
  DEFAULT_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  normalizeBaseUrl,
} from "./client.js";
export type {
  ChannelType,
  ClientOptions,
  FetchLike,
  LogOrder,
  LogsOptions,
  LogStatus,
  SendOptions,
  StatsRange,
  WaitOptions,
} from "./client.js";
export {
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
  errorFromResponse,
} from "./errors.js";
export type { APIErrorOptions, AcceptanceUnknownErrorOptions, TransportErrorOptions } from "./errors.js";
export {
  ResponseShapeError,
  TERMINAL_STATUSES,
  isTerminalStatus,
  parseEmails,
  parseLimits,
  parseOverview,
  parsePage,
  parsePresetSendAccepted,
  parseSendAccepted,
  parseSendLog,
  parseSendStatus,
} from "./models.js";
export type {
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
} from "./models.js";
export { VERSION } from "./version.js";
