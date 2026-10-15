import { randomUUID } from "node:crypto";
import { assertServer } from "./config.js";
import {
  APIConnectionError,
  APIError,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  SumeError,
  type WaitTimeoutError,
} from "./errors.js";
import { type FileInput, planPaths, readPayload } from "./files.js";
import {
  checkBudget,
  DEFAULT_WAIT_MS,
  estimateInput,
  failure,
  fieldHint,
  firstDelayMs,
  isFull,
  modelNotFound,
  nextDelayMs,
  priced,
  SLOT_WAIT_MS,
  slotDelayMs,
  timeoutError,
} from "./flow.js";
import { MODEL_KINDS, type ModelId, type ModelInputs } from "./generated.js";
import { type ApiResponse, debug, Transport, type TransportOptions } from "./http.js";
import { buildBody, routerFor, uploadSlots, withUploads } from "./inputs.js";
import {
  eventFromApi,
  finalFiles,
  type JobEvent,
  type JobInfo,
  type JobState,
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
  /** Extra headers for every API call, like a trace id. Never sent to storage or media hosts. */
  headers?: Record<string, string>;
  /** @internal For tests: stands in for every wait between reads and retries. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A model id. The ids this version knows autocomplete; any other id in the live catalog works too. */
export type ModelName = ModelId | (string & {});

/**
 * Request fields for any model, by the API's own names (`quality`, `duration`, `aspect_ratio`, …), plus
 * short names for media. Media may be an https URL, a file path, bytes, or a Blob; anything but a URL is
 * uploaded first. Models this version knows get their own type instead: see `InputOf`.
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

/** The request fields of model `M`: its own type when this version knows it, else `Input`. */
export type InputOf<M extends string> = M extends keyof ModelInputs ? ModelInputs[M] : Input;

export interface Extra {
  /** Request fields the types do not list yet, sent as given. Fields named outside it win. */
  input?: Record<string, unknown>;
}

export interface WaitOptions {
  /** How long to wait in all, in milliseconds (default 30 minutes). The job keeps running past it. */
  timeoutMs?: number;
  /** Called with each status read: `status.state`, `status.queuePosition`. */
  onStatus?: (status: Status) => void | Promise<void>;
  /** Called once with each new step in the job's life: `job.started`, `job.completed`, … */
  onEvent?: (event: JobEvent) => void | Promise<void>;
  /** When the wait runs out, cancel the job if it has not started; it is refunded. */
  cancelOnTimeout?: boolean;
  signal?: AbortSignal;
}

export interface SubmitOptions {
  /** Refuse to submit if the price is above this, in dollars. Nothing is uploaded or charged. */
  maxUsd?: number | string;
  /** Pass the key of an earlier submit to get that job back instead of paying again. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface RunOptions extends SubmitOptions, WaitOptions {
  /** Called with the `Job` once it exists, so you can keep its id. */
  onSubmit?: (job: Job) => void | Promise<void>;
}

/** What `run` takes after the prompt: the model's fields, plus `RunOptions`. */
export type RunInput<M extends string = string> = InputOf<M> & RunOptions & Extra;
/** What `submit` takes after the prompt: the model's fields, plus `SubmitOptions`. */
export type SubmitInput<M extends string = string> = InputOf<M> & SubmitOptions & Extra;
/** What `estimate` takes after the prompt: the model's fields. */
export type EstimateInput<M extends string = string> = InputOf<M> & Extra;

const CONTROL = [
  "maxUsd",
  "idempotencyKey",
  "timeoutMs",
  "onSubmit",
  "onStatus",
  "onEvent",
  "cancelOnTimeout",
  "signal",
] as const;

/** Split `{ quality: "low", maxUsd: 1 }` into the request fields and the client's own options. */
function split(promptOrInput: string | Json | undefined, rest: Json | undefined) {
  const { input: extra, ...given }: Json =
    typeof promptOrInput === "object" && promptOrInput !== null ? promptOrInput : (rest ?? {});
  const all: Json = { ...extra, ...given };
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
  return { prompt, fields: all, options: options as RunOptions };
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
  readonly #raw: Json;
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
    this.#raw = data;
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

  /** The API's JSON for the file. */
  get raw(): Json {
    return this.#raw;
  }

  toJSON() {
    return {
      url: this.url,
      type: this.type,
      contentType: this.contentType,
      sizeBytes: this.sizeBytes,
      width: this.width,
      height: this.height,
      durationMs: this.durationMs,
    };
  }
}

/** A finished job's files. */
export class Result {
  readonly jobId: string;
  readonly model: string | null;
  /** What it cost in US dollars, like `"0.0060"`, when the price was known. */
  readonly usd: string | null;
  /** The files you asked for (a video's poster frame is left out). */
  readonly files: GeneratedFile[];
  /** Every file the job made, intermediate ones included. */
  readonly allFiles: GeneratedFile[];
  /** The job as the API describes it: input, timing (`job.seconds`), and so on. */
  readonly job: JobInfo | null;
  readonly #raw: Json;

  constructor(
    jobId: string,
    model: string | null,
    usd: string | null,
    result: Json,
    job: Json | null,
    transport: Transport,
  ) {
    const artifacts: Json[] = (result.artifacts ?? []).filter((a: Json) => a && typeof a.url === "string");
    const finals = new Set(finalFiles(artifacts));
    this.jobId = jobId;
    this.model = model;
    this.usd = usd;
    this.#raw = result;
    this.job = job && typeof job.id === "string" ? jobInfoFromApi(job) : null;
    this.allFiles = artifacts.map((a) => new GeneratedFile(a, transport, model, jobId));
    this.files = this.allFiles.filter((_, i) => finals.has(artifacts[i] as Json));
  }

  /** The API's `result` object. */
  get raw(): Json {
    return this.#raw;
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

  /** A JSON-ready summary, so `Response.json(result)` or `res.json(result)` sends what a page needs. */
  toJSON() {
    return {
      jobId: this.jobId,
      model: this.model,
      usd: this.usd,
      url: this.url ?? null,
      files: this.files.map((f) => f.toJSON()),
      seconds: this.job?.seconds ?? null,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](_depth: number, options: object, show: (v: unknown, o: object) => string) {
    const { files, ...rest } = this.toJSON();
    return `Result ${show({ ...rest, files: files.length }, options)}`;
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
    const seen = new Set<string>();
    let last: Status | undefined;
    try {
      for await (last of this.poll(options)) {
        await options.onStatus?.(last);
        if (options.onEvent) await this.#emitNewEvents(seen, options.onEvent, options.signal);
      }
    } catch (error) {
      if (options.cancelOnTimeout && (error as WaitTimeoutError | undefined)?.code === "wait_timeout") {
        const canceled = await this.cancel().catch(() => false);
        if (canceled) throw timeoutError(this.id, options.timeoutMs ?? DEFAULT_WAIT_MS, true);
      }
      throw error;
    }
    const transport = this.#client.transport;
    const id = encodeURIComponent(this.id);
    if (!last?.ok) {
      const info = await transport.request<Json>("GET", `/v1/jobs/${id}`, { signal: options.signal });
      throw failure(this.id, last?.state ?? "failed", info.data.job);
    }
    const data = (await transport.request<Json>("GET", `/v1/jobs/${id}/result`, { signal: options.signal })).data;
    const model = this.model ?? data.job?.model ?? null;
    return new Result(this.id, model, this.usd, data.result ?? {}, data.job ?? null, transport);
  }

  async #emitNewEvents(seen: Set<string>, onEvent: NonNullable<WaitOptions["onEvent"]>, signal?: AbortSignal) {
    let events: JobEvent[];
    try {
      events = await this.events({ signal });
    } catch (error) {
      if (error instanceof SumeError) return; // progress is a nicety; the wait goes on
      throw error;
    }
    for (const event of events) {
      const key = event.id || `${event.type}@${event.createdAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await onEvent(event);
    }
  }

  /** Cancel the job if generation has not started. Resolves true when it was canceled (and refunded). */
  cancel(): Promise<boolean> {
    return this.#client.cancel(this.id);
  }

  /** The job's life so far: `job.created`, `job.started`, `job.completed` or `job.failed`. */
  async events(options: { limit?: number; signal?: AbortSignal | undefined } = {}): Promise<JobEvent[]> {
    const data = (
      await this.#client.transport.request<Json>("GET", `/v1/jobs/${encodeURIComponent(this.id)}/events`, {
        query: { limit: options.limit },
        signal: options.signal,
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
      headers: options.headers,
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
  async model(id: ModelName): Promise<Model> {
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
      throw await this.#notFound(id);
    }
  }

  async #notFound(id: string): Promise<NotFoundError> {
    const known = await this.models().then(
      (all) => all.map((m) => m.id),
      () => Object.keys(MODEL_KINDS),
    );
    return modelNotFound(id, known);
  }

  /** The model's kind, from the ids this version knows, else from the catalog. */
  async #kind(id: string): Promise<string> {
    return MODEL_KINDS[id] ?? (await this.model(id)).kind;
  }

  /**
   * What a request would cost, in dollars. Free, and needs no key. Files are not uploaded to price it.
   *
   * @example
   * String(await estimate("seedance-2-mini", "a paper boat", { duration: 8, resolution: "720p" })); // "$0.5082"
   */
  estimate<M extends ModelName>(model: M, prompt: string, input?: EstimateInput<M>): Promise<Price>;
  estimate<M extends ModelName>(model: M, input?: EstimateInput<M>): Promise<Price>;
  async estimate(model: string, promptOrInput?: string | Json, input?: Json): Promise<Price> {
    const { prompt, fields } = split(promptOrInput, input);
    const body = buildBody(model, await this.#kind(model), prompt, fields);
    return this.#estimate(model, estimateInput(body));
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
   * Submit, wait, and return the `Result`: the one call most code needs. Local files are uploaded
   * first; when the account already runs as many jobs as it may, it waits for a free slot.
   *
   * @example
   * const image = await sume.run("gpt-image-2", "a red kite over a beach", { quality: "low" });
   * await image.save("kite.png");
   */
  run<M extends ModelName>(model: M, prompt: string, input?: RunInput<M>): Promise<Result>;
  run<M extends ModelName>(model: M, input?: RunInput<M>): Promise<Result>;
  async run(model: string, promptOrInput?: string | Json, input?: Json): Promise<Result> {
    const started = Date.now();
    const { prompt, fields, options } = split(promptOrInput, input);
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const job = await this.#submit(model, prompt, fields, options, true, timeoutMs);
    await options.onSubmit?.(job);
    return job.wait({ ...options, timeoutMs: Math.max(timeoutMs - (Date.now() - started), 1) });
  }

  /**
   * Start a job and return at once. `job.wait()` gets its `Result` later. When the account already
   * runs as many jobs as it may, it waits for a free slot (up to 10 minutes) rather than failing.
   *
   * @example
   * const job = await sume.submit("kling-3", "a red kite over a beach", { duration: 5 });
   * const video = await job.wait();
   */
  submit<M extends ModelName>(model: M, prompt: string, input?: SubmitInput<M>): Promise<Job>;
  submit<M extends ModelName>(model: M, input?: SubmitInput<M>): Promise<Job>;
  async submit(model: string, promptOrInput?: string | Json, input?: Json): Promise<Job> {
    const { prompt, fields, options } = split(promptOrInput, input);
    return this.#submit(model, prompt, fields, options, false, SLOT_WAIT_MS);
  }

  async #submit(
    model: string,
    prompt: string | undefined,
    fields: Json,
    options: RunOptions,
    priceIt: boolean,
    slotWaitMs: number,
  ): Promise<Job> {
    const kind = await this.#kind(model);
    let body = buildBody(model, kind, prompt, fields);
    // Priced beside the uploads and the submit, so knowing the cost adds no wait.
    const pricing =
      priceIt || options.maxUsd !== undefined ? this.#estimate(model, estimateInput(body), options.signal) : undefined;
    pricing?.catch(() => undefined);
    if (options.maxUsd !== undefined && pricing) checkBudget(await priced(pricing), options.maxUsd);
    const urls: string[] = [];
    for (const slot of uploadSlots(body))
      urls.push(await this.upload(slot.value as FileInput, { signal: options.signal }));
    body = withUploads(body, urls);
    const key = options.idempotencyKey ?? randomUUID();
    const data = await this.#generate(model, kind, body, key, slotWaitMs, options.signal);
    let usd: string | null = null;
    if (pricing)
      usd = await Promise.race([
        pricing.then((p) => p.usd),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000).unref?.()),
      ]).catch(() => null);
    return new Job(this, data.job.id, {
      model: data.job.model ?? model,
      idempotencyKey: key,
      replayed: Boolean(data.idempotency_hit),
      usd,
      firstDelayMs: firstDelayMs(data),
    });
  }

  async #generate(
    model: string,
    kind: string,
    body: Json,
    key: string,
    slotWaitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Json> {
    const deadline = Date.now() + slotWaitMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return (
          await this.transport.request<Json>("POST", `/v1/${routerFor(kind)}-router/generate`, {
            body: { ...body, model },
            idempotencyKey: key,
            signal,
          })
        ).data;
      } catch (error) {
        if (error instanceof NotFoundError && error.code === "model_not_found") throw await this.#notFound(model);
        if (error instanceof InvalidRequestError && !(error instanceof NotFoundError) && error.fieldErrors.length > 0) {
          const capabilities = await this.model(model).then(
            (m) => m.raw.capabilities,
            () => undefined,
          );
          error.hint = fieldHint(model, capabilities, error.fieldErrors);
          error.message = error.compose();
          throw error;
        }
        if (isFull(error)) {
          // The account has as many jobs running as it may: wait for a slot, then ask again.
          const delay = slotDelayMs(error, attempt);
          if (Date.now() + delay < deadline) {
            debug("All job slots are busy; asking again in %d s", Math.round(delay / 1000));
            await this.transport.sleep(delay, signal);
            continue;
          }
        }
        // A network or server error leaves the outcome open: name the key, so a
        // retry with it adopts the job instead of paying for a second one.
        if (error instanceof SumeError && (error.status === undefined || error.status >= 500)) {
          error.idempotencyKey = key;
          error.hint = `${error.hint ? `${error.hint} ` : ""}If the submit went through, pass idempotencyKey: "${key}" to get that job back.`;
          error.message = error.compose();
        }
        throw error;
      }
    }
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
  async listJobs(options: { limit?: number; status?: JobState } = {}): Promise<JobInfo[]> {
    const data = (
      await this.transport.request<Json>("GET", "/v1/jobs", {
        query: { limit: options.limit ?? 20, status: options.status },
      })
    ).data;
    return (data.jobs ?? []).map(jobInfoFromApi);
  }
}
