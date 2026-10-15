/** The plain objects the client returns. Each keeps the API's own JSON in `raw`. */

/** `queued`, `processing`, `completed`, `failed` or `canceled`. */
export type JobState = "queued" | "processing" | "completed" | "failed" | "canceled";

export type ModelKind = "image" | "video" | "lipsync" | "captions";

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const UNITS: Record<string, string> = { second: "/s", image: "/image", request: "/request" };

// biome-ignore lint/suspicious/noExplicitAny: API JSON is read by field name, defensively.
type Json = Record<string, any>;

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
  /** Dollars per `per` for the cheapest option, like `"0.0077"`. */
  priceFrom: string;
  /** Dollars per `per` for the dearest option, when it differs. */
  priceTo: string | null;
  /** `image` or `second`. */
  per: string;
  /** `$0.0077/image` or `$0.0879–$0.1890/s`. */
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
  return {
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
    raw: data,
  };
}

/** What a request costs, in US dollars. Pricing is free and needs no key. */
export interface Price {
  model: string;
  /** Dollars, as the API writes them: `"0.0077"`. */
  usd: string;
  usdMicros: number;
  raw: Json;
  toString(): string;
}

export function priceFromApi(data: Json): Price {
  const usd = String(data.usd);
  return {
    model: data.model ?? "",
    usd,
    usdMicros: Number(data.usd_micros ?? 0),
    raw: data,
    toString: () => `$${usd}`,
  };
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
  return {
    jobId: data.job_id ?? data.job?.id ?? "",
    state: state as JobState,
    done: Boolean(data.terminal) || TERMINAL.has(state),
    ok: state === "completed",
    queuePosition,
    nextPollAfterSeconds: typeof data.next_poll_after_seconds === "number" ? data.next_poll_after_seconds : null,
    raw: data,
    toString: () => (state === "queued" && queuePosition !== null ? `queued (#${queuePosition} in line)` : state),
  };
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
  return {
    id: data.id ?? "",
    type: data.type ?? "",
    message: data.message ?? null,
    createdAt: data.created_at ?? "",
    raw: data,
  };
}

/** A job as `GET /v1/jobs/{id}` describes it. */
export interface JobInfo {
  id: string;
  model: string | null;
  state: JobState;
  createdAt: string;
  completedAt: string | null;
  error: Json | null;
  input: Json;
  idempotencyKey: string | null;
  /** The URLs of the files it made, once it has completed. */
  urls: string[];
  raw: Json;
}

export function jobInfoFromApi(data: Json): JobInfo {
  const artifacts: Json[] = data.result?.artifacts ?? [];
  return {
    id: data.id,
    model: data.model ?? null,
    state: data.status,
    createdAt: data.created_at ?? "",
    completedAt: data.completed_at ?? null,
    error: data.error ?? null,
    input: data.input ?? {},
    idempotencyKey: data.idempotency_key ?? null,
    urls: finalFiles(artifacts)
      .map((a) => a.url)
      .filter(Boolean),
    raw: data,
  };
}

/** The files a person asked for: no intermediate stages, and no poster image beside a video. */
export function finalFiles<T extends Json>(artifacts: readonly T[]): T[] {
  let finals = artifacts.filter((a) => !a.stage);
  if (finals.some((a) => a.type === "video")) finals = finals.filter((a) => a.type !== "image");
  return finals.length > 0 ? finals : [...artifacts];
}
