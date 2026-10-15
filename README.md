# @sume-com/open

The official JavaScript and TypeScript client for the [Sume Open API](https://open.sume.com). Run any open.sume.com model for images, video, lip-sync or captions, and save the file. Prices are in dollars. Every model and field is typed, and there are no dependencies. Node 20+ and Bun, server-side only.

```sh
npm install https://github.com/sumelabs/sume-js/releases/latest/download/sume-open.tgz
export SUME_API_KEY="sume_live_..."   # from https://open.sume.com/api-keys
```

```ts
import { run } from "@sume-com/open";

const image = await run("gpt-image-2", "a red kite over a beach", { quality: "low" });
await image.save("kite.png");
```

That is the whole program. `run` prices the request and submits it, uploading any local files first. It waits for the job and returns the files; `save` writes them to disk. This one cost $0.0060.

[Install](#install) · [Key](#key) · [Run a model](#run-a-model) · [Types](#types) · [Pick a model](#pick-a-model) · [Progress, long jobs and cancel](#progress-long-jobs-and-cancel) · [Files](#files) · [In a web app](#in-a-web-app) · [Webhooks](#webhooks) · [Errors](#errors) · [Configuration](#configuration) · [Coming from fal or Higgsfield](#coming-from-fal-or-higgsfield) · [Reference](#reference)

## Install

```sh
npm install https://github.com/sumelabs/sume-js/releases/latest/download/sume-open.tgz
```

The package is not on npm yet. Once it is, the install line will be `npm install @sume-com/open`. It ships ESM and CommonJS builds with TypeScript types.

**Server-side only.** A Sume key spends money, and anything in a page can be read by whoever opens it. If a browser bundle imports the package, the bundle gets a stub that throws and tells you to move the call to your backend. Run it in an API route, a server action or a worker, then send the result to the browser.

## Key

A person makes the key at [open.sume.com → API keys](https://open.sume.com/api-keys). The client reads it from `SUME_API_KEY`, or from a `SUME_API_KEY=` line in `./.env`:

```sh
export SUME_API_KEY="sume_live_..."
```

Nothing else needs setting up. The client calls `https://api.open.sume.com` unless you tell it otherwise (see [Configuration](#configuration)).

## Run a model

```ts
import { run } from "@sume-com/open";

// Text to image
const image = await run("gpt-image-2", "a ceramic cup on a wooden table, morning light", { quality: "low" });
console.log(image.url, image.usd); // https://media.sume.com/…/….png 0.0060

// Edit an image: local files are uploaded first
const night = await run("gpt-image-2", "the same cup at night, candlelight", { image: "cup.png" });

// Image to video, with a budget
const video = await run("grok-imagine-video-1.5", "slow push in, steam rising", {
  image: "cup.png",
  duration: 4,
  resolution: "480p",
  maxUsd: 0.5,
});
await video.save("cup.mp4");

// Lip-sync a clip to speech
const talk = await run("veed-lipsync", { video: "talk.mp4", audio: "line.wav", duration: 6 });

// Burn captions into a clip
const captioned = await run("veed-subtitles", {
  video: "clip.mp4",
  duration: 12,
  captions: { style: "glass", position: "bottom" },
});
```

- **Inputs** use the API's own field names: `quality`, `duration`, `resolution`, `aspect_ratio`, `num_images`, `output_format`, `captions`, and so on. Your editor completes them for the model you named (see [Types](#types)).
- **Media** has short names: `image`, `video`, `audio`, `end_image`, `reference_images` and `mask`. Each value can be an https URL, a file path, bytes (a `Uint8Array` or `Buffer`) or a `Blob`. Anything that is not a URL is uploaded first.
- **`maxUsd`** refuses to submit a request that costs more. It throws `OverBudgetError` before anything is uploaded or charged.
- **`timeoutMs`** is how long `run` waits in all: 30 minutes by default. When it passes, the job keeps running; see [Progress, long jobs and cancel](#progress-long-jobs-and-cancel).
- **`signal`** is an `AbortSignal` that stops the uploads, the submit and the wait.
- **Retries never pay twice.** Every submit carries an idempotency key, and the client's retries reuse it. To retry a submit yourself, pass `idempotencyKey`.
- **A busy account waits.** When the account already runs as many jobs as it may, `run` and `submit` wait for a free slot and submit then, instead of failing.

`run` resolves to a `Result`:

| | |
|---|---|
| `result.url`, `result.urls` | The file URLs |
| `result.files` | `GeneratedFile` objects with `url`, `type`, `contentType`, `width`, `height`, `durationMs`, plus `save()` and `bytes()` |
| `await result.save(path?)` | Downloads every file and returns the absolute paths. A file name: the first file takes it and the rest are numbered. A directory (ending in `/`): the files go inside it. No path: `<model>-<job>.<ext>` in the working directory, never overwriting a file |
| `result.usd` | The price in dollars, as a string like `"0.0060"` |
| `result.job` | The job: `input`, `createdAt`, `completedAt`, and `seconds` (how long it ran) |
| `JSON.stringify(result)` | A summary for a page: `jobId`, `model`, `usd`, `url`, `files`, `seconds` |
| `result.jobId`, `result.model` | Which job made it |

A video's poster frame is left out of `files`; `allFiles` has every file the job made.

## Types

Each model this version knows has its own input type, generated from the live API, with the API's descriptions on hover. The model id picks it, so the editor completes the fields that model takes, and the values it lists (`resolution: "480p" | "720p"` for `seedance-2-mini`). A mistake fails the type check before it costs anything:

```ts
await run("gpt-image-2", "a red kite", { qualty: "low" });
```

```text
error TS2561: Object literal may only specify known properties, but 'qualty' does not exist in type 'RunInput<"gpt-image-2">'. Did you mean to write 'quality'?
```

- `ModelId` lists every model this version knows; `ImageModelId` and `VideoModelId` split them by kind. A model added to the catalog later still works: `run` takes any id, and gives it the general `Input` type.
- `InputOf<"seedance-2-mini">` is that model's fields, and so is the named type `Seedance2MiniInput`. `ImageInput` and `VideoInput` cover every model of a kind.
- Fields with a fixed set of values in the API, like `captions.position` or `background`, are checked. Where the catalog lists a model's own values (`resolution`, `aspect_ratio`, `quality`, `output_format`), those are offered, and any other string is still accepted: the API takes some values that the catalog does not list.
- A field newer than this version goes through `input`: `run("gpt-image-2", "a kite", { input: { new_field: 1 } })`.
- What comes back is typed too: `Result`, `Job`, `Status`, `JobEvent`, `Model`, `Price` and `JobInfo`. Each of them except `Job` keeps the API's own JSON in `raw`.

`node scripts/generate.mjs` rewrites the types from the API, and a weekly check fails when the API moves on.

## Pick a model

Prices differ by more than 100× between models, so name the model yourself. Listing and pricing are free, and need no key:

```ts
import { estimate, model, models } from "@sume-com/open";

for (const m of await models("video")) console.log(m.id, m.price, m.seconds); // seedance-2-mini $0.02936–$0.06352/s [4, 15]
await model("seedance-2-mini"); // inputs, resolutions, limits, price
String(await estimate("seedance-2-mini", "a paper boat", { duration: 8, resolution: "720p" })); // "$0.5082"
```

## Progress, long jobs and cancel

`run` takes callbacks for progress:

```ts
const video = await run("seedance-2-mini", "a paper boat on a pond", {
  duration: 5,
  resolution: "480p",
  onSubmit: (job) => console.log("submitted", job.id), // keep the id: it is all you need later
  onStatus: (status) => console.log(String(status)), // queued (#2 in line), processing, completed
  onEvent: (event) => console.log(event.type), // job.created, job.started, job.completed
});
```

Video can take minutes. Submit now and collect later:

```ts
import { listJobs, result, submit } from "@sume-com/open";

const job = await submit("kling-3", "a red kite over a beach", { duration: 5 });
console.log(job.id);

await job.status(); // one read: queued, processing, completed, failed or canceled
for await (const status of job.poll()) console.log(String(status)); // every read until the job ends
const clip = await job.wait(); // the Result, or JobFailedError

// Later, anywhere, with only the id:
await result("job_7513b52d-3669-4ffe-b317-8b02000715eb");
await job.events(); // the job's life: job.created, job.started, job.completed…
await listJobs({ limit: 10 }); // newest first
```

A job that has not started generating can be canceled, and it is refunded:

```ts
import { cancel, run } from "@sume-com/open";

await cancel(job.id); // true when canceled

// Or give up on a wait, and cancel the job if it is still queued:
await run("kling-3", "a red kite", { duration: 5, timeoutMs: 120_000, cancelOnTimeout: true });
```

`wait`, `poll` and `run` read the status as often as the API asks: at most every 5 s for the first minute, every 10 s after that, and every 15 s after ten minutes. Network errors and errors on Sume's side do not end the wait. When `timeoutMs` passes, `WaitTimeoutError` names the job, and the job keeps running (unless you passed `cancelOnTimeout` and it had not started). Do not submit again: a second submit is a second charge.

## Files

Pass a local file wherever a URL goes, and it is uploaded first: as a short name (`image: "cup.png"`), in a media field (`image_urls: ["a.png", "b.png"]`), or nested, as in `frame_images` or `input_references`:

```ts
import { readFile } from "node:fs/promises";

await run("seedance-2", "the two of them walk into the sea", {
  duration: 5,
  input_references: [{ type: "image_url", image_url: { url: await readFile("her.png") } }],
});
```

A file can be a path, a `file:` URL, bytes (a `Uint8Array`, `Buffer` or `ArrayBuffer`) or a `Blob`. A plain string counts as a path only where a media URL belongs, so a prompt or `metadata` is never mistaken for a file. To get a URL first, for reuse:

```ts
import { upload } from "@sume-com/open";

const url = await upload("photo.png");
const fromBytes = await upload(pngBytes, { contentType: "image/png" });
```

Downloads stream to a `.part` file and are renamed when complete, so an interrupted download never leaves half a file behind. The API key is sent to the API only, never to the storage or media hosts.

## In a web app

A `Result` turns into JSON by itself, so a handler can return it. In a Next.js route handler:

```ts
// app/api/images/route.ts
import { run } from "@sume-com/open";

export async function POST(request: Request) {
  const { prompt } = await request.json();
  const image = await run("gpt-image-2", prompt, { quality: "low", maxUsd: 0.05, signal: request.signal });
  return Response.json(image); // { jobId, model, usd: "0.0060", url, files: […], seconds: 14.2 }
}
```

Video takes minutes: hand back the job id, and let the page poll:

```ts
// app/api/videos/route.ts
import { submit } from "@sume-com/open";

export async function POST(request: Request) {
  const { prompt } = await request.json();
  const job = await submit("seedance-2-mini", prompt, { duration: 5, resolution: "480p", maxUsd: 0.5 });
  return Response.json({ jobId: job.id });
}

// app/api/videos/[id]/route.ts
import { result, status } from "@sume-com/open";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = await status(id);
  return Response.json(now.ok ? await result(id) : { state: now.state });
}
```

From a server action, return `image.toJSON()`: a server action can send plain objects only. With Express:

```ts
app.post("/images", async (req, res) => {
  res.json(await run("gpt-image-2", req.body.prompt, { quality: "low", maxUsd: 0.05 }));
});
```

## Webhooks

Pass `webhook_url` with your inputs, and Sume POSTs the finished job there when it ends. Each delivery is signed, and `verifyWebhook` checks the signature:

```ts
import { verifyWebhook } from "@sume-com/open";

export async function POST(request: Request) {
  const body = await request.text(); // the raw body, exactly as received
  if (!verifyWebhook(body, request.headers, signingSecret)) return new Response("bad signature", { status: 401 });
  const delivery = JSON.parse(body);
  // …
  return new Response("ok");
}
```

The scheme is `sume-v1`: an HMAC-SHA256 over `{x-sume-webhook-timestamp}.{raw body}`, sent in `x-sume-webhook-signature`. Deliveries older than 10 minutes are refused (`toleranceSeconds`). While a secret rotates, either the old or the new secret passes. `headers` may be a `Headers` object or a plain object, as from Express or Node.

An open.sume.com key cannot read the signing secret through the API yet (`GET /v1/webhooks/signing-secret` answers `open_key_route_not_allowed`). Until it can, collect results with `job.wait()` or `result(jobId)` instead.

## Errors

Every error is a `SumeError`. Its `message` says what went wrong, then what to do in a `Fix:` line. This one is real output, for an aspect ratio that gpt-image-2 does not take:

```text
InvalidRequestError: Invalid request body, parameters, or headers. (request req_1e9a5dc2…)
  - aspect_ratio: must be equal to one of the allowed values
Fix: gpt-image-2 takes aspect_ratio auto, 1:1, 16:9, 9:16, 4:3, 3:4, 5:4, 9:8, 4:5. See all its fields with model("gpt-image-2").
```

When the API refuses fields, each one is in `error.fieldErrors`, to show next to a form:

```ts
import { InvalidRequestError, run } from "@sume-com/open";

try {
  await run("gpt-image-2", "a kite", { quality: "low", aspect_ratio: "7:3" });
} catch (error) {
  if (!(error instanceof InvalidRequestError)) throw error;
  for (const field of error.fieldErrors) console.log(field.path, field.message); // aspect_ratio must be equal to one of the allowed values
}
```

| Error | When |
|---|---|
| `AuthenticationError` | There is no key, the key is wrong or revoked, or it was made for another host |
| `InsufficientFundsError` | The balance is below the price. Nothing was charged |
| `OverBudgetError` | The price is over `maxUsd`. Nothing was submitted |
| `InvalidRequestError` | A field is missing, wrong, or not taken by this model (`fieldErrors` says which). `NotFoundError` covers an unknown model or job; for a model it suggests the closest id |
| `RateLimitError` | Too many requests, or a slot did not free up within the wait |
| `JobFailedError` | The job failed or was canceled. It is refunded; `jobId` and the reason are on the error |
| `WaitTimeoutError` | `timeoutMs` passed. The job is still running; `result(error.jobId)` picks it up |
| `APIError`, `APIConnectionError` | A problem on Sume's side, or the network. `retryable` says whether trying again can help |

Each error also has `code`, `hint`, `status`, `requestId`, `jobId` and `details`. Quote `requestId` to support. When a submit's outcome is unknown (the network dropped, or Sume answered 5xx), the error names the idempotency key in `idempotencyKey` and in the `Fix:` line: pass it back to get that job instead of paying twice.

## Configuration

```ts
import { Sume } from "@sume-com/open";

const sume = new Sume({
  apiKey: process.env.MY_SUME_KEY, // default: SUME_API_KEY, then ./.env
  baseUrl: "https://api.open.sume.com", // default: SUME_API_BASE_URL, then this
  timeoutMs: 60_000, // per HTTP request
  maxRetries: 3, // for reads, and for submits (which carry an idempotency key)
  headers: { "X-Trace-Id": "…" }, // sent to the API only, never to storage or media hosts
  fetch: globalThis.fetch, // your own fetch, for proxies or tests
});
await sume.run("gpt-image-2", "a kite");
```

To see each API call, run with `NODE_DEBUG=sume`:

```text
$ NODE_DEBUG=sume node app.mjs
SUME 4183: POST /v1/image-router/generate -> 202 (request req_9c1…, attempt 1, 412 ms)
```

| Host | What it is |
|---|---|
| `https://api.open.sume.com` (default) | Open's production API. Keys come from open.sume.com |
| `https://open-api-development.up.railway.app` | Open's development API, for Sume staff. Keys come from open.dev.sume.com |
| `https://api.sume.com` | **Not Open.** This is sume.com's own API, and Open keys do not work there |

A key works only on the host it was made for. On another host it is refused as if it were wrong, and the error says so.

## Coming from fal or Higgsfield

| | `@fal-ai/client` | `@higgsfield/client` (v2) | `@sume-com/open` |
|---|---|---|---|
| Run and wait | `fal.subscribe("fal-ai/flux/dev", { input: { prompt } })` | `higgsfield.subscribe("flux-pro/kontext/max/text-to-image", { input: { prompt } })` | `run("flux-2-pro", prompt)` |
| Get the file | `result.data.images[0].url`, then download it yourself | `jobSet.jobs[0].results?.raw.url`, then download it yourself | `await result.save("out.png")` |
| Local file in | A `Blob` in the input, or `fal.storage.upload(blob)` | Upload it yourself, then pass the URL | A path, bytes or a `Blob`: `{ image: "photo.png" }` |
| Queue | `fal.queue.submit`, `.status`, `.result`, `.cancel` | `withPolling: false`, then poll yourself | `submit`, then `job.status()`, `job.wait()`, `job.cancel()` |
| Progress | `onQueueUpdate`, `logs: true` | None | `onStatus`, `onEvent`, `onSubmit` |
| Price | Not in the client | Not in the client | `estimate(…)` and `maxUsd` |
| Types | Generated per endpoint | `input` is `any` | Generated per model, from the live API |
| Key in a browser | Works; a server proxy is advised | Refused | Refused: the browser build throws |
| Errors | `ApiError`, `ValidationError` | `HiggsfieldError` and subclasses | One class per case, each with a `Fix:` line |

## Reference

The module functions use a shared default client; `new Sume(options)` has the same methods.

| Call | Resolves to |
|---|---|
| `run(model, prompt?, { …fields, maxUsd, timeoutMs, idempotencyKey, onSubmit, onStatus, onEvent, cancelOnTimeout, signal, input })` | `Result` |
| `submit(model, prompt?, { …fields, maxUsd, idempotencyKey, signal, input })` | `Job` |
| `estimate(model, prompt?, { …fields, input })` | `Price` (`usd`, `usdMicros`, `String()` → `"$0.0060"`) |
| `models(kind?)`, `model(id)` | `Model[]`, `Model` (`id`, `name`, `kind`, `price`, `priceFrom`, `per`, `resolutions`, `seconds`, `inputs`) |
| `upload(file, { contentType?, signal? })` | the file's URL |
| `job(id)` | `Job`, without a call (not a promise) |
| `status(id)` | `Status` (`state`, `done`, `ok`, `queuePosition`) |
| `result(id, { timeoutMs, onStatus, onEvent, cancelOnTimeout, signal })` | `Result`, waiting if the job is still running |
| `cancel(id)` | `true` when canceled |
| `listJobs({ limit?, status? })` | `JobInfo[]` |
| `verifyWebhook(body, headers, secret, { toleranceSeconds? })` | `boolean` (not a promise) |
| `job.status()`, `job.poll(options)`, `job.wait(options)`, `job.cancel()`, `job.events()`, `job.info()` | `Status`, an async iterator of `Status`, `Result`, `boolean`, `JobEvent[]`, `JobInfo` |
| `result.save(path?)`, `file.save(path?)`, `file.bytes()`, `result.toJSON()` | paths, a path, a `Uint8Array`, a plain object |

## Also

- [`sume`](https://github.com/sumelabs/sume-python), the Python client.
- [`opensume`](https://github.com/sumelabs/opensume-cli), the command-line tool for the same API.
- [`@sume-com/sdk`](https://www.npmjs.com/package/@sume-com/sdk) is a different package, for sume.com's own API (Formats and Agents).
- API docs: https://open.sume.com/docs

## License

MIT
