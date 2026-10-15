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
  GeneratedFile,
  type Input,
  Job,
  Result,
  type RunOptions,
  type SubmitOptions,
  Sume,
  type WaitOptions,
} from "./client.js";
import type { FileInput } from "./files.js";
import type { JobInfo, Model, ModelKind, Price, Status } from "./types.js";

export {
  APIConnectionError,
  APIError,
  AuthenticationError,
  DEFAULT_BASE_URL,
  InsufficientFundsError,
  InvalidRequestError,
  JobFailedError,
  NotFoundError,
  OverBudgetError,
  RateLimitError,
  SumeError,
  WaitTimeoutError,
} from "./errors.js";
export type { JobEvent, JobInfo, JobState, Model, ModelKind, Price, Status } from "./types.js";
export { VERSION } from "./version.js";
export { type VerifyOptions, verifyWebhook } from "./webhooks.js";
export {
  type ClientOptions,
  type FileInput,
  GeneratedFile,
  type Input,
  Job,
  Result,
  type RunOptions,
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

/** Submit, wait, and return the `Result`. See `Sume.run`. */
export function run(model: string, prompt: string, input?: Input & RunOptions): Promise<Result>;
export function run(model: string, input?: Input & RunOptions): Promise<Result>;
export function run(model: string, a?: string | (Input & RunOptions), b?: Input & RunOptions): Promise<Result> {
  return typeof a === "string" ? client().run(model, a, b) : client().run(model, a);
}

/** Start a job and return at once. See `Sume.submit`. */
export function submit(model: string, prompt: string, input?: Input & SubmitOptions): Promise<Job>;
export function submit(model: string, input?: Input & SubmitOptions): Promise<Job>;
export function submit(model: string, a?: string | (Input & SubmitOptions), b?: Input & SubmitOptions): Promise<Job> {
  return typeof a === "string" ? client().submit(model, a, b) : client().submit(model, a);
}

/** What a request would cost, in dollars. Free, and needs no key. */
export function estimate(model: string, prompt: string, input?: Input): Promise<Price>;
export function estimate(model: string, input?: Input): Promise<Price>;
export function estimate(model: string, a?: string | Input, b?: Input): Promise<Price> {
  return typeof a === "string" ? client().estimate(model, a, b) : client().estimate(model, a);
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
export const model = (id: string): Promise<Model> => client().model(id);
/** Put a file in Sume storage and return its URL. */
export const upload = (file: FileInput, options?: { contentType?: string; signal?: AbortSignal }): Promise<string> =>
  client().upload(file, options);
/** Your newest jobs first. */
export const listJobs = (options?: { limit?: number; status?: string }): Promise<JobInfo[]> =>
  client().listJobs(options);
