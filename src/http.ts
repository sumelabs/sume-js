import { debuglog } from "node:util";
import { resolveApiKey, resolveBaseUrl } from "./config.js";
import {
  APIConnectionError,
  APIError,
  type ApiErrorBody,
  AuthenticationError,
  errorFromResponse,
  KEYS_URL,
  SumeError,
} from "./errors.js";
import { writeResponse } from "./files.js";
import { VERSION } from "./version.js";

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;

/** `NODE_DEBUG=sume` prints one line per API call: method, path, status, request id, attempt, time. Never the key. */
export const debug: (message: string, ...args: unknown[]) => void = debuglog("sume");

export interface TransportOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  headers?: Record<string, string> | undefined;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** `optional` sends the key when there is one (public routes). */
  auth?: "required" | "optional";
  idempotencyKey?: string | undefined;
  /** Defaults to true for GET, and for POST only with an idempotency key. */
  retry?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  requestId: string | undefined;
  headers: Headers;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 0.5 s, 1 s, 2 s, … with ±25% jitter, capped at 8 s. */
export function backoffMs(attempt: number): number {
  return Math.round(Math.min(500 * 2 ** (attempt - 1), 8000) * (0.75 + Math.random() * 0.5));
}

const withTimeout = (signal: AbortSignal | undefined, ms: number) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

const userAgent = () =>
  `sume-js/${VERSION} (${typeof process !== "undefined" ? `node ${process.versions.node}; ${process.platform} ${process.arch}` : "unknown"})`;

/**
 * HTTP for the API: the key, the `data`/`error` envelopes, request ids, and
 * retrying what is safe (reads, and submits that carry an idempotency key).
 * The key goes to the API host only, never to storage or media URLs.
 */
export class Transport {
  readonly #explicitKey: string | undefined;
  readonly #explicitBase: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Record<string, string>;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: TransportOptions = {}) {
    if (options.baseUrl !== undefined) resolveBaseUrl(options.baseUrl); // refuse a bad URL now, not at the first call
    this.#explicitKey = options.apiKey;
    this.#explicitBase = options.baseUrl;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    // The client sets these itself, per call; a stray Idempotency-Key on every call would be wrong.
    const reserved = new Set(["authorization", "idempotency-key", "content-type", "content-length", "host"]);
    this.#headers = Object.fromEntries(
      Object.entries(options.headers ?? {})
        .map(([k, v]) => [k.toLowerCase(), v] as const)
        .filter(([k]) => !reserved.has(k)),
    );
    this.sleep = options.sleep ?? sleep;
  }

  /** Resolved per call, like the key: SUME_API_BASE_URL set after import still counts. */
  get baseUrl(): string {
    return resolveBaseUrl(this.#explicitBase);
  }

  async request<T>(method: "GET" | "POST", path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const key = resolveApiKey(this.#explicitKey);
    if (!key && (options.auth ?? "required") === "required") {
      throw new AuthenticationError("No API key.", {
        hint: `Set SUME_API_KEY (or put it in ./.env, or pass apiKey). A person makes the key at ${KEYS_URL}.`,
        code: "missing_api_key",
      });
    }
    const baseUrl = this.baseUrl;
    const url = new URL(`${baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": userAgent(),
      ...this.#headers,
    };
    if (key) headers.authorization = `Bearer ${key}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const retry = options.retry ?? (method === "GET" || options.idempotencyKey !== undefined);
    const attempts = retry ? this.#maxRetries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body: body ?? null,
          signal: withTimeout(options.signal, options.timeoutMs ?? this.#timeoutMs),
        });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (attempt < attempts) {
          await this.sleep(backoffMs(attempt), options.signal);
          continue;
        }
        const reason =
          (error as Error).name === "TimeoutError"
            ? "timed out"
            : ((error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name);
        throw new APIConnectionError(`Could not reach ${url.host} (${reason}).`, {
          hint: `Check your connection, and baseUrl (now ${baseUrl}).`,
          code: "network_error",
          retryable: true,
        });
      }
      const requestId = response.headers.get("x-sume-request-id") ?? undefined;
      debug(
        "%s %s -> %d (request %s, attempt %d, %d ms)",
        method,
        path,
        response.status,
        requestId ?? "-",
        attempt,
        Date.now() - started,
      );
      const text = await response.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (response.ok) {
        if (!json || typeof json !== "object" || !("data" in json)) {
          throw new APIError(`Unexpected response from ${method} ${path} (${response.status}).`, {
            code: "unexpected_response",
            status: response.status,
            requestId,
          });
        }
        return { data: (json as { data: T }).data, status: response.status, requestId, headers: response.headers };
      }
      const raw = (json as { error?: ApiErrorBody } | undefined)?.error;
      const errorBody: ApiErrorBody =
        raw && typeof raw.code === "string"
          ? raw
          : {
              code: `http_${response.status}`,
              message: text.trim()
                ? `The API answered ${response.status}: ${text.trim().slice(0, 200)}`
                : `The API answered ${response.status}.`,
            };
      const failure = errorFromResponse(response.status, errorBody, requestId, baseUrl);
      if (
        attempt < attempts &&
        RETRY_STATUSES.has(response.status) &&
        failure.code !== "concurrency_limit_reached" &&
        failure.code !== "queue_full"
      ) {
        const header = Number(response.headers.get("retry-after"));
        const seconds = Number.isFinite(header) && header > 0 ? header : failure.retryAfterSeconds;
        await this.sleep(seconds ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : backoffMs(attempt), options.signal);
        continue;
      }
      throw failure;
    }
  }

  /** PUT bytes to a presigned storage URL. The API key is never sent there. */
  async put(url: string, data: Uint8Array, headers: Record<string, string>, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "PUT",
        headers,
        body: data as Uint8Array<ArrayBuffer>,
        signal: withTimeout(signal, TRANSFER_TIMEOUT_MS),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new APIConnectionError(
        `Uploading failed: ${(error as Error).name === "TimeoutError" ? "timed out" : "the connection failed"}.`,
        { hint: "Check your connection and try again.", code: "network_error", retryable: true },
      );
    }
    if (!response.ok) {
      throw new APIError(`Uploading failed: storage answered ${response.status}.`, {
        hint: "Upload URLs expire quickly; try again.",
        code: "upload_failed",
        retryable: true,
      });
    }
  }

  /** Download `url` to `path` (through a `.part` file), retrying a failed transfer. */
  async download(url: string, path: string, signal?: AbortSignal, attempts = 3): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.#fetch(url, {
          headers: { "user-agent": userAgent() },
          redirect: "follow",
          signal: withTimeout(signal, TRANSFER_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw Object.assign(new Error(`HTTP ${response.status}`), {
            retryable: response.status === 429 || response.status >= 500,
          });
        }
        return await writeResponse(response, path);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const retryable = (error as { retryable?: boolean }).retryable ?? true;
        if (attempt < attempts && retryable) {
          await this.sleep(backoffMs(attempt), signal);
          continue;
        }
        const name = new URL(url).pathname.split("/").pop() || url;
        throw new SumeError(`Could not download ${name} (${(error as Error).message}).`, {
          hint: `The file is still at ${url}`,
          code: "download_failed",
          retryable: true,
        });
      }
    }
  }

  async read(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.#fetch(url, {
      headers: { "user-agent": userAgent() },
      redirect: "follow",
      signal: withTimeout(signal, TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new SumeError(`Could not download ${url} (HTTP ${response.status}).`, { code: "download_failed" });
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
