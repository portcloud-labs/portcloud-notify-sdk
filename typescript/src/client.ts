/**
 * HTTP client for the Portcloud Notify public API.
 *
 * Works on Cloudflare Workers, Node 18+, and Bun: the transport is the global `fetch`
 * (injectable for tests and Workers), there are no runtime dependencies, and `sleep`/`now`
 * are injectable so a caller can drive polling with its own timers.
 *
 * Delivery is asynchronous: `send` and `sendPreset` return an accepted `logId` before
 * delivery happens, so use `getStatus` or `waitForStatus` for the real result. POSTs are
 * never retried — the API has no idempotency key, so a lost response may already have
 * queued a notification. Failures where that is possible throw `AcceptanceUnknownError`.
 */

import {
  AcceptanceUnknownError,
  APIError,
  ConfigurationError,
  NotificationsDisabledError,
  PollTimeoutError,
  PortcloudNotifyError,
  RateLimitError,
  TransportError,
  errorFromResponse,
} from "./errors.js";
import * as models from "./models.js";
import { VERSION } from "./version.js";

/** Production site. Override with `baseUrl` or `PORTCLOUD_NOTIFY_BASE_URL`. */
export const DEFAULT_BASE_URL = "https://notify.portcloud.online";

/** Per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default poll interval for `waitForStatus`, matching the documented guidance. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Default total budget for `waitForStatus`. */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

const TITLE_MAX_LENGTH = 200;
const BODY_MAX_LENGTH = 1_048_576;
const TARGET_MAX_LENGTH = 254;
const PAGE_SIZE_MAX = 100;

const CHANNEL_TYPES = ["email", "ntfy"] as const;
const LOG_STATUSES = ["queued", "sending", "success", "failed", "rejected"] as const;
const STATS_RANGES = ["7d", "14d", "30d", "60d", "90d"] as const;
const LOG_ORDERS = ["asc", "desc"] as const;

const ORIGIN_PATTERN = /^https?:\/\/[^/?#\s\\]+\/?$/i;
const INVALID_KEY_PATTERN = /[\s\u0000-\u001f\u007f]/;

export type ChannelType = (typeof CHANNEL_TYPES)[number];
export type LogStatus = (typeof LOG_STATUSES)[number];
export type StatsRange = (typeof STATS_RANGES)[number];
export type LogOrder = (typeof LOG_ORDERS)[number];

/** Minimal `fetch` shape: the global one, a Worker binding, or a test double. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** `pck_...` API key. Defaults to `PORTCLOUD_NOTIFY_API_KEY`. */
  apiKey?: string;
  /** Site origin. Defaults to `PORTCLOUD_NOTIFY_BASE_URL`, then to production. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Set to `false` to refuse sending. `PORTCLOUD_NOTIFY_ENABLED=0` cannot be overridden. */
  enabled?: boolean;
  /** Transport override; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Timer override for `waitForStatus`; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock override for `waitForStatus`; defaults to `Date.now`. */
  now?: () => number;
  /** Environment source; defaults to `process.env` when available (absent on Workers). */
  env?: Record<string, string | undefined>;
}

export interface SendOptions {
  /** Plain-text content; required for ntfy, one of `body`/`html` for email. */
  body?: string;
  /** Custom email HTML sent verbatim. Email only. */
  html?: string;
  /** One destination the account already added; omit to use the saved defaults. */
  to?: string;
}

export interface LogsOptions {
  page?: number;
  pageSize?: number;
  status?: LogStatus;
  reason?: string;
  apiKeyId?: number;
  order?: LogOrder;
}

export interface WaitOptions {
  /** Total budget in milliseconds; `null` waits indefinitely. */
  timeoutMs?: number | null;
  /** Delay between polls in milliseconds. */
  intervalMs?: number;
}

function processEnv(): Record<string, string | undefined> {
  // Node and Bun expose `process`; Cloudflare Workers and browsers do not, and
  // TypeScript's `globalThis` type has no `process` without @types/node.
  const nodeProcess: unknown = Reflect.get(globalThis, "process");
  if (typeof nodeProcess !== "object" || nodeProcess === null) return {};
  if (!("env" in nodeProcess)) return {};
  const { env } = nodeProcess;
  if (typeof env !== "object" || env === null) return {};
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate and normalize a site origin. Returns the origin (scheme and authority only).
 * HTTPS is required unless the caller explicitly configured a loopback HTTP address for
 * local development; credentials, paths, queries, and fragments are rejected.
 */
export function normalizeBaseUrl(value?: string): string {
  if (value !== undefined && typeof value !== "string") {
    throw new ConfigurationError("baseUrl must be a string.");
  }
  const explicit = typeof value === "string" && value.length > 0;
  const raw = explicit ? value : DEFAULT_BASE_URL;
  if (!ORIGIN_PATTERN.test(raw)) {
    throw new ConfigurationError(
      "baseUrl must be a site origin without a path, query, or fragment.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("baseUrl is invalid.");
  }
  if (url.username || url.password || raw.includes("@")) {
    throw new ConfigurationError("baseUrl must not contain credentials.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(explicit && url.protocol === "http:" && loopback)) {
    throw new ConfigurationError(
      "baseUrl requires HTTPS, except explicitly configured loopback HTTP.",
    );
  }
  return url.origin;
}

/**
 * Client for the Portcloud Notify public API (`/api/v1/*`).
 *
 * Only the API key is configured locally: channels and the send preset are owned by the
 * account and managed in the console.
 */
export class Client {
  readonly baseUrl: string;
  readonly enabled: boolean;

  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: ClientOptions = {}) {
    const env = options.env ?? processEnv();
    const apiKey = options.apiKey ?? env["PORTCLOUD_NOTIFY_API_KEY"];
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new ConfigurationError(
        "An API key is required: pass apiKey or set PORTCLOUD_NOTIFY_API_KEY.",
      );
    }
    if (INVALID_KEY_PATTERN.test(apiKey)) {
      throw new ConfigurationError(
        "The API key must not contain whitespace or control characters.",
      );
    }
    this.#apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? env["PORTCLOUD_NOTIFY_BASE_URL"]);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#userAgent = `portcloud-notify-js/${VERSION}`;
    // Bind the global so a browser-style `fetch` that requires its receiver still works.
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== "function") {
      throw new ConfigurationError("No fetch implementation is available.");
    }
    this.#fetch = fetchImpl;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => Date.now());
    this.enabled = options.enabled !== false && env["PORTCLOUD_NOTIFY_ENABLED"] !== "0";
  }

  toString(): string {
    return `Client(baseUrl=${JSON.stringify(this.baseUrl)}, apiKey='***', enabled=${this.enabled})`;
  }

  // ------------------------------------------------------------------- send

  /**
   * Queue a notification (`POST /api/v1/send`). Returns the acceptance with the `logId` of
   * the first target; poll it for the real result.
   */
  async send(type: ChannelType, title: string, options: SendOptions = {}): Promise<models.SendAccepted> {
    this.requireEnabled();
    const payload = this.sendPayload(type, title, options);
    return this.request("POST", "/api/v1/send", {
      jsonBody: payload,
      send: true,
      parse: models.parseSendAccepted,
      expectedStatus: 201,
    });
  }

  /**
   * Queue the account's preset chain (`POST /api/v1/send-preset`). The account's single
   * preset owns the ordered channel chain, so only content is supplied; the returned
   * `logId` covers the whole chain.
   */
  async sendPreset(title: string, body: string): Promise<models.PresetSendAccepted> {
    this.requireEnabled();
    checkTitle(title);
    checkBody(body, "body");
    return this.request("POST", "/api/v1/send-preset", {
      jsonBody: { title, body },
      send: true,
      parse: models.parsePresetSendAccepted,
      expectedStatus: 201,
    });
  }

  /** Query one delivery (`GET /api/v1/send/{logId}`). */
  async getStatus(logId: number): Promise<models.SendStatus> {
    return this.request("GET", `/api/v1/send/${requireLogId(logId)}`, {
      parse: models.parseSendStatus,
      expectedStatus: 200,
    });
  }

  /**
   * Poll until the delivery reaches a terminal state (`success` / `failed` / `rejected`).
   * Waits out `Retry-After` on a 429 and re-queries the same id. Throws `PollTimeoutError`
   * when the budget elapses first; pass `timeoutMs: null` to poll indefinitely.
   */
  async waitForStatus(logId: number, options: WaitOptions = {}): Promise<models.SendStatus> {
    const id = requireLogId(logId);
    const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!(intervalMs > 0)) throw new RangeError("intervalMs must be greater than zero.");
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_WAIT_TIMEOUT_MS : options.timeoutMs;
    const deadline = timeoutMs === null ? undefined : this.#now() + timeoutMs;

    let last: models.SendStatus | undefined;
    for (;;) {
      try {
        last = await this.getStatus(id);
      } catch (error) {
        if (error instanceof RateLimitError) {
          await this.sleepUntil((error.retryAfter ?? 0) * 1000 || intervalMs, deadline, id, last);
          continue;
        }
        throw error;
      }
      if (models.isTerminalStatus(last.status)) return last;
      await this.sleepUntil(intervalMs, deadline, id, last);
    }
  }

  // ------------------------------------------------------------------ reads

  /** Account snapshot and Message Credits (`GET /api/v1/me`). */
  async me(): Promise<models.Limits> {
    return this.request("GET", "/api/v1/me", {
      parse: models.parseLimits,
      expectedStatus: 200,
    });
  }

  /** Verified recipient addresses (`GET /api/v1/emails`). */
  async emails(): Promise<string[]> {
    return this.request("GET", "/api/v1/emails", {
      parse: models.parseEmails,
      expectedStatus: 200,
    });
  }

  /** Query send logs (`GET /api/v1/logs`). */
  async logs(options: LogsOptions = {}): Promise<models.Page> {
    const page = options.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new RangeError("page must be an integer >= 1.");
    }
    const pageSize = options.pageSize ?? 20;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
      throw new RangeError(`pageSize must be an integer between 1 and ${PAGE_SIZE_MAX}.`);
    }
    const order = options.order ?? "desc";
    if (!LOG_ORDERS.includes(order)) {
      throw new RangeError(`order must be one of ${LOG_ORDERS.join(", ")}.`);
    }
    if (options.status !== undefined && !LOG_STATUSES.includes(options.status)) {
      throw new RangeError(`status must be one of ${LOG_STATUSES.join(", ")}.`);
    }
    if (options.apiKeyId !== undefined && !Number.isSafeInteger(options.apiKeyId)) {
      throw new RangeError("apiKeyId must be an integer.");
    }
    const params: Record<string, string | number> = {
      page,
      page_size: pageSize,
      order,
    };
    if (options.status !== undefined) params["status"] = options.status;
    if (options.reason !== undefined) params["reason"] = options.reason;
    if (options.apiKeyId !== undefined) params["api_key_id"] = options.apiKeyId;
    return this.request("GET", "/api/v1/logs", {
      params,
      parse: models.parsePage,
      expectedStatus: 200,
    });
  }

  /** Account statistics (`GET /api/v1/stats/overview`). */
  async statsOverview(range: StatsRange = "7d"): Promise<models.Overview> {
    if (!STATS_RANGES.includes(range)) {
      throw new RangeError(`range must be one of ${STATS_RANGES.join(", ")}.`);
    }
    return this.request("GET", "/api/v1/stats/overview", {
      params: { range },
      parse: models.parseOverview,
      expectedStatus: 200,
    });
  }

  // -------------------------------------------------------------- internals

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new NotificationsDisabledError(
        "Sending is disabled (PORTCLOUD_NOTIFY_ENABLED=0 or enabled: false).",
      );
    }
  }

  private sendPayload(type: ChannelType, title: string, options: SendOptions): Record<string, unknown> {
    if (!CHANNEL_TYPES.includes(type)) {
      throw new RangeError(`type must be one of ${CHANNEL_TYPES.join(", ")}.`);
    }
    checkTitle(title);
    if (options.body !== undefined) checkBody(options.body, "body");
    if (options.html !== undefined) checkBody(options.html, "html");
    if ((options.body === undefined) === (options.html === undefined)) {
      throw new RangeError("supply exactly one of body or html.");
    }
    if (options.html !== undefined && type !== "email") {
      throw new RangeError("html is only supported for type 'email'.");
    }
    const payload: Record<string, unknown> = { type, title };
    if (options.body !== undefined) payload["body"] = options.body;
    if (options.html !== undefined) payload["html"] = options.html;
    if (options.to !== undefined) {
      if (options.to.length === 0) throw new RangeError("to must be a nonempty string.");
      if (options.to.length > TARGET_MAX_LENGTH) {
        throw new RangeError(`to must be at most ${TARGET_MAX_LENGTH} characters.`);
      }
      payload["to"] = options.to;
    }
    return payload;
  }

  private async sleepUntil(
    ms: number,
    deadline: number | undefined,
    logId: number,
    last: models.SendStatus | undefined,
  ): Promise<void> {
    let delay = ms;
    if (deadline !== undefined) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        throw new PollTimeoutError(
          `Delivery ${logId} did not reach a terminal state in time.`,
          { logId, lastStatus: last?.status },
        );
      }
      delay = Math.min(delay, remaining);
    }
    await this.#sleep(delay);
  }

  private transportError(
    message: string,
    httpStatus: number | undefined,
    send: boolean,
  ): PortcloudNotifyError {
    if (send) {
      return new AcceptanceUnknownError(
        `${message} The send outcome is unknown; do not resend automatically.`,
        { httpStatus },
      );
    }
    return new TransportError(message, { httpStatus });
  }

  private httpError(status: number, raw: string, headers: Headers, send: boolean): PortcloudNotifyError {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = undefined;
    }
    const error = errorFromResponse(status, payload, headers);
    if (send && (status === 408 || status >= 500)) {
      // The service answered, but the notification may already be queued.
      return new AcceptanceUnknownError(
        `The send outcome is unknown (${error.message}); do not resend automatically.`,
        { httpStatus: status, code: error.code, details: error.details },
      );
    }
    return error;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      params?: Record<string, string | number>;
      jsonBody?: unknown;
      send?: boolean;
      parse: (payload: unknown) => T;
      expectedStatus?: number;
    },
  ): Promise<T> {
    const send = options.send ?? false;
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": this.#userAgent,
    };
    let body: string | undefined;
    if (options.jsonBody !== undefined) {
      body = JSON.stringify(options.jsonBody);
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw this.transportError(
        `Request to ${this.baseUrl} failed: ${describeError(error)}`,
        undefined,
        send,
      );
    }

    const status = response.status;
    if (status === 0 || (status >= 300 && status < 400)) {
      throw this.transportError(
        `The service answered HTTP ${status} with a redirect; it is never followed.`,
        status,
        send,
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw this.transportError(
        `Reading the response from ${this.baseUrl} failed: ${describeError(error)}`,
        status,
        send,
      );
    }
    if (status >= 400) throw this.httpError(status, raw, response.headers, send);
    if (options.expectedStatus !== undefined && status !== options.expectedStatus) {
      // A 2xx that is not the documented success status cannot be trusted as an
      // acceptance or a result.
      throw this.transportError(
        `The service answered HTTP ${status} instead of HTTP ${options.expectedStatus}.`,
        status,
        send,
      );
    }

    let payload: unknown;
    try {
      payload = raw.length === 0 ? undefined : JSON.parse(raw);
    } catch {
      throw this.transportError(
        "The service returned a response that is not valid JSON.",
        status,
        send,
      );
    }
    try {
      return options.parse(payload);
    } catch (error) {
      if (send) {
        throw new AcceptanceUnknownError(
          `The service acceptance response was invalid (${describeError(error)}); do not resend automatically.`,
          { httpStatus: status },
        );
      }
      throw this.transportError("The service returned an unexpected response body.", status, send);
    }
  }
}

function checkTitle(title: string): void {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new RangeError("title must be a nonempty string.");
  }
  if (title.length > TITLE_MAX_LENGTH) {
    throw new RangeError(`title must be at most ${TITLE_MAX_LENGTH} characters.`);
  }
  if (title.includes("\n") || title.includes("\r")) {
    throw new RangeError("title must be a single line without line breaks.");
  }
}

function checkBody(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(`${name} must be a nonempty string.`);
  }
  if (value.length > BODY_MAX_LENGTH) {
    throw new RangeError(`${name} must be at most ${BODY_MAX_LENGTH} characters.`);
  }
}

function requireLogId(logId: number): number {
  if (!Number.isSafeInteger(logId) || logId <= 0) {
    throw new RangeError("logId must be a positive integer.");
  }
  return logId;
}
