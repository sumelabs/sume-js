# @sume-com/open

The JavaScript and TypeScript client for the [Sume Open API](https://open.sume.com). It can run any open.sume.com model for images, video, lip-sync and captions, priced in dollars. Uploads, waiting, retries and downloads are handled for you. It runs on Node 20 or newer (and Bun), server-side only, with no dependencies.

```ts
import { run } from "@sume-com/open";

const image = await run("gpt-image-2", "a red kite over a beach", { quality: "low" });
await image.save("kite.png");
```

That is the whole program. `run` prices the request, submits it, waits for the job, and returns the files. `save` writes them to disk and returns the paths.

- [Install](#install)
- [Key](#key)
- [Run a model](#run-a-model)
- [Pick a model](#pick-a-model)
- [Long jobs](#long-jobs)
- [Files](#files)
- [Webhooks](#webhooks)
- [Errors](#errors)
- [Configuration](#configuration)

## Install

```sh
npm install https://github.com/sumelabs/sume-js/releases/latest/download/sume-open.tgz
```

The package is not on npm yet; once it is, the install line will be `npm install @sume-com/open`. It ships ESM and CommonJS builds with TypeScript types.

**Server-side only.** A Sume key spends money, and anything in a page can be read by whoever opens it. If a browser bundle imports the package, the bundle resolves to a stub that throws and tells you to move the call to your backend. Run it in an API route, a server action or a worker, then send the result to the browser.

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
console.log(image.url, image.usd);   // https://media.sume.com/…/images.png 0.0077

// Edit an image: local files are uploaded first
const night = await run("gpt-image-2", "the same cup at night, candlelight", { image: "cup.png" });

// Image to video, with a budget
const video = await run("grok-imagine-video-1.5", "slow push in, steam rising", {
  image: "cup.png", duration: 4, resolution: "480p", maxUsd: 0.1,
});
await video.save("cup.mp4");

// Lip-sync a clip to speech
const talk = await run("veed-lipsync", { video: "talk.mp4", audio: "line.wav", duration: 6 });

// Burn captions into a clip
const captioned = await run("veed-subtitles", { video: "clip.mp4", duration: 12, captions: { style: "glass" } });
```

- **Inputs** use the API's own field names: `quality`, `duration`, `resolution`, `aspect_ratio`, `num_images`, `output_format`, `captions`, and so on. `model(id)` lists what a model takes.
- **Media** has short names: `image`, `video`, `audio`, `end_image`, `reference_images` and `mask`. Each value can be an https URL, a file path, bytes (a `Uint8Array` or `Buffer`) or a `Blob`. Anything that is not a URL is uploaded first.
- **`maxUsd`** refuses to submit a request that costs more. It throws `OverBudgetError` before anything is uploaded or charged.
- **`timeoutMs`** is how long `run` waits, 30 minutes by default. When it passes, the job keeps running; see [Long jobs](#long-jobs).
- **`onStatus`** is called with each status read. **`signal`** is an `AbortSignal` that stops the wait.
- **Retries never pay twice.** Every submit carries an idempotency key, and the client's retries reuse it. To retry a submit yourself, pass `idempotencyKey`.

`run` resolves to a `Result`:

| | |
|---|---|
| `result.url`, `result.urls` | The file URLs |
| `result.files` | `GeneratedFile` objects with `url`, `type`, `contentType`, `width`, `height`, `durationMs`, plus `save()` and `bytes()` |
| `await result.save(path?)` | Downloads every file and returns the absolute paths. A file name: the first file takes it and the rest are numbered. A directory (ending in `/`): the files go inside it. No path: `<model>-<job>.<ext>` in the working directory, never overwriting a file |
| `result.usd` | The price in dollars, as a string like `"0.0077"` |
| `result.jobId`, `result.model` | Which job made it |

A video's poster frame is left out of `files`; `allFiles` has every file the job made.

## Pick a model

Prices differ by more than 100× between models, so name the model yourself. Listing and pricing are free, and need no key:

```ts
import { estimate, model, models } from "@sume-com/open";

for (const m of await models("video")) console.log(m.id, m.price, m.seconds);   // seedance-2-mini $0.0879–$0.1890/s [4, 15]
await model("seedance-2-mini");                                                  // inputs, resolutions, limits, price
String(await estimate("seedance-2-mini", "a paper boat", { duration: 8, resolution: "720p" }));   // "$1.5120"
```

## Long jobs

Video can take minutes. Submit now and collect later:

```ts
import { cancel, listJobs, result, submit } from "@sume-com/open";

const job = await submit("kling-3", "a red kite over a beach", { duration: 5 });
console.log(job.id);                         // keep this; it is all you need later

await job.status();                          // one read: queued, processing, completed, failed or canceled
for await (const status of job.poll()) console.log(String(status));
const video = await job.wait();              // the Result, or JobFailedError

// Later, anywhere, with only the id:
await result("job_7513b52d-3669-4ffe-b317-8b02000715eb");
await cancel(job.id);                        // before generation starts; refunded
await job.events();                          // job.created, job.started, job.completed…
await listJobs({ limit: 10 });               // newest first
```

`wait`, `poll` and `run` read the status as often as the API asks, at most every 5 s for the first minute and every 15 s after ten. Network errors and errors on Sume's side do not end the wait. When `timeoutMs` passes, `WaitTimeoutError` names the job, and the job keeps running. Do not submit again: a second submit is a second charge.

## Files

`run` uploads local files itself. To get a URL first:

```ts
import { upload } from "@sume-com/open";

const url = await upload("photo.png");                          // a path, bytes, or a Blob
const fromBytes = await upload(pngBytes, { contentType: "image/png" });
```

Downloads stream to a `.part` file and are renamed when complete, so an interrupted download never leaves half a file behind. The API key is sent to the API only, never to the storage or media hosts.

## Webhooks

Pass `webhook_url` with your inputs, and Sume POSTs the finished job there when it ends. Each delivery is signed, and `verifyWebhook` checks the signature:

```ts
import { verifyWebhook } from "@sume-com/open";

export async function POST(request: Request) {
  const body = await request.text();          // the raw body, exactly as received
  if (!verifyWebhook(body, request.headers, signingSecret)) return new Response("bad signature", { status: 401 });
  const delivery = JSON.parse(body);
  // …
  return new Response("ok");
}
```

The scheme is `sume-v1`: an HMAC-SHA256 over `{x-sume-webhook-timestamp}.{raw body}`, sent in `x-sume-webhook-signature`. Deliveries older than 10 minutes are refused (`toleranceSeconds`). While a secret rotates, either the old or the new secret passes. `headers` may be a `Headers` object or a plain object, as from Express or Node.

An open.sume.com key cannot read the signing secret through the API (`GET /v1/webhooks/signing-secret` answers `open_key_route_not_allowed`). Until it can, you can poll with `job.wait()` or `result(jobId)` instead of relying on webhooks.

## Errors

Every error is a `SumeError`. Its `message` gives what went wrong, then a `Fix:` line:

```text
InsufficientFundsError: Balance too low. (request req_4f2…)
Fix: Top up at https://open.sume.com/billing. It needs $0.3516; the balance is $0.12.
```

| Error | When |
|---|---|
| `AuthenticationError` | There is no key, the key is wrong or revoked, or it was made for another host |
| `InsufficientFundsError` | The balance is below the price. Nothing was charged |
| `OverBudgetError` | The price is over `maxUsd`. Nothing was submitted |
| `InvalidRequestError` | A field is missing, wrong, or not taken by this model. `NotFoundError` covers an unknown model or job; for a model it suggests the closest id |
| `RateLimitError` | Too many requests, or too many jobs running at once |
| `JobFailedError` | The job failed or was canceled. It is refunded; `jobId` and the reason are on the error |
| `WaitTimeoutError` | `timeoutMs` passed. The job is still running; `result(error.jobId)` picks it up |
| `APIError`, `APIConnectionError` | A problem on Sume's side, or the network. `retryable` says whether trying again can help |

Each error also has `code`, `hint`, `status`, `requestId`, `jobId` and `details`. Quote `requestId` to support.

## Configuration

```ts
import { Sume } from "@sume-com/open";

const sume = new Sume({
  apiKey: process.env.MY_SUME_KEY,           // default: SUME_API_KEY, then ./.env
  baseUrl: "https://api.open.sume.com",      // default: SUME_API_BASE_URL, then this
  timeoutMs: 60_000,                         // per HTTP request
  maxRetries: 3,                             // for reads, and for submits (which carry an idempotency key)
  fetch: globalThis.fetch,                   // your own fetch, for proxies or tests
});
await sume.run("gpt-image-2", "a kite");
```

| Host | What it is |
|---|---|
| `https://api.open.sume.com` (default) | Open's production API. Keys come from open.sume.com |
| `https://open-api-development.up.railway.app` | Open's development API, for Sume staff. Keys come from open.dev.sume.com |
| `https://api.sume.com` | **Not Open.** This is sume.com's own API, and Open keys do not work there |

A key works only on the host it was made for. On another host it is refused as if it were wrong, and the error says so.

## Also

- [`sume`](https://github.com/sumelabs/sume-python), the Python client.
- [`opensume`](https://github.com/sumelabs/opensume-cli), the command-line tool for the same API.
- [`@sume-com/sdk`](https://www.npmjs.com/package/@sume-com/sdk) is a different package, for sume.com's own API (Formats and Agents).
- API docs: https://open.sume.com/docs

## License

MIT
