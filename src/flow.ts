import {
  type FieldError,
  JobFailedError,
  NotFoundError,
  OverBudgetError,
  RateLimitError,
  SumeError,
  WaitTimeoutError,
} from "./errors.js";
import { describe, uploadSlots, withUploads } from "./inputs.js";
import type { Price, Status } from "./types.js";

/** How long `run` and `wait` wait by default: 30 minutes. Video can take 10 or more. */
export const DEFAULT_WAIT_MS = 30 * 60_000;

/**
 * The longest gap between status reads, by how long the wait has run. The
 * API's `next_poll_after_seconds` can ask for 30 s while a job runs, but an
 * image often finishes in 15; following it blindly doubles the wait. Shorter
 * hints are always honored.
 */
export function maxDelaySeconds(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 5;
  if (elapsedMs < 600_000) return 10;
  return 15;
}

export function nextDelayMs(status: Status, headers: Headers, elapsedMs: number): number {
  const header = Number(headers.get("x-sume-poll-after"));
  const recommended = status.raw.recommended_poll_interval_seconds;
  const hint =
    status.nextPollAfterSeconds ??
    (Number.isFinite(header) && header > 0 ? header : typeof recommended === "number" ? recommended : null);
  const seconds = hint !== null && hint > 0 ? hint : 2;
  return Math.min(Math.max(seconds, 1), maxDelaySeconds(elapsedMs)) * 1000;
}

export function firstDelayMs(submit: Record<string, unknown>): number {
  if (submit.terminal) return 0;
  const hint = submit.next_poll_after_seconds;
  return typeof hint === "number" ? Math.min(Math.max(hint, 0), maxDelaySeconds(0)) * 1000 : 0;
}

export function timeoutError(jobId: string, timeoutMs: number, canceled = false): WaitTimeoutError {
  if (canceled) {
    return new WaitTimeoutError(
      `Stopped waiting after ${Math.round(timeoutMs / 1000)} s, and canceled job ${jobId} before it started. It is refunded.`,
      { hint: "Raise timeoutMs, or submit when the queue is shorter.", code: "wait_timeout", jobId },
    );
  }
  return new WaitTimeoutError(
    `Stopped waiting after ${Math.round(timeoutMs / 1000)} s; job ${jobId} is still running.`,
    {
      hint: `Pick it up later with result("${jobId}"). Do not submit again: a second submit is a second charge.`,
      code: "wait_timeout",
      jobId,
    },
  );
}

/** How long `submit` waits for a free slot when the account has as many jobs running as it may. */
export const SLOT_WAIT_MS = 10 * 60_000;

/** The account is at its limit of running jobs: wait for a slot, then submit again. */
export const isFull = (error: unknown): error is RateLimitError => error instanceof RateLimitError;

/** How long to wait before asking for a slot again: the API's word, else 2, 4, 8, … up to 15 s. */
export function slotDelayMs(error: SumeError, attempt: number): number {
  if (error.retryAfterSeconds) return Math.min(error.retryAfterSeconds, 30) * 1000;
  return Math.min(2 ** attempt, 15) * 1000;
}

export function failure(jobId: string, state: string, job: Record<string, unknown> | undefined): JobFailedError {
  if (state === "canceled") {
    return new JobFailedError(`Job ${jobId} was canceled.`, {
      hint: "Canceled jobs are refunded.",
      code: "job_canceled",
      jobId,
    });
  }
  const error = (job?.error ?? {}) as Record<string, unknown>;
  const reason = [error.message, error.public_reason, error.code].find((v) => typeof v === "string") as
    | string
    | undefined;
  return new JobFailedError(`Job ${jobId} failed: ${reason ?? "the provider gave no reason"}.`, {
    hint: "Failed jobs are refunded. Change the input, or try another model.",
    code: typeof error.code === "string" ? error.code : "job_failed",
    jobId,
    retryable: error.retryable === true,
  });
}

export function checkBudget(price: Price, maxUsd: number | string): void {
  if (Number(price.usd) > Number(maxUsd)) {
    throw new OverBudgetError(`This costs $${price.usd}, over maxUsd $${maxUsd}. Nothing was submitted.`, {
      hint: "Raise maxUsd, or lower the settings (duration, resolution, quality).",
      code: "over_budget",
    });
  }
}

/** The price, or why maxUsd could not be checked (and so nothing was submitted). */
export async function priced(pricing: Promise<Price>): Promise<Price> {
  try {
    return await pricing;
  } catch (error) {
    if (!(error instanceof SumeError)) throw error;
    throw new SumeError(
      `Could not price the request (${error.reason}), so maxUsd cannot be checked. Nothing was submitted.`,
      {
        hint: error.hint,
        code: error.code,
        status: error.status,
        requestId: error.requestId,
        retryable: error.retryable,
      },
    );
  }
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

const LISTED: Record<string, string> = {
  aspect_ratio: "aspect_ratios",
  resolution: "resolutions",
  quality: "qualities",
  output_format: "output_formats",
};

/** What to do about refused fields: the values the catalog lists for them, then where to look. */
export function fieldHint(modelId: string, capabilities: unknown, fields: readonly FieldError[]): string {
  const caps = (typeof capabilities === "object" && capabilities !== null ? capabilities : {}) as Record<
    string,
    unknown
  >;
  const parts: string[] = [];
  for (const field of fields) {
    const span = caps.duration_seconds as { min?: unknown; max?: unknown } | undefined;
    const values = caps[LISTED[field.path] ?? ""];
    if (field.path === "duration" && span?.min !== undefined && span.max !== undefined) {
      parts.push(`duration ${span.min}–${span.max} s`);
    } else if (Array.isArray(values) && values.length > 0) parts.push(`${field.path} ${values.join(", ")}`);
  }
  const takes = parts.length > 0 ? `${modelId} takes ${parts.join("; ")}. ` : "";
  return `${takes}See all its fields with model("${modelId}").`;
}

export function modelNotFound(modelId: string, known: readonly string[]): NotFoundError {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of known) {
    const distance = levenshtein(modelId.toLowerCase(), id.toLowerCase());
    if (distance < bestDistance) [best, bestDistance] = [id, distance];
  }
  const guess = best && bestDistance <= Math.max(2, Math.floor(modelId.length / 4)) ? best : undefined;
  return new NotFoundError(`No model "${modelId}" in the open catalog.`, {
    hint: guess ? `Did you mean ${guess}?` : "List the models with models().",
    code: "model_not_found",
    status: 404,
  });
}

/** The body with placeholders for files not yet uploaded: the price does not depend on their URLs. */
export function estimateInput(body: Record<string, unknown>): Record<string, unknown> {
  return withUploads(
    body,
    uploadSlots(body).map((slot) => `https://upload.invalid/${encodeURIComponent(describe(slot.value))}`),
  );
}
