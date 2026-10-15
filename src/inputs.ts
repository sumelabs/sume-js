import { basename } from "node:path";
import { InvalidRequestError } from "./errors.js";
import { isHttpUrl } from "./media.js";
import type { Model } from "./types.js";

/** Request fields that carry media by URL. Anything else in them is a file to upload. */
export const MEDIA_FIELDS = [
  "image_urls",
  "input_urls",
  "image_url",
  "first_frame_url",
  "end_image_url",
  "last_frame_url",
  "video_url",
  "audio_url",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
  "mask_url",
  "mask_image_url",
] as const;

const VIDEO_ONLY: Record<string, string> = {
  end_image: "end_image_url",
  video: "video_url",
  audio: "audio_url",
  reference_images: "reference_image_urls",
  reference_videos: "reference_video_urls",
  reference_audios: "reference_audio_urls",
};
const IMAGE_ONLY: Record<string, string> = { mask: "mask_url" };
const LIST_FIELDS = new Set([
  "image_urls",
  "input_urls",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
]);

export type Router = "image" | "video";

/** Image models go to the image router; video, lip-sync and captions to the video router. */
export const routerFor = (model: Pick<Model, "kind">): Router => (model.kind === "image" ? "image" : "video");

/** An http(s) `URL` object is sent as its text; a `file:` URL stays, to be uploaded. */
const plain = (value: unknown): unknown =>
  value instanceof URL && value.protocol !== "file:" ? value.toString() : value;
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value.map(plain) : [plain(value)]);

/** The router request body, without `model`. `undefined` values are left out. */
export function buildBody(
  model: Model,
  prompt: string | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const router = routerFor(model);
  const body: Record<string, unknown> = {};
  if (prompt !== undefined) body.prompt = prompt;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === "model") {
      throw new InvalidRequestError("model is the first argument, not an input.", {
        hint: `Call run("${model.id}", "<prompt>", { … }).`,
        code: "invalid_input",
      });
    }
    if (key === "image" || key === "images") {
      const images = asList(value);
      if (router === "image") body.image_urls = images;
      else if (images.length > 1) {
        throw new InvalidRequestError(`${model.id} takes one image, the first frame.`, {
          hint: "Pass end_image for the last frame, or reference_images for references.",
          code: "invalid_input",
        });
      } else body.image_url = images[0];
    } else if (key in VIDEO_ONLY || key in IMAGE_ONLY) {
      const wanted = key in VIDEO_ONLY ? "video" : "image";
      if (router !== wanted) {
        const article = /^[aeiou]/u.test(model.kind) ? "an" : "a";
        throw new InvalidRequestError(
          `${key} applies to ${wanted} models; ${model.id} is ${article} ${model.kind} model.`,
          {
            hint: `See what ${model.id} takes with model("${model.id}").`,
            code: "invalid_input",
          },
        );
      }
      const field = (VIDEO_ONLY[key] ?? IMAGE_ONLY[key]) as string;
      body[field] = LIST_FIELDS.has(field) ? asList(value) : plain(value);
    } else {
      body[key] = (MEDIA_FIELDS as readonly string[]).includes(key)
        ? Array.isArray(value)
          ? asList(value)
          : plain(value)
        : value;
    }
  }
  // Lip-sync and captions are billed by the clip's length, which the API needs up front.
  if (
    (model.kind === "lipsync" || model.kind === "captions") &&
    body.duration === undefined &&
    body.duration_seconds === undefined
  ) {
    const what = `the clip's length in whole seconds${model.kind === "lipsync" ? " (the audio's, for a photo)" : ""}`;
    throw new InvalidRequestError(`${model.id} needs duration: ${what}.`, {
      hint: `Pass duration: <seconds>; limits are in (await model("${model.id}")).seconds.`,
      code: "invalid_input",
    });
  }
  return body;
}

/** Anything in a media field that is not already a URL is a file to upload. */
export function needsUpload(value: unknown): boolean {
  if (typeof value === "string") return !isHttpUrl(value) && !value.startsWith("data:");
  if (value instanceof URL) return value.protocol === "file:";
  return value !== undefined && value !== null;
}

export interface MediaSlot {
  field: string;
  index: number | null;
  value: unknown;
}

/** Every media value that must be uploaded first, in a stable order. */
export function mediaSlots(body: Record<string, unknown>): MediaSlot[] {
  const slots: MediaSlot[] = [];
  for (const field of MEDIA_FIELDS) {
    const value = body[field];
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) if (needsUpload(item)) slots.push({ field, index, value: item });
    } else if (value !== undefined && needsUpload(value)) {
      slots.push({ field, index: null, value });
    }
  }
  return slots;
}

/** A copy of `body` with each media slot (in `mediaSlots` order) replaced by `urls`. */
export function withMedia(body: Record<string, unknown>, urls: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) out[key] = Array.isArray(value) ? [...value] : value;
  mediaSlots(body).forEach((slot, i) => {
    const url = urls[i];
    if (url === undefined) return;
    if (slot.index === null) out[slot.field] = url;
    else (out[slot.field] as unknown[])[slot.index] = url;
  });
  return out;
}

/** A short name for a media value, for messages and placeholders. */
export function describe(value: unknown): string {
  if (typeof value === "string") return basename(value);
  if (value instanceof URL) return basename(value.pathname);
  const name = (value as { name?: unknown } | null)?.name;
  return typeof name === "string" && name ? basename(name) : "file";
}
