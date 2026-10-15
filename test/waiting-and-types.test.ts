import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InsufficientFundsError,
  InvalidRequestError,
  NotFoundError,
  OverBudgetError,
  RateLimitError,
  Sume,
  WaitTimeoutError,
} from "../src/index.js";
import { BASE, KEY, MockApi, PNG } from "./mock-api.js";

let api: MockApi;
let dir: string;
const cwd = process.cwd();
const instant = async () => {};
const make = (options: { headers?: Record<string, string> } = {}) =>
  new Sume({ apiKey: KEY, baseUrl: BASE, fetch: api.fetch, sleep: instant, ...options });

beforeEach(() => {
  api = new MockApi();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sume-js-test-")));
  process.chdir(dir);
  vi.stubEnv("SUME_API_KEY", "");
  vi.stubEnv("SUME_API_BASE_URL", "");
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("waiting", () => {
  it("onSubmit and onEvent report progress", async () => {
    api.pollsUntilDone = 2;
    const submitted: string[] = [];
    const events: string[] = [];
    const image = await make().run("gpt-image-2", "a kite", {
      onSubmit: (job) => void submitted.push(job.id),
      onEvent: (event) => void events.push(event.type),
    });
    expect(submitted).toEqual([image.jobId]);
    expect(events).toEqual(["job.created", "job.completed"]); // each event once, in order
  });

  it("a full account waits for a slot instead of failing", async () => {
    api.slotsBusy = 3;
    const image = await make().run("gpt-image-2", "a kite");
    const generates = api.calls("POST", "/v1/image-router/generate");
    expect(generates.length).toBe(4);
    expect(api.jobs.size).toBe(1);
    expect(new Set(generates.map((r) => r.headers.get("idempotency-key"))).size).toBe(1); // the same submit, asked again
    expect(image.url).toBeTruthy();
  });

  it("a slot that never frees gives up with the reason", async () => {
    api.slotsBusy = 100;
    await expect(make().run("gpt-image-2", "a kite", { timeoutMs: 5000 })).rejects.toThrow(RateLimitError);
    api.slotsBusy = 100;
    await expect(make().run("gpt-image-2", "a kite", { timeoutMs: 5000 })).rejects.toThrow("Too many jobs in flight");
  });

  it("cancelOnTimeout refunds a job that never started", async () => {
    api.outcome = "running";
    const error = await make()
      .run("gpt-image-2", "a kite", { timeoutMs: 1, cancelOnTimeout: true })
      .catch((e) => e);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error.message).toContain("canceled job");
    expect(error.message).toContain("refunded");
    expect(api.jobs.get(error.jobId)?.status).toBe("canceled");
  });
});

describe("errors and inputs", () => {
  it("field errors come back one by one", async () => {
    api.rejectFields = true;
    const error = await make()
      .run("seedance-2-mini", "a boat", { duration: 40 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error.fieldErrors).toEqual([
      { path: "duration", message: "must be between 4 and 15" },
      { path: "", message: "bad" },
    ]);
    expect(error.message).toContain("  - duration: must be between 4 and 15");
    // The fix names what the model takes, from the catalog.
    expect(error.message).toContain(
      'Fix: seedance-2-mini takes duration 4–15 s. See all its fields with model("seedance-2-mini").',
    );
  });

  it("uploads files wherever they are, and paths wherever a media URL belongs", async () => {
    writeFileSync(join(dir, "photo.png"), PNG);
    await make().run("seedance-2-mini", "slow push in", {
      duration: 4,
      input_references: [{ type: "image_url", image_url: { url: pathToFileURL("photo.png") } }],
      frame_images: [{ type: "image_url", image_url: { url: "photo.png" }, frame_type: "first_frame" }],
      metadata: { note: "photo.png" }, // text, not a file: left alone
    });
    const [body] = api.bodies("/v1/video-router/generate");
    expect(body?.input_references[0].image_url.url).toMatch(/^https:\/\/media\.test\/assets\//u);
    expect(body?.frame_images[0].image_url.url).toMatch(/^https:\/\/media\.test\/assets\//u);
    expect(body?.frame_images[0].type).toBe("image_url");
    expect(body?.metadata).toEqual({ note: "photo.png" });
  });

  it("known models need no catalog lookup; others come from the catalog", async () => {
    const sume = make();
    await sume.run("gpt-image-2", "a kite");
    expect(api.calls("GET", "/v1/open/catalog")).toEqual([]);
    await sume.run("brand-new-video", "a kite", { duration: 4 }); // newer than this version's list
    expect(api.calls("GET", "/v1/open/catalog/brand-new-video").length).toBe(1);
    expect(api.bodies("/v1/video-router/generate")[0]?.model).toBe("brand-new-video");
    const typo = await sume.run("gpt-image-2x", "a kite").catch((e) => e);
    expect(typo).toBeInstanceOf(NotFoundError);
    expect(typo.message).toContain("Did you mean gpt-image-2?");
  });

  it("the result carries the job and converts to JSON", async () => {
    const image = await make().run("gpt-image-2", "a kite", { quality: "low" });
    expect(image.job?.seconds).toBe(15.5);
    expect(image.job?.input.quality).toBe("low");
    const summary = JSON.parse(JSON.stringify(image));
    expect(summary).toEqual({
      jobId: image.jobId,
      model: "gpt-image-2",
      usd: "0.0077",
      url: image.url,
      files: [
        {
          url: image.url,
          type: "image",
          contentType: "image/png",
          sizeBytes: null,
          width: null,
          height: null,
          durationMs: null,
        },
      ],
      seconds: 15.5,
    });
  });

  it("extra headers go to the API only", async () => {
    await (await make({ headers: { "X-Trace-Id": "abc" } }).run("gpt-image-2", "a kite")).save();
    const apiCalls = api.requests.filter((r) => r.url.host === "api.test");
    const other = api.requests.filter((r) => r.url.host !== "api.test");
    expect(apiCalls.every((r) => r.headers.get("x-trace-id") === "abc")).toBe(true);
    expect(other.length).toBeGreaterThan(0);
    expect(other.some((r) => r.headers.has("x-trace-id"))).toBe(false);
  });

  it("the prompt by position wins over the prompt by name", async () => {
    const sume = make();
    await sume.run("gpt-image-2", "by position", { prompt: "by name" });
    await sume.run("gpt-image-2", { prompt: "only by name" });
    expect(api.bodies("/v1/image-router/generate").map((b) => b.prompt)).toEqual(["by position", "only by name"]);
  });

  it("input passes fields the types do not list", async () => {
    await make().run("gpt-image-2", "a kite", { input: { future_field: 1 }, quality: "low" });
    const [body] = api.bodies("/v1/image-router/generate");
    expect(body?.future_field).toBe(1);
    expect(body?.quality).toBe("low");
  });

  it("an empty balance says top up, not job failed", async () => {
    api.balanceUsd = 0;
    await expect(make().run("gpt-image-2", "a kite")).rejects.toThrow(InsufficientFundsError);
  });

  it("run names the timeout it was given", async () => {
    api.outcome = "running";
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const sume = new Sume({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: api.fetch,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await expect(sume.run("gpt-image-2", "a kite", { timeoutMs: 7000 })).rejects.toThrow("after 7 s");
  });

  it("submit can fail fast when the account is full", async () => {
    api.slotsBusy = 5;
    await expect(make().submit("gpt-image-2", "a kite", { slotWaitMs: 0 })).rejects.toThrow(RateLimitError);
    expect(api.calls("POST", "/v1/image-router/generate").length).toBe(1);
  });

  it("module functions keep the options after an undefined prompt", async () => {
    const { run } = await import("../src/index.js");
    vi.stubEnv("SUME_API_KEY", KEY);
    vi.stubEnv("SUME_API_BASE_URL", BASE);
    vi.stubGlobal("fetch", api.fetch);
    const prompt: string | undefined = undefined;
    await expect(run("gpt-image-2", prompt, { quality: "low", maxUsd: 0.0001 })).rejects.toThrow(OverBudgetError);
    vi.unstubAllGlobals();
  });

  it("data: URLs upload, http is refused, the same file uploads once, metadata is left alone", async () => {
    writeFileSync(join(dir, "photo.png"), PNG);
    const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    const sume = make();
    await sume.run("gpt-image-2", "a kite", {
      image: [dataUrl, "photo.png", pathToFileURL(join(dir, "photo.png")).href],
      metadata: { source_url: { url: "notes" } },
    });
    const [body] = api.bodies("/v1/image-router/generate");
    expect(body?.image_urls.every((u: string) => u.startsWith("https://media.test/assets/"))).toBe(true);
    expect(body?.metadata).toEqual({ source_url: { url: "notes" } });
    expect(api.calls("POST", "/v1/assets/upload-url").length).toBe(1);
    await expect(sume.run("gpt-image-2", "a kite", { image: "http://example.com/a.png" })).rejects.toThrow(
      "https media URLs only",
    );
  });

  it("a status keeps raw through a spread and prints without it", async () => {
    const sume = make();
    const job = await sume.submit("gpt-image-2", "a kite");
    const status = await sume.status(job.id);
    expect({ ...status }.raw).toBe(status.raw);
    expect(String({ ...status })).toBe(String(status));
    expect(inspect(status)).not.toContain("raw");
  });
});
