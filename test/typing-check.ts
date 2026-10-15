// What the types catch, checked by `npm run typecheck` (tsc). Never run: every call here would spend money.
// Each `@ts-expect-error` line is a mistake the editor must flag; tsc fails if one stops being an error.
import {
  estimate,
  type GptImage2Input,
  type ModelId,
  type Result,
  run,
  type Status,
  Sume,
  submit,
} from "../src/index.js";

export async function valid(): Promise<Result[]> {
  const sume = new Sume({ headers: { "x-trace-id": "abc" } });
  const options: GptImage2Input = { quality: "low", aspect_ratio: "16:9" };
  const job = await submit("seedance-2-mini", "a paper boat", { duration: 5, resolution: "480p", maxUsd: 1 });
  await estimate("kling-3", "a kite", { duration: 5, resolution: "720p" }); // not in the catalog's list: still a string
  return [
    await run("gpt-image-2", "a red kite", { quality: "low", maxUsd: 0.05 }),
    await run("gpt-image-2", { prompt: "a red kite", ...options }),
    await sume.run("seedance-2-mini", "slow push in", {
      image: "photo.png",
      duration: 5,
      onStatus: (s: Status) => void s.queuePosition,
      onEvent: (e) => void e.type,
      cancelOnTimeout: true,
    }),
    await run("veed-subtitles", { video: "talk.mp4", duration: 30, captions: { position: "bottom" } }),
    await run("a-model-newer-than-this-version", "a kite", { any_field: 1 }), // unknown ids take any fields
    await run("gpt-image-2", "a kite", { input: { a_field_the_types_lack: 1 } }),
    await job.wait({ timeoutMs: 60_000 }),
  ];
}

export async function mistakes(): Promise<void> {
  // @ts-expect-error a typo in a field name
  await run("gpt-image-2", "a kite", { qualty: "low" });
  // @ts-expect-error num_images is a number
  await run("gpt-image-2", "a kite", { num_images: "2" });
  // @ts-expect-error captions sit at the top, center or bottom
  await run("veed-subtitles", { video: "talk.mp4", duration: 30, captions: { position: "middle" } });
  // @ts-expect-error mask is an image model's input
  await run("seedance-2-mini", "a boat", { mask: "mask.png" });
  // @ts-expect-error maxUsd is a number of dollars
  await run("gpt-image-2", "a kite", { maxUsd: true });
  // @ts-expect-error not a model this version knows, as a ModelId
  const id: ModelId = "gpt-image-3";
  void id;
}
