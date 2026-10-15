/** A mock Sume Open API as a `fetch` function. Tests never call the real API. */

export const KEY = "sume_live_test0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const BASE = "https://api.test";
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
export const MP4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom"), ...new Array(64).fill(0)]);

// biome-ignore lint/suspicious/noExplicitAny: mock JSON
type Json = Record<string, any>;

export const MODELS: Json[] = [
  {
    id: "gpt-image-2",
    name: "GPT Image 2",
    kind: "image",
    company: { slug: "openai", name: "OpenAI" },
    modes: ["text-to-image", "image-edit"],
    pricing: { currency: "USD", unit: "image", from_usd: "0.0077", from_usd_micros: 7700, to_usd: "0.2639" },
    capabilities: { text_to_image: true, image_edit: true },
  },
  {
    id: "seedance-2-mini",
    name: "Seedance 2.0 Mini",
    kind: "video",
    company: { slug: "bytedance", name: "ByteDance" },
    modes: ["text-to-video", "image-to-video"],
    pricing: { currency: "USD", unit: "second", from_usd: "0.0879", from_usd_micros: 87900, to_usd: "0.1890" },
    capabilities: { resolutions: ["480p", "720p"], duration_seconds: { min: 4, max: 15 } },
  },
  {
    id: "veed-lipsync",
    name: "VEED Lipsync",
    kind: "lipsync",
    company: { slug: "veed", name: "VEED" },
    modes: ["video-to-lipsync"],
    pricing: { currency: "USD", unit: "second", from_usd: "0.1000", from_usd_micros: 100000 },
    capabilities: { duration_seconds: { min: 2, max: 60 } },
  },
];

export class MockApi {
  balanceUsd = 100;
  /** completed, failed, refused (failed at submit), or running (never ends). */
  outcome = "completed";
  pollsUntilDone = 1;
  /** image, two-images, or video-with-poster. */
  artifacts = "image";
  /** Status codes to answer the next API calls with, first in first out. */
  failNext: number[] = [];
  requests: { method: string; url: URL; headers: Headers; body: string }[] = [];
  jobs = new Map<string, Json>();
  byKey = new Map<string, string>();
  polls = new Map<string, number>();
  uploads = new Map<string, Uint8Array>();

  calls(method: string, prefix: string) {
    return this.requests.filter((r) => r.method === method && r.url.pathname.startsWith(prefix));
  }

  bodies(prefix: string): Json[] {
    return this.calls("POST", prefix).map((r) => JSON.parse(r.body));
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const raw = request.method === "PUT" ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const body = raw ? "" : await request.text();
    this.requests.push({ method: request.method, url, headers: request.headers, body });
    if (url.host === "storage.test" || url.host === "media.test") {
      // Storage and media hosts must never see the API key.
      if (request.headers.has("authorization")) throw new Error(`key sent to ${url.host}`);
      if (url.host === "storage.test" && request.method === "PUT") {
        this.uploads.set(url.pathname.split("/").pop() as string, raw as Uint8Array);
        return new Response(null, { status: 200 });
      }
      return new Response(url.pathname.endsWith(".mp4") ? MP4 : PNG, { status: 200 });
    }
    if (url.host !== "api.test") throw new Error(`unexpected host ${url.host}`);
    const failure = this.failNext.shift();
    if (failure) return this.error(failure, `http_${failure}`, `Injected ${failure}.`, { retryable: true });
    const path = url.pathname;
    const json: Json | undefined = body ? JSON.parse(body) : undefined;
    if (!path.startsWith("/v1/open/") && request.headers.get("authorization") !== `Bearer ${KEY}`) {
      return this.error(401, "unauthorized", "Missing or invalid API key.");
    }
    const id = path.split("/")[3] as string;
    if (request.method === "GET" && path === "/v1/open/catalog") return this.ok({ currency: "USD", models: MODELS });
    if (request.method === "GET" && path.startsWith("/v1/open/catalog/")) {
      const found = MODELS.find((m) => m.id === decodeURIComponent(path.split("/").pop() as string));
      return found ? this.ok(found) : this.error(404, "model_not_found", "No such model.");
    }
    if (request.method === "POST" && path === "/v1/open/estimate") {
      const m = MODELS.find((x) => x.id === json?.model) as Json;
      const usd = m.kind === "image" ? 0.0077 : 0.0879 * Math.max(Number(json?.input?.duration ?? 4), 1);
      return this.ok({ model: m.id, currency: "USD", usd: usd.toFixed(4), usd_micros: Math.round(usd * 1e6) });
    }
    if (request.method === "POST" && path.endsWith("-router/generate"))
      return this.generate(path, request.headers, json ?? {});
    if (request.method === "GET" && path.endsWith("/status")) return this.status(id);
    if (request.method === "GET" && path.endsWith("/result")) {
      const job = this.jobs.get(id) as Json;
      return this.ok({ job_id: id, status: "COMPLETED", result: job.result, job });
    }
    if (request.method === "GET" && path.endsWith("/events")) {
      const job = this.jobs.get(id) as Json;
      const events = [{ id: "evt_1", type: "job.created", created_at: job.created_at }];
      if (job.status === "completed" || job.status === "failed")
        events.push({ id: "evt_2", type: `job.${job.status}`, created_at: job.created_at });
      return this.ok({ job_id: id, events });
    }
    if (request.method === "POST" && path.endsWith("/cancel")) {
      const job = this.jobs.get(id) as Json;
      if (job.status !== "queued") {
        return this.error(
          409,
          "job_generation_already_started",
          "API job can only be canceled before generation starts.",
        );
      }
      job.status = "canceled";
      return this.ok({ job_id: id, status: "CANCELED", canceled: true, job });
    }
    if (request.method === "GET" && path.startsWith("/v1/jobs/")) {
      const job = this.jobs.get(id);
      return job ? this.ok({ job }) : this.error(404, "job_not_found", "No such job.");
    }
    if (request.method === "GET" && path === "/v1/jobs") return this.ok({ jobs: [...this.jobs.values()].reverse() });
    if (request.method === "POST" && path === "/v1/assets/upload-url") {
      const assetId = `asset_${this.uploads.size + 1}`;
      return this.ok({
        asset: { id: assetId, media_type: "image", status: "pending", url: null },
        upload: {
          url: `https://storage.test/put/${assetId}`,
          method: "PUT",
          headers: { "content-type": json?.content_type },
        },
      });
    }
    if (request.method === "POST" && path.endsWith("/complete")) {
      if (!this.uploads.has(id)) throw new Error("completed before the bytes were uploaded");
      return this.ok({ asset: { id, status: "ready", url: `https://media.test/assets/${id}/source.png` } });
    }
    return this.error(404, "not_found", `No route ${request.method} ${path}.`);
  };

  generate(path: string, headers: Headers, body: Json): Response {
    const m = MODELS.find((x) => x.id === body.model);
    if (!m) return this.error(404, "model_not_found", "No such model.");
    const router = m.kind === "image" ? "image" : "video";
    if (!path.includes(`/v1/${router}-router/`))
      return this.error(400, "invalid_request", `${m.id} is not a ${router} model.`);
    const key = headers.get("idempotency-key");
    if (key && this.byKey.has(key)) {
      const job = this.jobs.get(this.byKey.get(key) as string);
      return this.ok({ job, idempotency_hit: true, next_poll_after_seconds: 0, terminal: false }, 202);
    }
    const price = m.kind === "image" ? 0.0077 : 0.0879 * Number(body.duration ?? 4);
    if (price > this.balanceUsd) {
      return this.error(402, "insufficient_funds", "Balance too low.", {
        details: { required_usd: price.toFixed(4), available_usd: "0.00" },
      });
    }
    const id = `job_${String(this.jobs.size + 1).padStart(8, "0")}-0000-0000-0000-000000000000`;
    const { model: _, ...input } = body;
    const job: Json = {
      id,
      type: `${router}_generation`,
      status: "queued",
      model: m.id,
      idempotency_key: key,
      created_at: "2026-10-15T00:00:00.000Z",
      completed_at: null,
      input,
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    if (key) this.byKey.set(key, id);
    if (this.outcome === "refused") {
      job.status = "failed";
      job.error = { code: "provider_refused", message: "The provider refused this prompt." };
      return this.error(422, "provider_refused", "The provider refused this prompt.", { details: { job } });
    }
    return this.ok({ job, idempotency_hit: false, next_poll_after_seconds: 0, terminal: false }, 202);
  }

  status(id: string): Response {
    const job = this.jobs.get(id) as Json;
    this.polls.set(id, (this.polls.get(id) ?? 0) + 1);
    if (
      job.status === "queued" &&
      this.outcome !== "running" &&
      (this.polls.get(id) as number) >= this.pollsUntilDone
    ) {
      if (this.outcome === "failed") {
        job.status = "failed";
        job.error = { code: "provider_error", message: "The provider timed out." };
      } else {
        job.status = "completed";
        job.result = { artifacts: this.makeArtifacts(id) };
      }
    }
    const state = job.status;
    return this.ok({
      job_id: id,
      status: state.toUpperCase(),
      sume_status: state,
      queue_position: state === "queued" ? 2 : null,
      terminal: ["completed", "failed", "canceled"].includes(state),
      next_poll_after_seconds: state === "queued" ? 1 : null,
      job,
    });
  }

  makeArtifacts(id: string): Json[] {
    if (this.artifacts === "video-with-poster") {
      return [
        { id: "a1", type: "video", url: `https://media.test/${id}/video.mp4`, content_type: "video/mp4" },
        { id: "a2", type: "image", url: `https://media.test/${id}/poster.jpg`, content_type: "image/jpeg" },
      ];
    }
    const count = this.artifacts === "two-images" ? 2 : 1;
    return Array.from({ length: count }, (_, i) => ({
      id: `a${i + 1}`,
      type: "image",
      url: `https://media.test/${id}/${i + 1}.png`,
      content_type: "image/png",
    }));
  }

  ok(data: unknown, status = 200): Response {
    return Response.json({ data }, { status, headers: { "x-sume-request-id": "req_test" } });
  }

  error(
    status: number,
    code: string,
    message: string,
    extra: { retryable?: boolean; details?: unknown } = {},
  ): Response {
    return Response.json(
      { error: { code, message, request_id: "req_test", retryable: extra.retryable ?? false, details: extra.details } },
      { status, headers: { "x-sume-request-id": "req_test" } },
    );
  }
}
