import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidRequestError } from "./errors.js";
import { isHttpUrl } from "./media.js";

/** Request fields that carry media by URL. A string in one of them that is not a URL is a file path. */
export const MEDIA_FIELDS = new Set([
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
]);

// Short names for media fields. Each value may be a URL, a local path, bytes or a Blob;
// anything but a URL is uploaded first.
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
export const routerFor = (kind: string): Router => (kind === "image" ? "image" : "video");

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? [...value] : [value]);

/** The router request body, without `model`. `undefined` values are left out. */
export function buildBody(
  modelId: string,
  kind: string,
  prompt: string | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const router = routerFor(kind);
  const body: Record<string, unknown> = {};
  if (prompt !== undefined) body.prompt = prompt;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === "model") {
      throw new InvalidRequestError("model is the first argument, not an input.", {
        hint: `Call run("${modelId}", "<prompt>", { … }).`,
        code: "invalid_input",
      });
    }
    if (key === "image" || key === "images") {
      const images = asList(value);
      if (router === "image") body.image_urls = images;
      else if (images.length > 1) {
        throw new InvalidRequestError(`${modelId} takes one image, the first frame.`, {
          hint: "Pass end_image for the last frame, or reference_images for references.",
          code: "invalid_input",
        });
      } else body.image_url = images[0];
    } else if (key in VIDEO_ONLY || key in IMAGE_ONLY) {
      const wanted = key in VIDEO_ONLY ? "video" : "image";
      if (router !== wanted) {
        const article = /^[aeiou]/u.test(kind) ? "an" : "a";
        throw new InvalidRequestError(`${key} applies to ${wanted} models; ${modelId} is ${article} ${kind} model.`, {
          hint: `See what ${modelId} takes with model("${modelId}").`,
          code: "invalid_input",
        });
      }
      const field = (VIDEO_ONLY[key] ?? IMAGE_ONLY[key]) as string;
      body[field] = LIST_FIELDS.has(field) ? asList(value) : value;
    } else {
      body[key] = value;
    }
  }
  // Lip-sync and captions are billed by the clip's length, which the API needs up front.
  if (
    (kind === "lipsync" || kind === "captions") &&
    body.duration === undefined &&
    body.duration_seconds === undefined
  ) {
    const what = `the clip's length in whole seconds${kind === "lipsync" ? " (the audio's, for a photo)" : ""}`;
    throw new InvalidRequestError(`${modelId} needs duration: ${what}.`, {
      hint: `Pass duration: <seconds>; limits are in (await model("${modelId}")).seconds.`,
      code: "invalid_input",
    });
  }
  return body;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A value that can only mean "this file": bytes, a Blob or File, or a `file:` URL. */
function isFileObject(value: unknown): boolean {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    (value instanceof URL && value.protocol === "file:")
  );
}

function needsUpload(value: unknown, inMediaField: boolean): boolean {
  // A string is a file path only where a media URL belongs; elsewhere it is text.
  if (typeof value === "string") return inMediaField && !isHttpUrl(value) && !value.startsWith("data:");
  return isFileObject(value);
}

/** Where a value sits in the body: `["image_urls", 0]`, `["input_references", 0, "image_url", "url"]`. */
export type BodyPath = (string | number)[];

/**
 * Every value to upload before submitting, with where it sits, in a stable order. Bytes, Blobs and
 * `file:` URLs are uploaded wherever they are, nested included; plain strings only where a media URL
 * belongs (a media field, or the `url` of a nested `image_url`, `video_url` or `audio_url`).
 */
export function uploadSlots(body: Record<string, unknown>): { path: BodyPath; value: unknown }[] {
  const slots: { path: BodyPath; value: unknown }[] = [];
  const walk = (value: unknown, path: BodyPath, inMediaField: boolean) => {
    if (needsUpload(value, inMediaField)) slots.push({ path, value });
    else if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) walk(item, [...path, i], inMediaField);
    } else if (isPlainObject(value)) {
      const parent = path[path.length - 1];
      for (const [k, v] of Object.entries(value)) {
        // `{ image_url: { url } }` inside a list like `frame_images` is a media URL too.
        const media = inMediaField || (k === "url" && typeof parent === "string" && parent.endsWith("_url"));
        walk(v, [...path, k], media);
      }
    }
  };
  for (const [key, value] of Object.entries(body)) walk(value, [key], MEDIA_FIELDS.has(key));
  return slots;
}

/** A copy of `body` with each upload slot (in `uploadSlots` order) replaced by `urls`, and URL objects as text. */
export function withUploads(body: Record<string, unknown>, urls: readonly string[]): Record<string, unknown> {
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
    if (value instanceof URL && value.protocol !== "file:") return value.toString();
    return value;
  };
  const out = copy(body) as Record<string, unknown>;
  uploadSlots(body).forEach(({ path }, i) => {
    const url = urls[i];
    if (url === undefined) return;
    let target = out as Record<string | number, unknown>;
    for (const part of path.slice(0, -1)) target = target[part] as Record<string | number, unknown>;
    target[path[path.length - 1] as string | number] = url;
  });
  return out;
}

/** A short name for a media value, for messages and placeholders. */
export function describe(value: unknown): string {
  if (typeof value === "string") return basename(value);
  if (value instanceof URL) return basename(value.protocol === "file:" ? fileURLToPath(value) : value.pathname);
  const name = (value as { name?: unknown } | null)?.name;
  return typeof name === "string" && name ? basename(name) : "file";
}
