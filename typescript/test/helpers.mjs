/**
 * Loopback mock service for the portcloud-notify SDK tests.
 *
 * Binds to 127.0.0.1 on an ephemeral port and records every request it receives, so a test
 * can assert on the exact method, path, query, headers, and parsed JSON body the client
 * produced. Answers are resolved in this order: `setHandler` (when it returns a response),
 * then `route`, then the `queued` FIFO, then a default `200 {}`.
 *
 * A response is `{ status = 200, payload, body, headers = {} }`:
 * - `payload` is JSON-encoded (and gets a JSON content type unless one was given),
 * - `body` is sent verbatim (raw string) and wins over `payload`,
 * - neither means an empty body.
 */

import http from "node:http";

function normalizeResponse(response) {
  const status = response.status ?? 200;
  const headers = { ...(response.headers ?? {}) };
  let body;
  if (response.body !== undefined) {
    body = response.body;
  } else if (response.payload !== undefined) {
    body = JSON.stringify(response.payload);
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  } else {
    body = "";
  }
  return { status, headers, body };
}

/**
 * Start the mock service. Always close it: `t.after(() => service.close())`.
 */
export async function startService() {
  /** @type {{ method: string, path: string, query: URLSearchParams, headers: object, body: unknown, raw: string }[]} */
  const requests = [];
  const queue = [];
  const routes = new Map();
  let handler;

  const resolve = (request) => {
    if (handler) {
      const answer = handler(request.method, request.path, request.query, request.body);
      if (answer !== undefined) return answer;
    }
    const routed = routes.get(`${request.method} ${request.path}`);
    if (routed !== undefined) return routed;
    if (queue.length > 0) return queue.shift();
    return { status: 200, payload: {} };
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let body = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }
      const request = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        raw,
      };
      requests.push(request);
      const { status, headers, body: text } = normalizeResponse(resolve(request));
      res.writeHead(status, headers);
      res.end(text);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port } = server.address();

  return {
    /** Site origin the client should be pointed at. */
    url: `http://127.0.0.1:${port}`,
    /** Every request received, in order. */
    requests,

    /** Queue one response for the next unmatched request (FIFO). */
    queued(response) {
      queue.push(response);
    },

    /** Answer one `method`/`path` pair with a fixed response. */
    route(method, path, response) {
      routes.set(`${method.toUpperCase()} ${path}`, response);
    },

    /** Dynamic answer: `(method, path, query, body) => response | undefined`. */
    setHandler(fn) {
      handler = fn;
    },

    /** The documented `{ error: { code, message, details } }` envelope. */
    error(status, code, message, details, headers) {
      return {
        status,
        payload: { error: { code, message, ...(details === undefined ? {} : { details }) } },
        headers: headers ?? {},
      };
    },

    /** Number of requests received, optionally only for one path. */
    count(path) {
      return path === undefined
        ? requests.length
        : requests.filter((request) => request.path === path).length;
    },

    /** Stop listening and drop keep-alive connections. */
    async close() {
      const done = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await done;
    },
  };
}
