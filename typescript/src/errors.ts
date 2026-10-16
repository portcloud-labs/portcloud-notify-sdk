/**
 * Exceptions raised by the Portcloud Notify SDK.
 *
 * Every failure is a `PortcloudNotifyError`. Callers can branch on the class, on
 * `APIError.code` (the stable service error code, e.g. `NO_PRESET`), or on
 * `APIError.httpStatus`; the service documents that the machine-readable `code` is the
 * contract and the human message is not.
 */

const RETRY_AFTER_PATTERN = /^\d{1,9}$/;
const RESET_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Base class for every error raised by this SDK. */
export class PortcloudNotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Local configuration is missing or invalid. No request was sent. */
export class ConfigurationError extends PortcloudNotifyError {}

/** Sending is disabled by `PORTCLOUD_NOTIFY_ENABLED=0` or `enabled: false`. */
export class NotificationsDisabledError extends PortcloudNotifyError {}

export interface TransportErrorOptions {
  httpStatus?: number;
  /**
   * `true` when the request was a send POST that the service may still have queued
   * (timeout, dropped connection, a 5xx or 408 answer, a redirect, an unexpected success
   * status, or an unparsable acceptance body). Never resend automatically while `true`.
   */
  outcomeUnknown?: boolean;
}

/** The request produced no usable response. */
export class TransportError extends PortcloudNotifyError {
  readonly httpStatus: number | undefined;
  readonly outcomeUnknown: boolean;

  constructor(message: string, options: TransportErrorOptions = {}) {
    super(message);
    this.httpStatus = options.httpStatus;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export interface AcceptanceUnknownErrorOptions {
  httpStatus?: number;
  /** Service error code when an error envelope was received (e.g. `DEPENDENCY_UNAVAILABLE`). */
  code?: string;
  details?: Record<string, unknown>;
}

/** A send POST may have been queued; check the logs before resending. */
export class AcceptanceUnknownError extends TransportError {
  readonly code: string | undefined;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: AcceptanceUnknownErrorOptions = {}) {
    super(message, { httpStatus: options.httpStatus, outcomeUnknown: true });
    this.code = options.code;
    this.details = options.details ?? {};
  }
}

/** `waitForStatus` gave up before the delivery reached a terminal state. */
export class PollTimeoutError extends PortcloudNotifyError {
  readonly logId: number | undefined;
  readonly lastStatus: string | undefined;

  constructor(
    message: string,
    options: { logId?: number; lastStatus?: string } = {},
  ) {
    super(message);
    this.logId = options.logId;
    this.lastStatus = options.lastStatus;
  }
}

export interface APIErrorOptions {
  /** HTTP status code of the response. */
  httpStatus: number;
  /**
   * Stable machine-readable error code (`VALIDATION_ERROR`, `NO_PRESET`, `RATE_LIMITED`,
   * ...). `HTTP_<status>` when the response carried no parsable envelope.
   */
  code: string;
  /** Human-readable service message; not part of the stable contract. */
  serviceMessage: string;
  details?: Record<string, unknown>;
  /** Seconds to wait, from the `Retry-After` header or `details.retry_after` (429). */
  retryAfter?: number;
  /** `details.reset_at` ISO 8601 timestamp (credits or attempt exhaustion). */
  resetAt?: string;
}

/** The service answered with its documented `{ error: { ... } }` envelope. */
export class APIError extends PortcloudNotifyError {
  readonly httpStatus: number;
  readonly code: string;
  readonly serviceMessage: string;
  readonly details: Record<string, unknown>;
  readonly retryAfter: number | undefined;
  readonly resetAt: string | undefined;

  constructor(options: APIErrorOptions) {
    super(`${options.code} (HTTP ${options.httpStatus}): ${options.serviceMessage}`);
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.serviceMessage = options.serviceMessage;
    this.details = options.details ?? {};
    this.retryAfter = options.retryAfter;
    this.resetAt = options.resetAt;
  }
}

/** HTTP 400/422: the request was rejected before any delivery was queued. */
export class ValidationError extends APIError {}

/** HTTP 401: API key missing, invalid, or expired. */
export class AuthenticationError extends APIError {}

/** HTTP 403: account disabled or Star eligibility refusal. */
export class AuthorizationError extends APIError {}

/** HTTP 404: unknown `logId` or a target not owned by the account. */
export class NotFoundError extends APIError {}

/** HTTP 413: message or request body too large. */
export class PayloadTooLargeError extends APIError {}

/** HTTP 429: rate, Message Credits, or daily attempt limit reached. */
export class RateLimitError extends APIError {}

/** HTTP 5xx: service-side failure. A send may have been queued. */
export class ServerError extends APIError {}

const ERROR_CLASS_BY_STATUS: Record<number, new (options: APIErrorOptions) => APIError> = {
  400: ValidationError,
  401: AuthenticationError,
  403: AuthorizationError,
  404: NotFoundError,
  413: PayloadTooLargeError,
  422: ValidationError,
  429: RateLimitError,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function headerValue(headers: Headers | undefined, name: string): string | null {
  if (!headers || typeof headers.get !== "function") return null;
  return headers.get(name);
}

/**
 * Build the mapped `APIError` from an error response. Unknown fields and unparsable bodies
 * degrade gracefully: the HTTP status is always reported, the envelope is used when it has
 * the documented shape.
 */
export function errorFromResponse(
  httpStatus: number,
  payload: unknown,
  headers?: Headers,
): APIError {
  let code: string | undefined;
  let serviceMessage: string | undefined;
  let details: Record<string, unknown> = {};

  const envelope = asRecord(asRecord(payload)?.["error"]);
  if (envelope) {
    const rawCode = envelope["code"];
    if (typeof rawCode === "string" && rawCode.length > 0) code = rawCode;
    const rawMessage = envelope["message"];
    if (typeof rawMessage === "string" && rawMessage.length > 0) serviceMessage = rawMessage;
    const rawDetails = asRecord(envelope["details"]);
    if (rawDetails) details = rawDetails;
  }

  let retryAfter: number | undefined;
  const header = headerValue(headers, "retry-after");
  if (header !== null && RETRY_AFTER_PATTERN.test(header) && Number(header) > 0) {
    retryAfter = Number(header);
  }
  if (retryAfter === undefined) {
    const candidate = details["retry_after"];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) {
      retryAfter = candidate;
    }
  }

  let resetAt: string | undefined;
  const candidateReset = details["reset_at"];
  if (typeof candidateReset === "string" && RESET_AT_PATTERN.test(candidateReset)) {
    resetAt = candidateReset;
  }

  const ErrorClass = httpStatus >= 500 ? ServerError : (ERROR_CLASS_BY_STATUS[httpStatus] ?? APIError);
  return new ErrorClass({
    httpStatus,
    code: code ?? `HTTP_${httpStatus}`,
    serviceMessage: serviceMessage ?? "The service returned an error response.",
    details,
    retryAfter,
    resetAt,
  });
}
