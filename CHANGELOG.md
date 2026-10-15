# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-15

Types for every model and field, progress callbacks, and a client that waits instead of failing when the account is busy.

### Added

- Types generated from the live API. Each of the 64 models has its own input type (`GptImage2Input`, `Seedance2MiniInput`, …), picked by the model id in `run`, `submit` and `estimate`. Editors complete the fields the model takes and the values it lists, show the API's descriptions on hover, and tsc flags a misspelled field with "Did you mean". `ModelId`, `ImageModelId`, `VideoModelId`, `InputOf<M>`, `ImageInput` and `VideoInput` are exported. Ids newer than this version still work, with the general `Input` type, and `input` passes fields the types do not list yet. `scripts/generate.mjs` rewrites the types, and a weekly workflow fails when the API moves on.
- `onSubmit`, `onStatus` and `onEvent` on `run`, and `onEvent` on `wait` and `result`: the job's id as soon as it exists, each status read, and each step in the job's life, once.
- `cancelOnTimeout` on `run`, `wait` and `result` cancels the job (it is refunded) when the wait runs out before generation starts.
- When the account already runs as many jobs as it may, `run` and `submit` wait for a free slot and submit then, with the same idempotency key, instead of throwing `RateLimitError`. `submit` waits up to 10 minutes; `run` waits within its `timeoutMs`.
- `error.fieldErrors`: each field the API refused, as `{ path, message }`. The `Fix:` line lists the values the model takes for those fields, from the catalog (`gpt-image-2 takes aspect_ratio auto, 1:1, 16:9, …`).
- Files are uploaded wherever they sit in the inputs, nested ones included (`frame_images`, `input_references`). Bytes, `Blob`s and `file:` URLs count anywhere; a path string counts where a media URL belongs, and nowhere else.
- `result.job` (input, timing, and `seconds`) and `toJSON()` on `Result` and `GeneratedFile`, so `Response.json(result)` sends a clean summary. `JobInfo.startedAt` and `JobInfo.seconds`.
- `headers` on `new Sume()`: extra headers for API calls, never sent to storage or media hosts.
- `NODE_DEBUG=sume` prints one line per API call with the status, request id, attempt and time.
- The README covers types, progress, cancel, nested uploads, Next.js and Express, logging, and a table for people coming from fal or Higgsfield. CI type-checks every example in it.

### Changed

- Models this version knows skip the catalog lookup before a submit. A model that is not in the catalog still gets a "Did you mean" suggestion.
- `console.log` of a `Model`, `Status`, `Price`, `JobEvent`, `JobInfo` or `Result` shows its fields, not the API's JSON; `raw` still holds it.
- `dist/browser.d.ts` re-exports the real declarations. The published types need no `@types/node`; the package smoke type-checks a project without it.

## [0.1.0] - 2026-10-15

The first release: the whole generation lifecycle of the Sume Open API, for Node 20+ servers.

### Added

- `run(model, prompt, input)`: prices the request, uploads any local files, submits with an idempotency key, waits, and resolves to a `Result`. `result.save()` downloads the files.
- `submit`, `job.status`, `job.poll`, `job.wait`, `job.cancel`, `job.events` and `job.info`. `result(jobId)`, `status`, `cancel` and `listJobs` work from an id alone.
- `models`, `model` and `estimate`: the catalog and prices in dollars, free and with no key.
- `upload` takes a path, bytes or a Blob.
- `verifyWebhook` checks `sume-v1` webhook signatures, and `webhook_url` asks for a delivery.
- `maxUsd` refuses an over-budget request before anything is uploaded or charged.
- Every error says what to do in a `Fix:` line and in `hint`.
- ESM and CommonJS builds with types. A browser bundle gets a stub that throws, so a key never ships to a page.

[Unreleased]: https://github.com/sumelabs/sume-js/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sumelabs/sume-js/releases/tag/v0.2.0
[0.1.0]: https://github.com/sumelabs/sume-js/releases/tag/v0.1.0
