/** The plain objects the client returns. Each keeps the API's own JSON in `raw`. */

/** `queued`, `processing`, `completed`, `failed` or `canceled`. */
export type JobState = "queued" | "processing" | "completed" | "failed" | "canceled";

export type ModelKind = "image" | "video" | "lipsync" | "captions";

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const UNITS: Record<string, string> = { second: "/s", image: "/image", request: "/request" };

// biome-ignore lint/suspicious/noExplicitAny: API JSON is read by field name, defensively.
type Json = Record<string, any>;

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Attach the API's JSON (and a `toString`) as ordinary properties, so spreads, `structuredClone` and
 * `JSON.stringify` keep them, and hide only them from `console.log`, which shows the fields.
 */
function hidden<T extends object>(value: T, raw: Json, describe?: () => string): T {
  const out = Object.assign(value, { raw }, describe ? { toString: describe } : {});
  Object.defineProperty(out, INSPECT, {
    enumerable: false,
    value(this: Json, _depth: number, options: object, show: (v: unknown, o: object) => string) {
      const { raw: _raw, toString: _toString, ...fields } = this;
      return show(fields, options);
    },
  });
  return out;
}

/** `text-to-video, image-to-video` → `["text", "image"]`: what a model starts from. */
function inputsOf(modes: readonly string[]): string[] {
  const words: string[] = [];
  for (const mode of modes) {
    const word =
      mode === "image-edit" ? "image" : mode === "video-captions" ? "video" : (mode.split("-to-")[0] ?? mode);
    if (!words.includes(word)) words.push(word);
  }
  return words;
}

/** A model in the open catalog: what it makes, what it takes, and its price per image or second. */
export interface Model {
  id: string;
  name: string;
  kind: ModelKind;
  company: string;
  /** Dollars per `per` for the cheapest option, like `"0.0060"`. */
  priceFrom: string;
  /** Dollars per `per` for the dearest option, when it differs. */
  priceTo: string | null;
  /** `image` or `second`. */
  per: string;
  /** `$0.0060/image` or `$0.02936–$0.06352/s`. */
  price: string;
  inputs: string[];
  modes: string[];
  resolutions: string[];
  /** The shortest and longest clip, for video, lip-sync and captions. */
  seconds: [number, number] | null;
  raw: Json;
}

export function modelFromApi(data: Json): Model {
  const pricing = data.pricing ?? {};
  const caps = data.capabilities ?? {};
  const span = caps.duration_seconds;
  const from = String(pricing.from_usd ?? "");
  const to = pricing.to_usd && pricing.to_usd !== pricing.from_usd ? String(pricing.to_usd) : null;
  const per = pricing.unit ?? "request";
  const modes: string[] = Array.isArray(data.modes) ? data.modes : [];
  const model = {
    id: data.id,
    name: data.name ?? data.id,
    kind: data.kind ?? "image",
    company: data.company?.name ?? "",
    priceFrom: from,
    priceTo: to,
    per,
    price: `$${from}${to ? `–$${to}` : ""}${UNITS[per] ?? `/${per}`}`,
    inputs: inputsOf(modes),
    modes,
    resolutions: Array.isArray(caps.resolutions) ? caps.resolutions : [],
    seconds: typeof span?.min === "number" && typeof span?.max === "number" ? [span.min, span.max] : null,
  };
  return hidden(model, data) as Model;
}

/** What a request costs, in US dollars. Pricing is free and needs no key. */
export interface Price {
  model: string;
  /** Dollars, as the API writes them: `"0.0060"`. */
  usd: string;
  usdMicros: number;
  raw: Json;
  toString(): string;
}

export function priceFromApi(data: Json): Price {
  const usd = String(data.usd);
  return hidden(
    { model: data.model ?? "", usd, usdMicros: Number(data.usd_micros ?? 0) },
    data,
    () => `$${usd}`,
  ) as Price;
}

/** One read of a job's state. */
export interface Status {
  jobId: string;
  state: JobState;
  /** True once the job has completed, failed or been canceled. */
  done: boolean;
  /** True once the job has completed. */
  ok: boolean;
  queuePosition: number | null;
  nextPollAfterSeconds: number | null;
  raw: Json;
  toString(): string;
}

export function statusFromApi(data: Json): Status {
  let state = String(data.sume_status ?? data.status ?? "").toLowerCase();
  if (state === "in_queue") state = "queued";
  if (state === "in_progress") state = "processing";
  const queuePosition = typeof data.queue_position === "number" ? data.queue_position : null;
  const status = {
    jobId: data.job_id ?? data.job?.id ?? "",
    state: state as JobState,
    done: Boolean(data.terminal) || TERMINAL.has(state),
    ok: state === "completed",
    queuePosition,
    nextPollAfterSeconds: typeof data.next_poll_after_seconds === "number" ? data.next_poll_after_seconds : null,
  };
  return hidden(status, data, () =>
    state === "queued" && queuePosition !== null ? `queued (#${queuePosition} in line)` : state,
  ) as Status;
}

/** A step in a job's life, like `job.started` or `job.failed`. */
export interface JobEvent {
  id: string;
  type: string;
  message: string | null;
  createdAt: string;
  raw: Json;
}

export function eventFromApi(data: Json): JobEvent {
  const event = {
    id: data.id ?? "",
    type: data.type ?? "",
    message: data.message ?? null,
    createdAt: data.created_at ?? "",
  };
  return hidden(event, data) as JobEvent;
}

/** A job as `GET /v1/jobs/{id}` describes it. */
export interface JobInfo {
  id: string;
  model: string | null;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** How long it ran, from start (or creation) to completion, once it has completed. */
  seconds: number | null;
  error: Json | null;
  input: Json;
  idempotencyKey: string | null;
  /** The URLs of the files it made, once it has completed. */
  urls: string[];
  raw: Json;
}

function secondsBetween(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export function jobInfoFromApi(data: Json): JobInfo {
  const artifacts: Json[] = data.result?.artifacts ?? [];
  const info = {
    id: data.id,
    model: data.model ?? null,
    state: data.status,
    createdAt: data.created_at ?? "",
    startedAt: data.started_at ?? null,
    completedAt: data.completed_at ?? null,
    seconds: secondsBetween(data.started_at ?? data.created_at, data.completed_at),
    error: data.error ?? null,
    input: data.input ?? {},
    idempotencyKey: data.idempotency_key ?? null,
    urls: finalFiles(artifacts)
      .map((a) => a.url)
      .filter(Boolean),
  };
  return hidden(info, data) as JobInfo;
}

/** The files a person asked for: no intermediate stages, and no poster image beside a video. */
export function finalFiles<T extends Json>(artifacts: readonly T[]): T[] {
  let finals = artifacts.filter((a) => !a.stage);
  if (finals.some((a) => a.type === "video")) finals = finals.filter((a) => a.type !== "image");
  return finals.length > 0 ? finals : [...artifacts];
}
