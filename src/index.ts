/**
 * Images and video from the Sume Open API (https://open.sume.com). Server-side only.
 *
 * @example
 * import { run } from "@sume-com/open";
 * const image = await run("gpt-image-2", "a red kite over a beach", { quality: "low" });
 * await image.save("kite.png");
 *
 * The key comes from `SUME_API_KEY` (or that line in `./.env`). These functions use a shared
 * default client; make your own with `new Sume({ apiKey })`.
 */
import {
  type ClientOptions,
  type EstimateInput,
  type Extra,
  GeneratedFile,
  type Input,
  type InputOf,
  Job,
  type ModelName,
  Result,
  type RunInput,
  type RunOptions,
  type SubmitInput,
  type SubmitOptions,
  Sume,
  type WaitOptions,
} from "./client.js";
import type { FileInput } from "./files.js";
import type { JobInfo, JobState, Model, ModelKind, Price, Status } from "./types.js";

export {
  APIConnectionError,
  APIError,
  AuthenticationError,
  DEFAULT_BASE_URL,
  type FieldError,
  InsufficientFundsError,
  InvalidRequestError,
  JobFailedError,
  NotFoundError,
  OverBudgetError,
  RateLimitError,
  SumeError,
  WaitTimeoutError,
} from "./errors.js";
export type * from "./generated.js";
export type { JobEvent, JobInfo, JobState, Model, ModelKind, Price, Status } from "./types.js";
export { VERSION } from "./version.js";
export { type VerifyOptions, verifyWebhook } from "./webhooks.js";
export {
  type ClientOptions,
  type EstimateInput,
  type Extra,
  type FileInput,
  GeneratedFile,
  type Input,
  type InputOf,
  Job,
  type ModelName,
  Result,
  type RunInput,
  type RunOptions,
  type SubmitInput,
  type SubmitOptions,
  Sume,
  type WaitOptions,
};

let shared: Sume | undefined;
/** The shared default client. It reads the key and the host on every call, so setting them later works. */
const client = () => {
  shared ??= new Sume();
  return shared;
};

/**
 * Submit, wait, and return the `Result`: the one call most code needs. See `Sume.run`.
 *
 * @example
 * const image = await run("gpt-image-2", "a red kite over a beach", { quality: "low" });
 * await image.save("kite.png");
 */
export function run<M extends ModelName>(model: M, prompt: string | undefined, input?: RunInput<M>): Promise<Result>;
export function run<M extends ModelName>(model: M, input?: RunInput<M>): Promise<Result>;
export function run(model: string, a?: string | RunInput, b?: RunInput): Promise<Result> {
  // Both arguments always go through: an undefined prompt must not drop the options after it.
  return client().run(model, a as string | undefined, b);
}

/** Start a job and return at once; `job.wait()` gets its `Result` later. See `Sume.submit`. */
export function submit<M extends ModelName>(model: M, prompt: string | undefined, input?: SubmitInput<M>): Promise<Job>;
export function submit<M extends ModelName>(model: M, input?: SubmitInput<M>): Promise<Job>;
export function submit(model: string, a?: string | SubmitInput, b?: SubmitInput): Promise<Job> {
  return client().submit(model, a as string | undefined, b);
}

/** What a request would cost, in dollars. Free, and needs no key. See `Sume.estimate`. */
export function estimate<M extends ModelName>(
  model: M,
  prompt: string | undefined,
  input?: EstimateInput<M>,
): Promise<Price>;
export function estimate<M extends ModelName>(model: M, input?: EstimateInput<M>): Promise<Price>;
export function estimate(model: string, a?: string | EstimateInput, b?: EstimateInput): Promise<Price> {
  return client().estimate(model, a as string | undefined, b);
}

/** A handle on a job you already have the id of. */
export const job = (id: string): Job => client().job(id);
/** Read a job's state once. */
export const status = (id: string): Promise<Status> => client().status(id);
/** Wait for a job (if it is still running) and return its `Result`. */
export const result = (id: string, options?: WaitOptions): Promise<Result> => client().result(id, options);
/** Cancel a job that has not started generating; it is refunded. */
export const cancel = (id: string): Promise<boolean> => client().cancel(id);
/** Every model in the open catalog, or one kind. Free, and needs no key. */
export const models = (kind?: ModelKind): Promise<Model[]> => client().models(kind);
/** One model: what it takes, its limits and its prices. */
export const model = (id: ModelName): Promise<Model> => client().model(id);
/** Put a file in Sume storage and return its URL. */
export const upload = (file: FileInput, options?: { contentType?: string; signal?: AbortSignal }): Promise<string> =>
  client().upload(file, options);
/** Your newest jobs first. */
export const listJobs = (options?: { limit?: number; status?: JobState }): Promise<JobInfo[]> =>
  client().listJobs(options);
