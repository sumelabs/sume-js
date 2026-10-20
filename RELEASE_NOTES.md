# Release Notes - v0.3.0 (unreleased)

## 🎉 Major Release: The Higgsfield Client Shape

sume-js now follows [higgsfield-js](https://github.com/higgsfield-ai/higgsfield-js): the same `config()`, `subscribe()`, `withPolling`, configuration and error classes, talking to the Sume Open API at `https://api.open.sume.com`. Code written for Higgsfield's v2 client moves over by changing the import, the key and the endpoint.

The package is now `@sume-com/client`. It replaces `@sume-com/open` 0.2.0, which was released on GitHub only and never published to npm.

## ✨ New Features

- **`subscribe(endpoint, { input, webhook, withPolling })`**: submits to `/v1/image-router/generate` or `/v1/video-router/generate`, polls `/v1/jobs/{id}/status`, reads `/v1/jobs/{id}/result` and returns a `V2Response` with `images`, `video` and `artifacts`
- **Single `credentials` field**: one Sume API key, sent as `Authorization: Bearer <key>`; or `apiKey`; or `SUME_API_KEY`
- **`config()`, the `sume` singleton and `createSumeClient()`**, with isolated instance credentials
- **`upload(data, contentType)` and `uploadImage(buffer, format)`** through `/v1/files/generate-upload-url`
- **Safe retries**: every submit carries an `Idempotency-Key`; network errors, `429` and `5xx` are retried with backoff and `retry-after`
- **Resumable waits**: `TimeoutError` carries `requestId` and `idempotencyKey`; `subscribe()` with that key returns the same job, charged once
- **Webhooks**: `webhook: { url }` sends `mode: "webhook"` and `webhook_url`; `verifyWebhook()` checks `sume-v1` signatures
- **Typed errors**: `AuthenticationError` (401), `NotEnoughCreditsError` (402), `BadInputError` (400, with field `details`), `ValidationError` (422), `APIError` (with Sume's `code` and `requestId`), `TimeoutError`, `CredentialsMissedError`, `BrowserNotSupportedError`

## 🔄 Breaking Changes

- **Package name**: `@sume-com/open` → `@sume-com/client`
- **One call instead of many**: `run()`, `submit()`, `result()`, `status()`, `cancel()`, `job()`, `models()`, `model()`, `estimate()`, `listJobs()` and the `Result` / `Job` / `GeneratedFile` classes are gone. Use `subscribe()`; for prices and models, read the [open model catalog](https://open.sume.com/docs/reference/catalog/list)
- **The model goes in the input**: `run('gpt-image-2', 'a red kite')` → `subscribe('/v1/image-router/generate', { input: { model: 'gpt-image-2', prompt: 'a red kite' } })`
- **No downloads**: `result.save()` is gone; the response has the artifact URLs
- **No local paths in inputs**: upload files first with `upload()` / `uploadImage()`
- **Per-model generated types** are replaced by one input type per endpoint
- **Module format**: CommonJS with named exports, importable from ESM; Node.js 18 or newer

## 📝 Migration Guide

### Before (`@sume-com/open` 0.2.0)
```typescript
import { run } from '@sume-com/open';

const image = await run('gpt-image-2', 'a red kite over a beach', { quality: 'low' });
await image.save('out/');
```

### After (`@sume-com/client` 0.3.0)
```typescript
import { sume, config } from '@sume-com/client/v2';

config({ credentials: process.env.SUME_API_KEY });

const response = await sume.subscribe('/v1/image-router/generate', {
  input: { model: 'gpt-image-2', prompt: 'a red kite over a beach', quality: 'low' },
  withPolling: true
});

if (response.status === 'completed') {
  response.images?.forEach(img => console.log(img.url));
}
```

## 🔧 Technical Details

- **Transport**: axios, as in higgsfield-js; the only runtime dependency
- **Polling**: waits `next_poll_after_seconds`, never less than `pollInterval`; keeps polling through `5xx`, `429` and dropped connections
- **Errors never carry the key**: network errors are wrapped in `APIError`, and storage errors never include the signed upload URL
- **Tests**: jest against a mock of the Sume API; no test calls the real API

## 📦 Dependencies

- `axios` ^1.20.0

---

**Full Changelog**: See git history for detailed changes.
