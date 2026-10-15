# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/sumelabs/sume-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sumelabs/sume-js/releases/tag/v0.1.0
