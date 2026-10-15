/** Every error the client throws. Each says what went wrong and, in `hint`, what to do. */

export const DEFAULT_BASE_URL = "https://api.open.sume.com";
export const KEYS_URL = "https://open.sume.com/api-keys";
export const BILLING_URL = "https://open.sume.com/billing";
export const DOCS_URL = "https://open.sume.com/docs";
/** sume.com's own API. Open keys and Open models are not there. */
export const WRONG_HOST = "api.sume.com";

export interface SumeErrorOptions {
  hint?: string | undefined;
  code?: string;
  status?: number | undefined;
  requestId?: string | undefined;
  retryable?: boolean;
  details?: unknown;
  jobId?: string | undefined;
  idempotencyKey?: string | undefined;
  retryAfterSeconds?: number | undefined;
  fieldErrors?: FieldError[] | undefined;
}

/** One field the API refused, like `{ path: "duration", message: "must be between 4 and 15" }`. */
export interface FieldError {
  /** The field, as the API names it (`duration`, `image_urls[0]`). Empty for the request as a whole. */
  path: string;
  message: string;
}

/**
 * The base class. `message` is what went wrong, then the fix on its own line,
 * so a stack trace alone tells you what to do.
 */
export class SumeError extends Error {
  /** What to do about it, when there is something to do. */
  hint: string | undefined;
  /** A stable machine-readable code, like `insufficient_funds`. */
  readonly code: string;
  /** The HTTP status, for errors the API returned. */
  readonly status: number | undefined;
  /** The API's request id; quote it to support. */
  readonly requestId: string | undefined;
  /** Whether the same call may succeed if you try again. */
  readonly retryable: boolean;
  /** The API's structured details, when it sent any. */
  readonly details: unknown;
  /** The job this error is about, when there is one. */
  readonly jobId: string | undefined;
  /** The key a failed submit carried. Pass it back as `idempotencyKey` to get that job instead of paying again. */
  idempotencyKey: string | undefined;
  /** Seconds the API asked to wait before retrying, when it said. */
  readonly retryAfterSeconds: number | undefined;
  /** Each field the API refused, for a request it rejected. Empty otherwise. */
  readonly fieldErrors: FieldError[];
  /** What went wrong, without the request id or the fix. */
  readonly reason: string;

  constructor(reason: string, options: SumeErrorOptions = {}) {
    super(reason);
    this.name = new.target.name;
    this.reason = reason;
    this.hint = options.hint;
    this.code = options.code ?? "error";
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.jobId = options.jobId;
    this.idempotencyKey = options.idempotencyKey;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fieldErrors = options.fieldErrors ?? [];
    this.message = this.compose();
  }

  /** Rebuild `message` after `hint` changes. */
  compose(): string {
    let line = this.reason;
    if (this.requestId) line += ` (request ${this.requestId})`;
    for (const field of this.fieldErrors ?? []) line += `\n  - ${field.path ? `${field.path}: ` : ""}${field.message}`;
    if (this.hint) line += `\nFix: ${this.hint}`;
    return line;
  }
}

/** No key, a wrong or revoked key, or a call the key may not make. */
export class AuthenticationError extends SumeError {}
/** The open.sume.com balance is lower than the price. Nothing was charged. */
export class InsufficientFundsError extends SumeError {}
/** The price is over `maxUsd`. Nothing was submitted. */
export class OverBudgetError extends SumeError {}
/** The API refused the request: a field is missing, wrong, or not taken by this model. */
export class InvalidRequestError extends SumeError {}
/** No such model or job. */
export class NotFoundError extends InvalidRequestError {}
/** Too many requests, or as many jobs in flight as the account may run. */
export class RateLimitError extends SumeError {}
/** The job failed or was canceled. Failed jobs are refunded. */
export class JobFailedError extends SumeError {}
/** Stopped waiting. The job is still running on Sume; pick it up with `result(jobId)`. */
export class WaitTimeoutError extends SumeError {}
/** Something went wrong on Sume's side. */
export class APIError extends SumeError {}
/** The API could not be reached. */
export class APIConnectionError extends SumeError {}

export interface ApiErrorBody {
  code?: string;
  message?: string;
  request_id?: string;
  retryable?: boolean;
  retry_after_seconds?: number | null;
  details?: unknown;
}

function otherHostHint(baseUrl: string): string {
  const host = baseUrl.replace(/^[a-z]+:\/\//u, "").split("/")[0];
  if (host === WRONG_HOST) return `${WRONG_HOST} is sume.com's API, not Open's. Use ${DEFAULT_BASE_URL} (the default).`;
  if (baseUrl !== DEFAULT_BASE_URL) {
    return `This client calls ${baseUrl}. A key works only on the API it was made for; keys from ${KEYS_URL} are for ${DEFAULT_BASE_URL}.`;
  }
  return `The key is wrong or revoked. Make a new one at ${KEYS_URL}.`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The API's `details.errors[]`, one entry per refused field. */
export function fieldErrors(details: unknown): FieldError[] {
  const errors = isRecord(details) ? details.errors : undefined;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((entry) =>
    isRecord(entry) && typeof entry.message === "string"
      ? [{ path: typeof entry.path === "string" ? entry.path : "", message: entry.message }]
      : [],
  );
}

/** Turn the API's `error` envelope into the error class that says what to do. */
export function errorFromResponse(
  status: number,
  body: ApiErrorBody,
  requestId: string | undefined,
  baseUrl: string,
): SumeError {
  const code = body.code ?? `http_${status}`;
  const message = body.message ?? `The API answered ${status}.`;
  const details = body.details;
  const retryAfter = typeof body.retry_after_seconds === "number" ? body.retry_after_seconds : undefined;
  const common: SumeErrorOptions = {
    code,
    status,
    requestId: body.request_id ?? requestId,
    retryable: body.retryable ?? (status === 429 || status >= 500),
    details,
    retryAfterSeconds: retryAfter && retryAfter > 0 ? retryAfter : undefined,
  };
  const fields = fieldErrors(details);
  if (fields.length > 0) common.fieldErrors = fields;

  // A provider can refuse a job the moment it is submitted: the API answers
  // with the job already failed. That is a failed job (refunded), not a bad request.
  const job = isRecord(details) ? details.job : undefined;
  if (isRecord(job) && (job.status === "failed" || job.status === "canceled") && typeof job.id === "string") {
    const reason = isRecord(job.error) && typeof job.error.message === "string" ? job.error.message : message;
    return new JobFailedError(`Job ${job.id} ${job.status}: ${reason}`, {
      ...common,
      retryable: false,
      jobId: job.id,
      hint: "Failed jobs are refunded. Change the input, or try another model.",
    });
  }

  const detail = isRecord(details) ? details : {};
  if (code === "unauthorized" || status === 401) {
    return new AuthenticationError(message, { ...common, hint: otherHostHint(baseUrl) });
  }
  if (code === "open_key_route_not_allowed") {
    return new AuthenticationError(message, {
      ...common,
      hint: "open.sume.com keys call models, prices, images, video and jobs only.",
    });
  }
  if (code === "api_key_not_accepted" || code === "session_not_accepted") {
    const publicUrl = detail.public_api_base_url;
    return new AuthenticationError(message, {
      ...common,
      hint:
        typeof publicUrl === "string"
          ? `Send keys to the public API: baseUrl: "${publicUrl}".`
          : otherHostHint(baseUrl),
    });
  }
  if (status === 403) return new AuthenticationError(message, { ...common, hint: otherHostHint(baseUrl) });
  if (code === "insufficient_funds" || status === 402) {
    const need = detail.required_usd;
    const have = detail.available_usd;
    const amounts =
      typeof need === "string" && typeof have === "string" ? ` It needs $${need}; the balance is $${have}.` : "";
    return new InsufficientFundsError(message, { ...common, hint: `Top up at ${BILLING_URL}.${amounts}` });
  }
  if (code === "concurrency_limit_reached" || code === "queue_full") {
    return new RateLimitError(message, {
      ...common,
      hint: "The account has as many jobs in flight as it may. Wait for one to finish, then submit again.",
    });
  }
  if (status === 429) return new RateLimitError(message, { ...common, hint: "Slow down, then retry after a moment." });
  if (code === "model_not_found")
    return new NotFoundError(message, { ...common, hint: "List the models with models()." });
  if (code === "job_not_found" || code === "not_found" || status === 404) {
    return new NotFoundError(message, {
      ...common,
      hint: "Check the id; jobs belong to the account whose key made them.",
    });
  }
  if (code === "job_not_cancelable" || code === "job_generation_already_started") {
    return new InvalidRequestError(message, {
      ...common,
      hint: "Generation has started; the job will finish or fail on its own. Failed jobs are refunded.",
    });
  }
  if (code === "job_not_completed") {
    return new InvalidRequestError(message, {
      ...common,
      hint: "The job has not finished. Wait for it with result(jobId).",
    });
  }
  if (code === "idempotency_conflict") {
    return new InvalidRequestError(message, {
      ...common,
      hint: "That idempotency key belongs to a different request. Use a new key.",
    });
  }
  if (status >= 400 && status < 500) {
    return new InvalidRequestError(message, {
      ...common,
      hint: "Check the model's fields and limits with model(id).",
    });
  }
  return new APIError(message, {
    ...common,
    hint:
      body.retryable === false
        ? "This is on Sume's side, and the same request will fail again. Quote the request id to support."
        : "This is on Sume's side. Retry; quote the request id if it persists.",
  });
}
