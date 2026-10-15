import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  InsufficientFundsError,
  InvalidRequestError,
  JobFailedError,
  NotFoundError,
  OverBudgetError,
  Sume,
  SumeError,
  verifyWebhook,
  WaitTimeoutError,
} from "../src/index.js";
import { BASE, KEY, MockApi, PNG } from "./mock-api.js";

let api: MockApi;
let dir: string;
const cwd = process.cwd();
const instant = async () => {};
const make = (options: { apiKey?: string } = { apiKey: KEY }) =>
  new Sume({ ...options, baseUrl: BASE, fetch: api.fetch, sleep: instant });

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
});

describe("run", () => {
  it("returns the files and the price", async () => {
    const image = await make().run("gpt-image-2", "a red kite over a beach", { quality: "low" });
    expect(image.model).toBe("gpt-image-2");
    expect(image.usd).toBe("0.0077");
    expect(image.url).toBe(`https://media.test/${image.jobId}/1.png`);
    expect(api.bodies("/v1/image-router/generate")).toEqual([
      { prompt: "a red kite over a beach", quality: "low", model: "gpt-image-2" },
    ]);
    // Every submit carries an idempotency key, so a retried submit never pays twice.
    expect(api.calls("POST", "/v1/image-router/generate")[0]?.headers.get("idempotency-key")).toBeTruthy();
  });

  it("saves files under names that never overwrite", async () => {
    const image = await make().run("gpt-image-2", "a kite");
    const [first] = await image.save();
    expect(first).toBe(join(dir, `gpt-image-2-${image.jobId.slice(4, 12)}.png`));
    expect(new Uint8Array(readFileSync(first as string))).toEqual(PNG);
    const [second] = await image.save();
    expect(second).toMatch(/-2\.png$/u);
    expect(await image.save("kite.png")).toEqual([join(dir, "kite.png")]);
    expect(await image.save("out/")).toEqual([join(dir, "out", `gpt-image-2-${image.jobId.slice(4, 12)}.png`)]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("numbers several files and leaves a video's poster out", async () => {
    api.artifacts = "two-images";
    const images = await make().run("gpt-image-2", { prompt: "two kites", num_images: 2 });
    expect(await images.save("kite.png")).toEqual([join(dir, "kite.png"), join(dir, "kite-2.png")]);
    api.artifacts = "video-with-poster";
    const video = await make().run("seedance-2-mini", "a paper boat", { duration: 4, resolution: "480p" });
    expect(video.files.map((f) => f.type)).toEqual(["video"]);
    expect(video.allFiles.map((f) => f.type)).toEqual(["video", "image"]);
    expect(video.usd).toBe("0.3516");
  });

  it("uploads local files without the key", async () => {
    writeFileSync(join(dir, "photo.png"), PNG);
    await make().run("gpt-image-2", "the same cup at night", { image: "photo.png" });
    const [generate] = api.bodies("/v1/image-router/generate");
    expect(generate?.image_urls).toEqual(["https://media.test/assets/asset_1/source.png"]);
    expect(api.uploads.get("asset_1")).toEqual(PNG);
    expect(api.bodies("/v1/assets/upload-url")).toEqual([
      { content_type: "image/png", size_bytes: PNG.length, filename: "photo.png" },
    ]);
  });

  it("maps short media names to each router", async () => {
    const sume = make();
    await sume.run("seedance-2-mini", "slow push in", { image: PNG, duration: 4 });
    expect(api.bodies("/v1/video-router/generate")[0]?.image_url).toMatch(/^https:\/\/media\.test\/assets\//u);
    // The types refuse these too; the checks below are for plain JavaScript.
    // @ts-expect-error a video model takes one image, the first frame
    await expect(sume.run("seedance-2-mini", "x", { image: [PNG, PNG], duration: 4 })).rejects.toThrow(
      "takes one image",
    );
    // @ts-expect-error video is a video model's input
    await expect(sume.run("gpt-image-2", "x", { video: "https://example.com/a.mp4" })).rejects.toThrow(
      "video applies to video models",
    );
    await expect(
      sume.run("veed-lipsync", { video: "https://e.com/a.mp4", audio: "https://e.com/a.wav" }),
    ).rejects.toThrow(InvalidRequestError);
  });

  it("refuses an over-budget request before uploading or submitting", async () => {
    const error = await make()
      .run("seedance-2-mini", "a boat", { duration: 10, image: PNG, maxUsd: 0.5 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(OverBudgetError);
    expect(String(error.message)).toContain("costs $0.8790, over maxUsd $0.5");
    expect(api.calls("POST", "/v1/video-router/generate")).toEqual([]);
    expect(api.calls("POST", "/v1/assets/upload-url")).toEqual([]);
    expect((await make().run("gpt-image-2", "a kite", { maxUsd: "0.01" })).usd).toBe("0.0077");
  });
});

describe("failures say the fix", () => {
  it("a failed job throws with the reason", async () => {
    api.outcome = "failed";
    const error = await make()
      .run("gpt-image-2", "a kite")
      .catch((e) => e);
    expect(error).toBeInstanceOf(JobFailedError);
    expect(error.message).toContain("failed: The provider timed out.");
    expect(error.message).toContain("Fix: Failed jobs are refunded.");
    expect(error.jobId).toMatch(/^job_/u);
    api.outcome = "refused";
    await expect(make().run("gpt-image-2", "x")).rejects.toThrow(JobFailedError);
  });

  it("typos, funds and keys", async () => {
    const typo = await make()
      .run("gpt-image2", "a kite")
      .catch((e) => e);
    expect(typo).toBeInstanceOf(NotFoundError);
    expect(typo.message).toContain("Fix: Did you mean gpt-image-2?");
    api.balanceUsd = 0;
    const broke = await make()
      .run("gpt-image-2", "a kite")
      .catch((e) => e);
    expect(broke).toBeInstanceOf(InsufficientFundsError);
    expect(broke.message).toContain("Top up at https://open.sume.com/billing. It needs $0.0077; the balance is $0.00.");
    expect(broke.requestId).toBe("req_test");
    const denied = await make({ apiKey: "sume_live_wrong" })
      .listJobs()
      .catch((e) => e);
    expect(denied).toBeInstanceOf(AuthenticationError);
    expect(denied.message).toContain("A key works only on the API it was made for");
  });

  it("reads the key from the environment, then ./.env, never the host from .env", async () => {
    const missing = await make({})
      .listJobs()
      .catch((e) => e);
    expect(missing).toBeInstanceOf(AuthenticationError);
    expect(missing.message).toContain("Fix: Set SUME_API_KEY");
    writeFileSync(join(dir, ".env"), `OTHER=1\nexport SUME_API_KEY="${KEY}"\nSUME_API_BASE_URL=https://evil.example\n`);
    expect(await make({}).listJobs()).toEqual([]);
    expect(make({}).baseUrl).toBe(BASE);
    vi.stubEnv("SUME_API_KEY", "sume_live_from_env");
    await expect(make({}).listJobs()).rejects.toThrow(AuthenticationError);
  });

  it("defaults to Open production and refuses plain http", () => {
    expect(new Sume().baseUrl).toBe("https://api.open.sume.com");
    expect(new Sume({ baseUrl: "https://api.open.sume.com/v1/" }).baseUrl).toBe("https://api.open.sume.com");
    expect(() => new Sume({ baseUrl: "http://api.open.sume.com" })).toThrow(/must use https/u);
    expect(new Sume({ baseUrl: "http://localhost:8080" }).baseUrl).toBe("http://localhost:8080");
  });

  it("refuses to run in a browser", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => new Sume()).toThrow(/servers only/u);
    vi.unstubAllGlobals();
  });
});

describe("jobs", () => {
  it("submit, status, wait, cancel, events", async () => {
    api.pollsUntilDone = 3;
    const sume = make();
    const job = await sume.submit("gpt-image-2", "a kite");
    expect(job.model).toBe("gpt-image-2");
    expect((await sume.status(job.id)).state).toBe("queued");
    const seen: string[] = [];
    const result = await job.wait({ onStatus: (s) => void seen.push(String(s)) });
    expect(seen.at(-1)).toBe("completed");
    expect(seen[0]).toMatch(/^queued/u);
    expect(result.usd).toBeNull();
    expect((await job.events()).map((e) => e.type)).toEqual(["job.created", "job.completed"]);
    expect((await job.info()).state).toBe("completed");
    expect((await sume.result(job.id)).url).toBe(result.url);

    api.outcome = "running";
    const queued = await sume.submit("gpt-image-2", "another kite");
    expect(await queued.cancel()).toBe(true);
    await expect(queued.wait()).rejects.toThrow("was canceled");
    await expect(sume.cancel(job.id)).rejects.toThrow("Generation has started");
    expect((await sume.listJobs()).map((j) => j.id).slice(0, 2)).toEqual([queued.id, job.id]);
  });

  it("a wait that runs out names the job", async () => {
    api.outcome = "running";
    const error = await make()
      .run("gpt-image-2", "a kite", { timeoutMs: 1 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error.message).toContain(`result("${error.jobId}")`);
  });

  it("retries reuse the idempotency key, and a key adopts its job", async () => {
    const sume = make();
    api.failNext = [503];
    await sume.model("gpt-image-2");
    api.failNext = [503, 502];
    await sume.run("gpt-image-2", "a kite");
    const keys = new Set(api.calls("POST", "/v1/image-router/generate").map((r) => r.headers.get("idempotency-key")));
    expect(keys.size).toBe(1);
    expect(api.jobs.size).toBe(1);
    const first = await sume.submit("gpt-image-2", "a kite", { idempotencyKey: "order-42" });
    const again = await sume.submit("gpt-image-2", "a kite", { idempotencyKey: "order-42" });
    expect(again.id).toBe(first.id);
    expect(again.replayed && !first.replayed).toBe(true);
  });
});

describe("models, prices, uploads", () => {
  it("lists models and prices with no key", async () => {
    const anonymous = make({});
    const videos = await anonymous.models("video");
    expect(videos.map((m) => m.id)).toEqual(["seedance-2-mini", "brand-new-video"]);
    expect(videos[0]?.price).toBe("$0.0879–$0.1890/s");
    expect(videos[0]?.seconds).toEqual([4, 15]);
    expect(String(await anonymous.estimate("seedance-2-mini", "a boat", { duration: 6 }))).toBe("$0.5274");
    expect((await anonymous.estimate("gpt-image-2", "x", { image: "photo.png" })).usd).toBe("0.0077");
    expect(api.calls("POST", "/v1/assets/upload-url")).toEqual([]);
  });

  it("uploads paths, bytes and blobs", async () => {
    const sume = make();
    mkdirSync(join(dir, "in"));
    writeFileSync(
      join(dir, "in", "clip.mp4"),
      new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom")]),
    );
    expect(await sume.upload("in/clip.mp4")).toMatch(/^https:\/\/media\.test\/assets\//u);
    expect(await sume.upload(new Blob([PNG], { type: "image/png" }))).toMatch(/^https:\/\//u);
    await expect(sume.upload("missing.png")).rejects.toThrow("No such file");
    await expect(sume.upload(new TextEncoder().encode("plain text"))).rejects.toThrow("Cannot tell the media type");
  });

  it("errors are SumeErrors with a code", async () => {
    const error = await make()
      .model("nope-model")
      .catch((e) => e);
    expect(error).toBeInstanceOf(SumeError);
    expect(error.code).toBe("model_not_found");
  });
});

describe("verifyWebhook", () => {
  const sign = (body: string, timestamp: number, secret: string) =>
    `sume-v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

  it("matches the sume-v1 known answer and rejects tampering", () => {
    expect(sign("hello", 1_700_000_000, "s3cret")).toBe(
      "sume-v1=babfa8b593140ee3160bea38210f8fea6712e1f6e073328eb52c4e965bc0ab8d",
    );
    const headers = {
      "X-Sume-Webhook-Timestamp": "1700000000",
      "X-Sume-Webhook-Signature": sign("hello", 1_700_000_000, "s3cret"),
    };
    const now = 1_700_000_000;
    expect(verifyWebhook("hello", headers, "s3cret", { now })).toBe(true);
    expect(verifyWebhook(new TextEncoder().encode("hello"), new Headers(headers), "s3cret", { now })).toBe(true);
    expect(verifyWebhook("hello ", headers, "s3cret", { now })).toBe(false);
    expect(verifyWebhook("hello", headers, "other", { now })).toBe(false);
    expect(verifyWebhook("hello", headers, "s3cret", { now: now + 601 })).toBe(false);
    expect(verifyWebhook("hello", headers, "s3cret", { now: now + 86_400, toleranceSeconds: 0 })).toBe(true);
    const rotating = {
      ...headers,
      "X-Sume-Webhook-Signature": `${sign("hello", now, "new")}, ${headers["X-Sume-Webhook-Signature"]}`,
    };
    expect(verifyWebhook("hello", rotating, "s3cret", { now })).toBe(true);
    expect(verifyWebhook("hello", rotating, "new", { now })).toBe(true);
    expect(verifyWebhook("hello", {}, "s3cret")).toBe(false);
  });
});
