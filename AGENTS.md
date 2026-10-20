# AGENTS.md

## Using `@sume-com/client`

```ts
import { sume, config } from '@sume-com/client/v2';

config({ credentials: process.env.SUME_API_KEY });

const response = await sume.subscribe('gpt-image-2', {
  input: { prompt: 'a red kite over a beach', quality: 'low' },
});
console.log(response.status, response.images?.[0].url);
```

- Server-side only. The key is `SUME_API_KEY`; a person makes it at https://open.sume.com/api-keys. Never print it.
- Host: `https://api.open.sume.com`. Never `https://api.sume.com`, which is sume.com's API.
- The endpoint is a model id, routed by its catalog `kind`, or a router path with `input.model`: images go to `/v1/image-router/generate`; video, lip-sync and captions to `/v1/video-router/generate`.
- After a `TimeoutError` the job keeps running. Call `subscribe()` again with `error.idempotencyKey`; never submit a new job for it.
- The README is the reference. Sume's API docs: https://open.sume.com/docs.

## Working on this repository

```sh
npm ci
npm test            # jest, against a mock of the Sume API (src/test-utils/mock-api.ts); never the real one
npm run lint
npm run build:prod
```

- The repository follows higgsfield-js file for file: `src/config.ts`, `src/auth.ts`, `src/errors.ts`, `src/helpers.ts`, `src/types.ts`, `src/utils/retry.ts`, and the client in `src/v2/`. Keep its names and shape; change calls only where Sume's API differs.
- Only Sume's documented Open API routes. Retry only what is safe: reads, and submits with their `Idempotency-Key`.
- The API key goes to the API host only, never to storage URLs, and no error may carry it.
- A user-visible change updates the README and `RELEASE_NOTES.md`. The version lives in `package.json` and `src/version.ts`; a test keeps them equal.
- Publishing runs from `.github/workflows/publish.yml` when a GitHub release is created, and needs `NPM_TOKEN`. Do not tag, release or publish unless Chase asks for that release.
