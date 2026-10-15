import { randomUUID } from "node:crypto";
import { assertServer } from "./config.js";
import { APIConnectionError, APIError, NotFoundError, RateLimitError, SumeError } from "./errors.js";
import { type FileInput, planPaths, readPayload } from "./files.js";
import {
  checkBudget,
  DEFAULT_WAIT_MS,
  estimateInput,
  failure,
  firstDelayMs,
  modelNotFound,
  nextDelayMs,
  priced,
  timeoutError,
} from "./flow.js";
import { type ApiResponse, Transport, type TransportOptions } from "./http.js";
import { buildBody, mediaSlots, routerFor, withMedia } from "./inputs.js";
import {
  eventFromApi,
  finalFiles,
  type JobEvent,
  type JobInfo,
  jobInfoFromApi,
  type Model,
  type ModelKind,
  modelFromApi,
  type Price,
  priceFromApi,
  type Status,
  statusFromApi,
} from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: API JSON is read by field name, defensively.
type Json = Record<string, any>;

export interface ClientOptions {
  /** Default: `SUME_API_KEY`, then `SUME_API_KEY` in `./.env`. */
  apiKey?: string;
  /** Default: `SUME_API_BASE_URL`, then `https://api.open.sume.com`. */
  baseUrl?: string;
  /** Milliseconds per HTTP request. Waiting for a job has its own `timeoutMs`. */
  timeoutMs?: number;
  /** Retries for requests that are safe to repeat: reads, and submits (which carry an idempotency key). */
  maxRetries?: number;
  /** Your own fetch, for proxies or tests. */
  fetch?: typeof globalThis.fetch;
  /** @internal For tests: stands in for every wait between reads and retries. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Request fields, by the API's own names (`quality`, `duration`, `aspect_ratio`, …), plus short names
 * for media. Media may be an https URL, a file path, bytes, or a Blob; anything but a URL is uploaded first.
 */
export interface Input {
  prompt?: string;
  image?: FileInput | FileInput[];
  images?: FileInput[];
  end_image?: FileInput;
  video?: FileInput;
  audio?: FileInput;
  reference_images?: FileInput[];
  reference_videos?: FileInput[];
  reference_audios?: FileInput[];
  mask?: FileInput;
  [field: string]: unknown;
}

export interface WaitOptions {
  /** How long to wait (default 30 minutes). The job keeps running past it. */
  timeoutMs?: number;
  /** Called with each status read. */
  onStatus?: (status: Status) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface SubmitOptions {
  /** Refuse to submit if the price is above this, in dollars. Nothing is uploaded or charged. */
  maxUsd?: number | string;
  /** Pass the key of an earlier submit to get that job back instead of paying again. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export type RunOptions = SubmitOptions & WaitOptions;

const CONTROL = ["maxUsd", "idempotencyKey", "timeoutMs", "onStatus", "signal"] as const;

/** Split `{ quality: "low", maxUsd: 1 }` into the request fields and the client's own options. */
function split(promptOrInput: string | (Input & RunOptions) | undefined, rest: (Input & RunOptions) | undefined) {
  const all: Json = typeof promptOrInput === "object" && promptOrInput !== null ? { ...promptOrInput } : { ...rest };
  const options: Json = {};
  for (const key of CONTROL) {
    if (key in all) {
      options[key] = all[key];
      delete all[key];
    }
  }
  let prompt: string | undefined = typeof promptOrInput === "string" ? promptOrInput : undefined;
  if (prompt === undefined && typeof all.prompt === "string") prompt = all.prompt;
  delete all.prompt;
  return { prompt, input: all as Input, options: options as RunOptions };
}

/** A file a job made. `save()` writes it to disk; `bytes()` returns it. */
export class GeneratedFile {
  readonly url: string;
  /** `image`, `video`, `audio` or `file`. */
  readonly type: string;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  /** Set on intermediate files, like a video's `poster` frame. */
  readonly stage: string | null;
  readonly raw: Json;
  readonly #transport: Transport;
  readonly #model: string | null;
  readonly #jobId: string;

  constructor(data: Json, transport: Transport, model: string | null, jobId: string) {
    this.url = data.url;
    this.type = data.type ?? "file";
    this.contentType = data.content_type ?? null;
    this.sizeBytes = data.size_bytes ?? null;
    this.width = data.width ?? null;
    this.height = data.height ?? null;
    this.durationMs = data.duration_ms ?? null;
    this.stage = data.stage ?? null;
    this.raw = data;
    this.#transport = transport;
    this.#model = model;
    this.#jobId = jobId;
  }

  /** Download to `path` (a file or a directory; default `<model>-<job>.<ext>` here). Returns the absolute path. */
  async save(path?: string): Promise<string> {
    const [target] = await planPaths([this], path, this.#model, this.#jobId);
    await this.#transport.download(this.url, target as string);
    return target as string;
  }

  async bytes(): Promise<Uint8Array> {
    return this.#transport.read(this.url);
  }
}

/** A finished job's files. */
export class Result {
  readonly jobId: string;
  readonly model: string | null;
  /** What it cost in US dollars, like `"0.0077"`, when the price was known. */
  readonly usd: string | null;
  /** The files you asked for (a video's poster frame is left out). */
  readonly files: GeneratedFile[];
  /** Every file the job made, intermediate ones included. */
  readonly allFiles: GeneratedFile[];
  /** The API's `result` object. */
  readonly raw: Json;

  constructor(jobId: string, model: string | null, usd: string | null, result: Json, transport: Transport) {
    const artifacts: Json[] = (result.artifacts ?? []).filter((a: Json) => a && typeof a.url === "string");
    const finals = new Set(finalFiles(artifacts));
    this.jobId = jobId;
    this.model = model;
    this.usd = usd;
    this.raw = result;
    this.allFiles = artifacts.map((a) => new GeneratedFile(a, transport, model, jobId));
    this.files = this.allFiles.filter((_, i) => finals.has(artifacts[i] as Json));
  }

  /** The first file's URL. */
  get url(): string | undefined {
    return this.files[0]?.url;
  }

  get urls(): string[] {
    return this.files.map((f) => f.url);
  }

  /**
   * Download every file. `path` may be a file name (the rest are numbered), a directory (ending in `/`),
   * or nothing. Returns the absolute paths written, in order.
   */
  async save(path?: string): Promise<string[]> {
    const targets = await planPaths(this.files, path, this.model, this.jobId);
    for (const [i, file] of this.files.entries()) await file.save(targets[i]);
    return targets;
  }
}

interface JobOptions {
  model?: string | null;
  idempotencyKey?: string | null;
  replayed?: boolean;
  usd?: string | null;
  firstDelayMs?: number;
}

/** A submitted job. `wait()` returns its `Result`; `status()` reads its state once. */
export class Job {
  readonly id: string;
  model: string | null;
  readonly idempotencyKey: string | null;
  /** True when the idempotency key matched an earlier submit: this one paid nothing. */
  readonly replayed: boolean;
  readonly usd: string | null;
  readonly #client: Sume;
  readonly #firstDelayMs: number;

  constructor(client: Sume, id: string, options: JobOptions = {}) {
    this.id = id;
    this.model = options.model ?? null;
    this.idempotencyKey = options.idempotencyKey ?? null;
    this.replayed = options.replayed ?? false;
    this.usd = options.usd ?? null;
    this.#client = client;
    this.#firstDelayMs = options.firstDelayMs ?? 0;
  }

  status(): Promise<Status> {
    return this.#client.status(this.id);
  }

  /**
   * Yield each status read until the job completes, fails or is canceled. Waits between reads as the API
   * asks, up to 5 to 15 s. Network errors and Sume-side errors do not end the wait; `timeoutMs` does
   * (`WaitTimeoutError`, and the job keeps running).
   */
  async *poll(options: Omit<WaitOptions, "onStatus"> = {}): AsyncGenerator<Status> {
    const transport = this.#client.transport;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const started = Date.now();
    const deadline = started + timeoutMs;
    let delay = this.#firstDelayMs;
    for (;;) {
      if (delay > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timeoutError(this.id, timeoutMs);
        await transport.sleep(Math.min(delay, remaining), options.signal);
      }
      let response: ApiResponse<Json>;
      try {
        response = await transport.request<Json>("GET", `/v1/jobs/${encodeURIComponent(this.id)}/status`, {
          timeoutMs: 20_000,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof APIConnectionError || error instanceof APIError || error instanceof RateLimitError) {
          delay = 5000;
          continue;
        }
        throw error;
      }
      const status = statusFromApi(response.data);
      this.model ??= response.data.job?.model ?? null;
      yield status;
      if (status.done) return;
      if (Date.now() >= deadline) throw timeoutError(this.id, timeoutMs);
      delay = nextDelayMs(status, response.headers, Date.now() - started);
    }
  }

  /** Wait for the job, then return its `Result`. A failed or canceled job throws `JobFailedError`. */
  async wait(options: WaitOptions = {}): Promise<Result> {
    let last: Status | undefined;
    for await (last of this.poll(options)) await options.onStatus?.(last);
    const transport = this.#client.transport;
    const id = encodeURIComponent(this.id);
    if (!last?.ok) {
      const info = await transport.request<Json>("GET", `/v1/jobs/${id}`, { signal: options.signal });
      throw failure(this.id, last?.state ?? "failed", info.data.job);
    }
    const data = (await transport.request<Json>("GET", `/v1/jobs/${id}/result`, { signal: options.signal })).data;
    return new Result(this.id, this.model ?? data.job?.model ?? null, this.usd, data.result ?? {}, transport);
  }

  /** Cancel the job if generation has not started. Resolves true when it was canceled (and refunded). */
  cancel(): Promise<boolean> {
    return this.#client.cancel(this.id);
  }

  /** The job's lifecycle: `job.created`, `job.started`, `job.completed` or `job.failed`. */
  async events(options: { limit?: number } = {}): Promise<JobEvent[]> {
    const data = (
      await this.#client.transport.request<Json>("GET", `/v1/jobs/${encodeURIComponent(this.id)}/events`, {
        query: { limit: options.limit },
      })
    ).data;
    return (data.events ?? []).map(eventFromApi);
  }

  /** Everything the API knows about the job: input, state, timing, error, files. */
  async info(): Promise<JobInfo> {
    return jobInfoFromApi(
      (await this.#client.transport.request<Json>("GET", `/v1/jobs/${encodeURIComponent(this.id)}`)).data.job,
    );
  }
}

/** A client for the Sume Open API. Server-side only: the key spends money. */
export class Sume {
  /** @internal */
  readonly transport: Transport;
  readonly #models = new Map<string, Model>();

  constructor(options: ClientOptions = {}) {
    assertServer();
    const transportOptions: TransportOptions = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      fetch: options.fetch,
      sleep: options.sleep,
    };
    this.transport = new Transport(transportOptions);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  // Models and prices: public, no key needed.

  /** Every model in the open catalog, or only one kind: `image`, `video`, `lipsync`, `captions`. */
  async models(kind?: ModelKind): Promise<Model[]> {
    const data = (await this.transport.request<Json>("GET", "/v1/open/catalog", { auth: "optional" })).data;
    const all: Model[] = (data.models ?? []).map(modelFromApi);
    for (const m of all) this.#models.set(m.id, m);
    return all.filter((m) => kind === undefined || m.kind === kind);
  }

  /** One model: what it takes, its limits and its prices. Throws `NotFoundError` with a suggestion. */
  async model(id: string): Promise<Model> {
    const cached = this.#models.get(id);
    if (cached) return cached;
    try {
      const data = (
        await this.transport.request<Json>("GET", `/v1/open/catalog/${encodeURIComponent(id)}`, { auth: "optional" })
      ).data;
      const model = modelFromApi(data);
      this.#models.set(id, model);
      return model;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      throw modelNotFound(
        id,
        (await this.models()).map((m) => m.id),
      );
    }
  }

  /** What a request would cost, in dollars. Free, and needs no key. Files are not uploaded to price it. */
  estimate(model: string, prompt: string, input?: Input): Promise<Price>;
  estimate(model: string, input?: Input): Promise<Price>;
  async estimate(model: string, promptOrInput?: string | Input, input?: Input): Promise<Price> {
    const { prompt, input: fields } = split(promptOrInput, input);
    const info = await this.model(model);
    return this.#estimate(info.id, estimateInput(buildBody(info, prompt, fields)));
  }

  async #estimate(modelId: string, body: Json, signal?: AbortSignal): Promise<Price> {
    const res = await this.transport.request<Json>("POST", "/v1/open/estimate", {
      body: { model: modelId, input: body },
      auth: "optional",
      retry: true,
      signal,
    });
    return priceFromApi(res.data);
  }

  // Files.

  /**
   * Put a file in Sume storage and return its URL, for any media input. `file` may be a path, bytes, or a
   * Blob. You rarely need this: `run` and `submit` upload local files themselves.
   */
  async upload(file: FileInput, options: { contentType?: string; signal?: AbortSignal } = {}): Promise<string> {
    const payload = await readPayload(file, options.contentType);
    const target = (
      await this.transport.request<Json>("POST", "/v1/assets/upload-url", {
        body: { content_type: payload.contentType, size_bytes: payload.data.length, filename: payload.filename },
        signal: options.signal,
      })
    ).data;
    await this.transport.put(
      target.upload.url,
      payload.data,
      target.upload.headers ?? { "content-type": payload.contentType },
      options.signal,
    );
    const asset = (
      await this.transport.request<Json>("POST", `/v1/assets/${encodeURIComponent(target.asset.id)}/complete`, {
        body: { size_bytes: payload.data.length },
        retry: true,
        signal: options.signal,
      })
    ).data.asset;
    if (!asset?.url)
      throw new SumeError(`Sume stored ${payload.filename} but returned no URL for it.`, { code: "upload_incomplete" });
    return asset.url;
  }

  // Generation.

  /**
   * Submit, wait, and return the `Result`: the one call most code needs.
   *
   * @example
   * const image = await sume.run("gpt-image-2", "a red kite over a beach", { quality: "low" });
   * await image.save("kite.png");
   */
  run(model: string, prompt: string, input?: Input & RunOptions): Promise<Result>;
  run(model: string, input?: Input & RunOptions): Promise<Result>;
  async run(model: string, promptOrInput?: string | (Input & RunOptions), input?: Input & RunOptions): Promise<Result> {
    const { prompt, input: fields, options } = split(promptOrInput, input);
    const job = await this.#submit(model, prompt, fields, options, true);
    return job.wait(options);
  }

  /** Start a job and return at once. `job.wait()` gets its `Result` later. */
  submit(model: string, prompt: string, input?: Input & SubmitOptions): Promise<Job>;
  submit(model: string, input?: Input & SubmitOptions): Promise<Job>;
  async submit(
    model: string,
    promptOrInput?: string | (Input & SubmitOptions),
    input?: Input & SubmitOptions,
  ): Promise<Job> {
    const { prompt, input: fields, options } = split(promptOrInput, input);
    return this.#submit(model, prompt, fields, options, false);
  }

  async #submit(
    model: string,
    prompt: string | undefined,
    fields: Input,
    options: RunOptions,
    priceIt: boolean,
  ): Promise<Job> {
    const info = await this.model(model);
    let body = buildBody(info, prompt, fields);
    // Priced beside the uploads and the submit, so knowing the cost adds no wait.
    const pricing =
      priceIt || options.maxUsd !== undefined
        ? this.#estimate(info.id, estimateInput(body), options.signal)
        : undefined;
    pricing?.catch(() => undefined);
    if (options.maxUsd !== undefined && pricing) checkBudget(await priced(pricing), options.maxUsd);
    const urls: string[] = [];
    for (const slot of mediaSlots(body))
      urls.push(await this.upload(slot.value as FileInput, { signal: options.signal }));
    body = withMedia(body, urls);
    const key = options.idempotencyKey ?? randomUUID();
    let data: Json;
    try {
      data = (
        await this.transport.request<Json>("POST", `/v1/${routerFor(info)}-router/generate`, {
          body: { ...body, model: info.id },
          idempotencyKey: key,
          signal: options.signal,
        })
      ).data;
    } catch (error) {
      // A network or server error leaves the outcome open: name the key, so a
      // retry with it adopts the job instead of paying for a second one.
      if (error instanceof SumeError && (error.status === undefined || error.status >= 500)) {
        error.idempotencyKey = key;
        error.hint = `${error.hint ? `${error.hint} ` : ""}If the submit went through, pass idempotencyKey: "${key}" to get that job back.`;
        error.message = error.compose();
      }
      throw error;
    }
    let usd: string | null = null;
    if (pricing)
      usd = await Promise.race([
        pricing.then((p) => p.usd),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000).unref?.()),
      ]).catch(() => null);
    return new Job(this, data.job.id, {
      model: data.job.model ?? info.id,
      idempotencyKey: key,
      replayed: Boolean(data.idempotency_hit),
      usd,
      firstDelayMs: firstDelayMs(data),
    });
  }

  // Jobs.

  /** A handle on a job you already have the id of. Makes no call. */
  job(id: string): Job {
    return new Job(this, id);
  }

  /** Read a job's state once. */
  async status(id: string): Promise<Status> {
    return statusFromApi(
      (await this.transport.request<Json>("GET", `/v1/jobs/${encodeURIComponent(id)}/status`, { timeoutMs: 20_000 }))
        .data,
    );
  }

  /** Wait for a job (if it is still running) and return its `Result`. */
  result(id: string, options: WaitOptions = {}): Promise<Result> {
    return new Job(this, id).wait(options);
  }

  /** Cancel a job that has not started generating. Resolves true when it was canceled; it is refunded. */
  async cancel(id: string): Promise<boolean> {
    const data = (
      await this.transport.request<Json>("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`, { retry: true })
    ).data;
    return Boolean(data.canceled);
  }

  /** Your newest jobs first. `status` keeps one state: `queued`, `processing`, `completed`, … */
  async listJobs(options: { limit?: number; status?: string } = {}): Promise<JobInfo[]> {
    const data = (
      await this.transport.request<Json>("GET", "/v1/jobs", {
        query: { limit: options.limit ?? 20, status: options.status },
      })
    ).data;
    return (data.jobs ?? []).map(jobInfoFromApi);
  }
}
