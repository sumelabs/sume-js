# AGENTS.md

## Using `@sume-com/open` in your code

```ts
import { run } from "@sume-com/open";   // npm install https://github.com/sumelabs/sume-js/releases/latest/download/sume-open.tgz

const image = await run("gpt-image-2", "a red kite over a beach", { quality: "low" });   // waits, resolves to a Result
const paths = await image.save("out/");                                                  // downloads; resolves to the paths
```

- Server-side only: a browser bundle gets a stub that throws.
- Key: `SUME_API_KEY` in the environment or `./.env`. A person makes it at https://open.sume.com/api-keys. Never print it.
- Host: `https://api.open.sume.com` by default. Never `https://api.sume.com`, which is sume.com's API.
- Name the model yourself; prices differ by more than 100×. `await models("video")` lists models with `m.price` (per image or per second). `estimate(...)` is free.
- Pass `maxUsd` to cap a run. Local files work wherever a URL does (`{ image: "photo.png" }`).
- Long jobs: `const job = await submit(...)`, then later `await result(job.id)`. After `WaitTimeoutError` the job keeps running. Never resubmit; a second submit is a second charge.
- Errors are `SumeError` subclasses. `error.message` ends with a `Fix:` line.

## Working on this repository

```sh
npm ci
npm test            # vitest, against a mock API (test/mock-api.ts); never the real one
npm run check       # lint + typecheck + test + build + pack-and-import smoke
```

- `src/client.ts` holds `Sume`, `Job`, `Result` and `GeneratedFile`. Logic that does no I/O lives in `flow.ts`, `inputs.ts` and `types.ts`. `index.ts` holds the module functions over a shared default client.
- `http.ts` owns the key, the `data`/`error` envelope, request ids and retries. It retries only what is safe: reads, and submits that carry an idempotency key. The key goes to the API host only, never to storage or media URLs.
- Keep zero runtime dependencies. Local imports end in `.js`. Errors always carry a `hint`.
- A user-visible change gets a CHANGELOG line under **Unreleased** and README updates. Bump the version in `package.json` and `src/version.ts`, then push a `v*` tag; the release workflow builds, checks and publishes.
- The Python client (`sumelabs/sume-python`) has the same surface; keep the two in step.
