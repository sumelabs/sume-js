# Sume SDK for Node.js and TypeScript

Official SDK for Sume's image and video generation API, the [Sume Open API](https://open.sume.com/docs) at `https://api.open.sume.com`.

sume-js follows the shape of Higgsfield's JavaScript client, [higgsfield-js](https://github.com/higgsfield-ai/higgsfield-js): the same `config()`, `subscribe()`, `withPolling` and error classes. Only the calls and the host are Sume's. [Coming from Higgsfield](#coming-from-higgsfield) lists every difference.

## Installation

```bash
npm install @sume-com/client
```

> Not on npm yet. Until the first release, install it from GitHub: `npm install github:sumelabs/sume-js`

---

## Client

The client is exported from `@sume-com/client/v2`, the same path as Higgsfield's v2 client, and from the package root. It features:
- Single `credentials` field: one Sume API key (`sume_live_...`)
- `Authorization: Bearer <key>` authentication header
- `User-Agent: sume-server-js/<version>` header
- Server-side only (browser usage blocked for security)
- Simplified API with `subscribe()` method: name a model, or a router path
- Automatic polling via `/v1/jobs/{id}/status`, then the result from `/v1/jobs/{id}/result`
- Safe retries: every submit carries an `Idempotency-Key`, so a retried submit never makes a second, billed job

### Quick Start

```typescript
import { sume, config } from '@sume-com/client/v2';

// Configure credentials
config({
  credentials: 'YOUR_SUME_API_KEY'
});

// Generate content
const response = await sume.subscribe('gpt-image-2', {
  input: {
    prompt: 'A ceramic coffee cup on a wooden table, soft morning light',
    quality: 'low',
    aspect_ratio: '1:1'
  },
  withPolling: true
});

if (response.status === 'completed') {
  console.log('Image URL:', response.images?.[0].url);
}
```

`gpt-image-2` at `quality: 'low'` costs $0.006 an image. Every model and its dollar price is in the [open model catalog](https://open.sume.com/docs/reference/catalog/list).

### Authentication

Make a key at [open.sume.com → API keys](https://open.sume.com/api-keys). A key spends your open.sume.com balance, in US dollars. Keep it on your server.

**Option 1: Single credentials field (recommended)**
```typescript
import { config } from '@sume-com/client/v2';

config({
  credentials: 'YOUR_SUME_API_KEY'
});
```

**Option 2: `apiKey` field**
```typescript
config({
  apiKey: 'YOUR_SUME_API_KEY'
});
```

**Option 3: Environment variable**
```bash
export SUME_API_KEY="sume_live_..."
```

```typescript
// No config needed - automatically reads SUME_API_KEY from the environment
import { sume } from '@sume-com/client/v2';
```

### Creating a Client Instance

```typescript
import { createSumeClient } from '@sume-com/client/v2';

const client = createSumeClient({
  credentials: 'YOUR_SUME_API_KEY'
});
```

Explicit client instances keep their credentials separate. `client.configure()` updates only that instance; module-level `config()` updates the shared `sume` client.

### API Methods

#### `subscribe(endpoint, options)`

Submit a job and wait for its result:

```typescript
const response = await sume.subscribe('seedance-2.5', {
  input: {
    prompt: 'Steam rises from the cup as the camera slowly pushes in',
    duration: 5,
    resolution: '480p',
    aspect_ratio: '16:9'
  },
  withPolling: true,   // Automatically poll for job completion (default: true)
  webhook: {           // Optional webhook
    url: 'https://your-webhook-url.com/callback'
  }
});
```

**Parameters:**
- `endpoint` (string): A model id from the [open model catalog](https://open.sume.com/docs/reference/catalog/list) (e.g., `'gpt-image-2'`), or an API path with `model` in the input: `'/v1/image-router/generate'` for images, `'/v1/video-router/generate'` for video, lip-sync and captions
- `options.input` (object): Input parameters for the model (`prompt`, `aspect_ratio`, `duration`, `image_url` and so on)
- `options.withPolling` (boolean, default: `true`): Automatically poll for job completion
- `options.webhook` (object, optional): Webhook configuration
  - `url` (string): Public HTTPS URL that Sume calls when the job ends
- `options.idempotencyKey` (string, optional): Your own `Idempotency-Key` (1 to 255 printable ASCII characters). Without it, the SDK makes a UUID for each call

**Note:** When a webhook is provided, the SDK sends `mode: "webhook"` and `webhook_url` in the request body.

Sume runs every model behind two routers. For a model id, the SDK reads the model's `kind` once from the public catalog (`GET /v1/open/catalog/{id}`), then submits to the image router (`image`) or the video router (`video`, `lipsync`, `captions`) with `model` in the body. An unknown id fails there, before any job. Each model's fields and accepted values are in its catalog row: [image models](https://open.sume.com/docs/reference/images/list-models), [video models](https://open.sume.com/docs/reference/video/list-models).

#### `upload(data, contentType)`

Upload a file that is not online yet, and get an HTTPS URL to pass to a model:

```typescript
import { readFile } from 'node:fs/promises';

const audioUrl = await sume.upload(await readFile('speech.wav'), 'audio/wav');
```

The SDK asks `POST /v1/files/generate-upload-url` for a place to put the file, `PUT`s the bytes there without your API key, and returns the file's `public_url`. Uploading is free.

#### `uploadImage(imageBuffer, format?)`

`upload()` for an image: `format` is `'jpeg'` (default), `'png'` or `'webp'`.

```typescript
const imageUrl = await sume.uploadImage(await readFile('photo.png'), 'png');
```

### Examples

#### Text-to-Image Generation

```typescript
import { sume, config } from '@sume-com/client/v2';

config({
  credentials: 'YOUR_SUME_API_KEY'
});

const response = await sume.subscribe('nano-banana-pro', {
  input: {
    prompt: 'A majestic mountain landscape at sunset',
    aspect_ratio: '16:9'
  },
  withPolling: true
});

if (response.status === 'completed') {
  console.log('Image URL:', response.images?.[0].url);
}
```

#### Image Editing

```typescript
const response = await sume.subscribe('gpt-image-2', {
  input: {
    prompt: 'Make the cup cobalt blue, keep everything else the same',
    quality: 'low',
    image_urls: ['https://example.com/cup.png']
  }
});
```

#### Image-to-Video Generation

```typescript
import { readFile } from 'node:fs/promises';

const imageUrl = await sume.uploadImage(await readFile('cup.png'), 'png');

const response = await sume.subscribe('/v1/video-router/generate', {
  input: {
    model: 'seedance-2.5',
    prompt: 'Cinematic camera movement around the cup',
    image_url: imageUrl,
    duration: 5,
    resolution: '480p'
  },
  withPolling: true
});

if (response.status === 'completed') {
  console.log('Video URL:', response.video?.url);
}
```

#### Lip-sync

```typescript
const response = await sume.subscribe('veed-fabric-1.0', {
  input: {
    image_url: await sume.uploadImage(await readFile('face.jpg')),
    audio_url: await sume.upload(await readFile('speech.wav'), 'audio/wav'),
    duration: 8,
    resolution: '480p'
  }
});
```

### Polling & Status Lifecycle

The client automatically polls `/v1/jobs/{id}/status` when `withPolling` is `true`. It waits as long as the API asks (`next_poll_after_seconds`, 2 seconds while a job runs) and never less than `pollInterval`. It keeps polling through `5xx`, `429` and dropped connections. When the job completes, it reads `/v1/jobs/{id}/result`.

**Status Values:**
- `queued` – Request accepted and waiting for a worker
- `in_progress` – Generation currently running
- `completed` – Generation finished and media URLs are returned
- `nsfw` – Content refused by the model's or Sume's content policy (`error.public_reason` is `content_policy_rejected`); the price is refunded
- `failed` – Generation errored; the price is refunded and `error` says why
- `canceled` – Canceled before generation started; the price is refunded

**API Response Format:**

The status call answers with Sume's job status:

```json
{
  "data": {
    "request_id": "job_7513b52d-3669-4ffe-b317-8b02000715eb",
    "job_id": "job_7513b52d-3669-4ffe-b317-8b02000715eb",
    "status": "COMPLETED",
    "sume_status": "completed",
    "status_url": "https://api.open.sume.com/v1/jobs/job_7513b52d-3669-4ffe-b317-8b02000715eb/status",
    "result_url": "https://api.open.sume.com/v1/jobs/job_7513b52d-3669-4ffe-b317-8b02000715eb/result",
    "cancel_url": null,
    "next_action": "fetch_result",
    "terminal": true
  }
}
```

The SDK turns it, and the result's artifacts, into one `V2Response`:

```json
{
  "status": "completed",
  "request_id": "job_7513b52d-3669-4ffe-b317-8b02000715eb",
  "status_url": "https://api.open.sume.com/v1/jobs/job_7513b52d-3669-4ffe-b317-8b02000715eb/status",
  "cancel_url": null,
  "result_url": "https://api.open.sume.com/v1/jobs/job_7513b52d-3669-4ffe-b317-8b02000715eb/result",
  "images": [{ "url": "https://media.sume.com/artifacts/artf_.../images.png" }],
  "artifacts": [
    {
      "id": "artf_...",
      "type": "image",
      "url": "https://media.sume.com/artifacts/artf_.../images.png",
      "content_type": "image/png"
    }
  ]
}
```

`images` holds every image artifact and `video` the first video artifact, as in the Higgsfield client. `artifacts` keeps every artifact as Sume returns it, audio included. A failed job resolves with `status: 'failed'` (or `'nsfw'`) and `error` (`code`, `message`, `public_reason`), not an exception. Artifacts live on `media.sume.com` and are readable by anyone with the link; copy them to your own storage if you need to control access.

### Working with the Response

```typescript
const response = await sume.subscribe('gpt-image-2', {
  input: { prompt: 'Test', quality: 'low', num_images: 2 },
  withPolling: true
});

// Check status
console.log('Request ID:', response.request_id);
console.log('Status:', response.status);

// Access results
for (const image of response.images ?? []) {
  console.log('Result URL:', image.url);
}
if (response.status === 'failed' || response.status === 'nsfw') {
  console.error(response.error?.code, response.error?.message);
}
```

### Long Jobs and Resuming

`maxPollTime` (5 minutes by default) bounds the wait. When it runs out, `subscribe()` throws `TimeoutError`, and **the job keeps running**. Do not submit a new job: call `subscribe()` again with the same input and the error's `idempotencyKey`. Sume returns the same job, charges it once, and the SDK keeps waiting.

```typescript
import { TimeoutError } from '@sume-com/client/v2';

const input = { prompt: 'A paper boat drifting down a rain gutter', duration: 10 };

try {
  await sume.subscribe('seedance-2.5', { input });
} catch (error) {
  if (error instanceof TimeoutError) {
    const response = await sume.subscribe('seedance-2.5', {
      input,
      idempotencyKey: error.idempotencyKey
    });
    console.log(response.video?.url);
  }
}
```

The same works across processes: pass your own `idempotencyKey`, store it, and submit with `withPolling: false`. Later, the same call with `withPolling: true` waits for that job.

### Webhooks

```typescript
await sume.subscribe('kling-3', {
  input: { prompt: 'A slow dolly shot through a neon market at night', duration: 5 },
  webhook: { url: 'https://example.com/hooks/sume' },
  withPolling: false
});
```

Sume POSTs `job.completed`, `job.failed` or `job.canceled` to the URL once the job ends, and retries for about three hours until it gets a `2xx`. Every delivery is signed with your workspace's signing secret (dashboard → **Webhooks**). Check it with `verifyWebhook` on the raw body before you trust the event:

```typescript
import { verifyWebhook, WebhookEvent } from '@sume-com/client';

export async function POST(request: Request) {
  const body = await request.text();
  const valid = verifyWebhook(
    body,
    request.headers.get('x-sume-webhook-timestamp') ?? undefined,
    request.headers.get('x-sume-webhook-signature') ?? undefined,
    process.env.SUME_WEBHOOK_SECRET!
  );
  if (!valid) {
    return new Response('invalid signature', { status: 401 });
  }
  const event = JSON.parse(body) as WebhookEvent;
  console.log(event.event, event.job_id, event.payload?.artifacts[0]?.url);
  return new Response('ok');
}
```

`verifyWebhook` accepts any `sume-v1=` signature in the header (there is one per live secret during a rotation) and refuses deliveries more than five minutes old. A delivery can arrive more than once: dedupe on `job_id`.

### Configuration

```typescript
import { createSumeClient } from '@sume-com/client/v2';

const client = createSumeClient({
  credentials: 'YOUR_SUME_API_KEY',

  // Optional configuration
  baseURL: 'https://api.open.sume.com', // Default
  timeout: 120000, // 2 minutes default
  maxRetries: 3,
  retryBackoff: 1000,
  retryMaxBackoff: 60000,
  pollInterval: 2000, // Check every 2 seconds at most
  maxPollTime: 300000, // Timeout after 5 minutes
  headers: {
    'X-Custom-Header': 'value'
  }
});
```

Retries cover network errors, `429` and `5xx`, with exponential backoff and jitter, and follow `retry-after`. A `4xx` is never retried. Raise `maxPollTime` for long video, which can take several minutes.

### TypeScript Support

```typescript
import {
  createSumeClient,
  SumeClient,
  V2Response
} from '@sume-com/client/v2';

const client: SumeClient = createSumeClient({
  credentials: 'YOUR_SUME_API_KEY'
});

const response: V2Response = await client.subscribe('/v1/image-router/generate', {
  input: {
    model: 'gpt-image-2',
    prompt: 'Test',
    aspect_ratio: '1:1'
  }
});
```

The two router paths type their input (`ImageGenerateInput`, `VideoGenerateInput`): `model` is required, the documented fields are checked, and model-specific fields pass through. A model id takes any input object.

---

## Error Handling

The SDK provides comprehensive error handling with specific error types:

```typescript
import {
  AuthenticationError,
  BadInputError,
  ValidationError,
  NotEnoughCreditsError,
  APIError,
  TimeoutError,
  BrowserNotSupportedError
} from '@sume-com/client';

try {
  const response = await sume.subscribe('gpt-image-2', {
    input: { prompt: 'Test' }
  });
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('❌ Authentication failed - check your API key');
  } else if (error instanceof NotEnoughCreditsError) {
    console.error('💳 Insufficient funds - add funds at open.sume.com/billing');
  } else if (error instanceof BadInputError) {
    console.error('📋 Invalid input parameters:', error.message, error.details);
  } else if (error instanceof ValidationError) {
    console.error('⚠️  Validation error:', error.message);
  } else if (error instanceof TimeoutError) {
    console.error('⏱️  Still running, resume with idempotencyKey', error.idempotencyKey);
  } else if (error instanceof APIError) {
    console.error('🌐 API Error:', error.statusCode, error.code, error.requestId, error.message);
  } else if (error instanceof BrowserNotSupportedError) {
    console.error('🚫 Browser usage not supported - use Node.js environment');
  } else {
    console.error('💥 Unexpected error:', error);
  }
}
```

| Class | When | Sume `code` |
|---|---|---|
| `AuthenticationError` | `401` | `unauthorized` |
| `NotEnoughCreditsError` | `402` | `insufficient_funds`; `responseData.error.details` has `required_usd` and `available_usd` |
| `BadInputError` | `400` | `invalid_request` (`details` lists each field and why), `concurrency_limit_reached`, `bad_request` |
| `ValidationError` | `422` | |
| `APIError` | any other status | `open_key_route_not_allowed` (`403`), `not_found` and `model_not_found` (`404`), `idempotency_conflict` (`409`), `rate_limited` (`429`), `database_busy` (`503`), `internal_error` (`500`) |
| `TimeoutError` | `maxPollTime` ran out; the job keeps running | |
| `CredentialsMissedError` | no key in config or `SUME_API_KEY` | |
| `BrowserNotSupportedError` | the SDK was loaded in a browser | |

Every API error carries `statusCode`, Sume's stable `code`, the `requestId` to quote to support, and the full body in `responseData`. A network error is an `APIError` with no `statusCode` and the system `code` (`ECONNRESET`, `ENOTFOUND`, ...). Errors never carry your API key or a signed upload URL. All of them extend `SumeError`.

A workspace may have only so many jobs queued or running at once (2 to 40, by the funds added in the past 28 days). A submit past the cap is refused with `BadInputError` and `code: 'concurrency_limit_reached'`, and is not charged. Wait for a job to end, then submit the next.

### Job Status Handling

```typescript
switch (response.status) {
  case 'completed':
    console.log('Success:', response.images?.[0]?.url ?? response.video?.url);
    break;
  case 'failed':
    console.error('Generation failed:', response.error?.message);
    break;
  case 'nsfw':
    console.warn('Content flagged as NSFW');
    break;
  case 'canceled':
    console.warn('Job was canceled');
    break;
}
```

---

## Best Practices

1. **Name the model yourself**: prices differ by more than 100× between models. The [catalog](https://open.sume.com/docs/reference/catalog/list) lists every model's dollar price, and [Estimate a price](https://open.sume.com/docs/reference/catalog/estimate) prices a request for free.

2. **Upload large files**: a local image, clip or audio file goes up once with `upload()` / `uploadImage()`, and its URL works in any input field:
   ```typescript
   const imageUrl = await sume.uploadImage(localImageBuffer, 'jpeg');
   ```

3. **Handle rate limits**: configure exponential backoff for retries:
   ```typescript
   const client = createSumeClient({
     credentials: 'YOUR_SUME_API_KEY',
     maxRetries: 5,
     retryBackoff: 2000,
     retryMaxBackoff: 30000
   });
   ```

4. **Use webhooks for long operations**: for video, a webhook saves the polling. Keep a slow poll as a fallback in case a delivery is lost.

5. **Never resubmit a running job**: after a `TimeoutError` or a crash, call `subscribe()` again with the same `idempotencyKey`. A new key is a new, billed job.

6. **Environment variables**: store your key in the environment:
   ```bash
   export SUME_API_KEY="sume_live_..."
   ```

---

## Coming from Higgsfield

| higgsfield-js | sume-js |
|---|---|
| `npm install @higgsfield/client` | `npm install @sume-com/client` |
| `import { higgsfield, config } from '@higgsfield/client/v2'` | `import { sume, config } from '@sume-com/client/v2'` |
| `createHiggsfieldClient()`, `HiggsfieldClient`, `HiggsfieldError` | `createSumeClient()`, `SumeClient`, `SumeError` |
| `config({ credentials: 'KEY_ID:KEY_SECRET' })` | `config({ credentials: 'sume_live_...' })` |
| `HF_CREDENTIALS`, `HF_KEY`, `HF_API_KEY` + `HF_API_SECRET` | `SUME_API_KEY` |
| `Authorization: Key KEY_ID:KEY_SECRET` | `Authorization: Bearer sume_live_...` |
| `https://api.higgsfield.ai` | `https://api.open.sume.com` |
| `subscribe('flux-pro/kontext/max/text-to-image', { input })` | `subscribe('flux-kontext-max', { input })`, routed by the catalog's `kind`; or `subscribe('/v1/image-router/generate', { input: { model: 'flux-kontext-max', ... } })` |
| polls `/requests/{request_id}/status` | polls `/v1/jobs/{id}/status`, then reads `/v1/jobs/{id}/result` |
| `webhook: { url, secret }` becomes `?hf_webhook=<url>` | `webhook: { url }` becomes `mode: "webhook"` and `webhook_url`; check deliveries with `verifyWebhook()` |
| statuses `queued`, `in_progress`, `completed`, `failed`, `nsfw` | the same, plus `canceled`; `nsfw` is a refusal with `public_reason: content_policy_rejected` |
| `NotEnoughCreditsError` on `403` | `NotEnoughCreditsError` on `402` |
| retried submits have no idempotency key | every submit sends `Idempotency-Key`; retries and `TimeoutError` resume the same job |
| `uploadImage()` on the deprecated v1 client | `upload()` and `uploadImage()` on the client |
| `client.agents` (Agent API) | not in sume-js: the Open API has no agent sessions |
| v1 `HiggsfieldClient` with `generate()` | not ported: Sume has one API, the one above |

---

## Support

- Documentation: https://open.sume.com/docs
- API Status: https://status.sume.com

## License

MIT
