#!/usr/bin/env node
// Generate src/generated.ts from the API: the model ids, the request fields, and one input type per model.
//
//   node scripts/generate.mjs            # rewrite the generated file
//   node scripts/generate.mjs --check    # exit 1 if the API has moved on
//
// The model ids, prices and limits come from the open catalog (GET /v1/open/catalog); the fields,
// their types and their descriptions from the two router request schemas in GET /v1/openapi.json.
// SUME_API_BASE_URL picks the API (default https://api.open.sume.com).
import { readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.SUME_API_BASE_URL || "https://api.open.sume.com").replace(/\/+$/u, "").replace(/\/v1$/u, "");
const OUT = new URL("../src/generated.ts", import.meta.url);
const ROUTERS = { image: "/v1/image-router/generate", video: "/v1/video-router/generate" };
// Fields the client sets itself.
const SKIP = new Set(["model", "mode", "wait_timeout_seconds"]);
const MEDIA = new Set([
  "image_urls",
  "input_urls",
  "image_url",
  "end_image_url",
  "video_url",
  "audio_url",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
  "mask_url",
  "mask_image_url",
]);
const SHORT = {
  image: {
    image: [
      "FileInput | FileInput[]",
      "The input image or images (`image_urls`): a URL, a file path, bytes or a Blob. Uploaded first when not a URL.",
    ],
    images: ["FileInput[]", "Several input images (`image_urls`). Uploaded first when not URLs."],
    mask: ["FileInput", "The edit mask (`mask_url`). Uploaded first when not a URL."],
  },
  video: {
    image: [
      "FileInput",
      "The first frame (`image_url`): a URL, a file path, bytes or a Blob. Uploaded first when not a URL.",
    ],
    end_image: ["FileInput", "The last frame (`end_image_url`). Uploaded first when not a URL."],
    video: ["FileInput", "The input video (`video_url`). Uploaded first when not a URL."],
    audio: ["FileInput", "The input audio (`audio_url`). Uploaded first when not a URL."],
    reference_images: ["FileInput[]", "Reference images (`reference_image_urls`). Uploaded first when not URLs."],
    reference_videos: ["FileInput[]", "Reference videos (`reference_video_urls`). Uploaded first when not URLs."],
    reference_audios: ["FileInput[]", "Reference audio (`reference_audio_urls`). Uploaded first when not URLs."],
  },
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "user-agent": "sume-js generate" } });
  if (!res.ok) throw new Error(`GET ${BASE}${path} answered ${res.status}`);
  return res.json();
}

const spec = await get("/v1/openapi.json");
const catalog = (await get("/v1/open/catalog")).data.models.sort((a, b) => a.id.localeCompare(b.id));

function resolve(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return {};
    const target = node.$ref
      .replace(/^#\//u, "")
      .split("/")
      .reduce((t, part) => t?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
    return resolve(target, new Set([...seen, node.$ref]));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v, seen)]));
}

/** The description, cut at a sentence end so hovers stay readable. */
function doc(text, limit = 400) {
  let out = String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (out.length > limit) {
    const cut = out.lastIndexOf(". ", limit);
    out = cut > 80 ? out.slice(0, cut + 1) : `${out.slice(0, limit).trimEnd()}…`;
  }
  return out.replaceAll("*/", "*\\/");
}

const jsdoc = (text, indent = "  ") => (text ? `${indent}/** ${text} */\n` : "");
const pascal = (name) =>
  name
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
const union = (values) => values.map((v) => JSON.stringify(v)).join(" | ");

const nested = new Map();

function typeOf(name, schema, media) {
  if (media) return schema.type === "array" ? "FileInput[]" : "FileInput";
  const options = schema.oneOf ?? schema.anyOf;
  if (options) {
    const parts = [...new Set(options.map((o) => typeOf(name, o, false)))];
    const plain = parts.includes("string") ? parts.filter((p) => !p.startsWith('"')) : parts;
    return plain.join(" | ");
  }
  let kind = schema.type;
  if (Array.isArray(kind)) kind = kind.find((k) => k !== "null") ?? "string";
  if (schema.enum && (kind === "string" || kind === "integer" || kind === undefined)) return union(schema.enum);
  if (kind === "string") return "string";
  if (kind === "integer" || kind === "number") return "number";
  if (kind === "boolean") return "boolean";
  if (kind === "array") {
    const item = typeOf(name, schema.items ?? {}, false);
    return item.includes("|") ? `Array<${item}>` : `${item}[]`;
  }
  if (kind === "object" && schema.properties) return objectType(name, schema);
  return "Record<string, unknown>";
}

function objectType(name, schema) {
  const typeName = pascal(name);
  let body = "";
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.deprecated) continue;
    body += jsdoc(doc(field.description));
    // A nested `url` inside an `image_url`/`video_url`/`audio_url` object is a media input like the top-level ones.
    const media = key === "url" && name.endsWith("_url");
    body += `  ${key}?: ${typeOf(`${name}_${key}`, field, media)};\n`;
  }
  nested.set(typeName, `${jsdoc(doc(schema.description, 300), "")}export interface ${typeName} {\n${body}}\n`);
  return typeName;
}

const routerFields = {};
for (const [router, path] of Object.entries(ROUTERS)) {
  const schema = resolve(spec.paths[path].post.requestBody.content["application/json"].schema);
  routerFields[router] = Object.entries(schema.properties)
    .filter(([key, field]) => !SKIP.has(key) && !field.deprecated)
    .map(([key, field]) => [key, typeOf(key, field, MEDIA.has(key)), doc(field.description)]);
}

function routerInterface(router) {
  const name = router === "image" ? "ImageInput" : "VideoInput";
  let body = "";
  for (const [key, [type, text]] of Object.entries(SHORT[router])) body += `${jsdoc(text)}  ${key}?: ${type};\n`;
  for (const [key, type, text] of routerFields[router]) body += `${jsdoc(text)}  ${key}?: ${type};\n`;
  const what = router === "image" ? "image models" : "video, lip-sync and caption models";
  return `/** The request fields ${what} take, by the API's own names, plus short names for media. */\nexport interface ${name} {\n${body}}\n`;
}

const UNITS = { second: "/s", image: "/image" };

function modelDoc(m) {
  const caps = m.capabilities ?? {};
  const price = `$${m.pricing.from_usd}${m.pricing.to_usd && m.pricing.to_usd !== m.pricing.from_usd ? `–$${m.pricing.to_usd}` : ""}${UNITS[m.pricing.unit] ?? `/${m.pricing.unit}`}`;
  const parts = [`${m.name} by ${m.company?.name ?? "?"}: ${m.kind}, ${price}.`];
  if (caps.resolutions?.length) parts.push(`Resolutions: ${caps.resolutions.join(", ")}.`);
  if (caps.duration_seconds) parts.push(`Duration: ${caps.duration_seconds.min}–${caps.duration_seconds.max} s.`);
  if (caps.max_images) parts.push(`Up to ${caps.max_images} images.`);
  for (const note of m.constraints ?? []) parts.push(note);
  return doc(parts.join(" "), 600);
}

// Each model's own values, offered as suggestions; any other string still type-checks, because the
// API takes values the catalog does not list (kling-3 takes "720p" and renders 1080p).
function hints(m) {
  const caps = m.capabilities ?? {};
  const pick = (values, label) => (Array.isArray(values) && values.length ? [label, values.map(String)] : undefined);
  return [
    pick(caps.resolutions, "resolution"),
    pick(caps.aspect_ratios, "aspect_ratio"),
    pick(caps.qualities, "quality"),
    pick(caps.output_formats, "output_format"),
  ].filter(Boolean);
}

const typeNames = new Map();
let models = "";
let map = "";
for (const m of catalog) {
  const base = m.kind === "image" ? "ImageInput" : "VideoInput";
  const typeName = `${pascal(m.id)}Input`;
  if (typeNames.has(typeName)) throw new Error(`${m.id} and ${typeNames.get(typeName)} would share ${typeName}`);
  typeNames.set(typeName, m.id);
  const router = routerFields[m.kind === "image" ? "image" : "video"];
  const fields = hints(m).flatMap(([label, values]) => {
    const field = router.find(([k]) => k === label);
    if (!field) return [];
    const text = doc(`${field[2] ? `${field[2]} ` : ""}${m.name} lists ${values.join(", ")}.`, 600);
    return [`${jsdoc(text)}  ${label}?: ${union(values)} | (string & {});`];
  });
  const body = fields.length
    ? `Omit<${base}, ${hints(m)
        .filter(([label]) => router.some(([k]) => k === label))
        .map(([label]) => JSON.stringify(label))
        .join(" | ")}> & {\n${fields.join("\n")}\n}`
    : base;
  models += `/** ${modelDoc(m)} */\nexport type ${typeName} = ${body};\n\n`;
  map += `  ${JSON.stringify(m.id)}: ${typeName};\n`;
}

const ids = catalog.map((m) => m.id);
const kinds = Object.fromEntries(catalog.map((m) => [m.id, m.kind]));
const header = `// Generated by scripts/generate.mjs from ${BASE}: the open catalog (${ids.length} models) and the router
// request schemas in ${spec.info?.title ?? "the OpenAPI document"} ${spec.info?.version ?? ""}. Do not edit by hand: run \`node scripts/generate.mjs\`.
import type { FileInput } from "./files.js";
`;
const next = [
  header,
  `/** Every model in the open catalog when this version was built. \`models()\` lists the live catalog. */\nexport type ModelId = ${union(ids)};\n`,
  `/** Models that make images. */\nexport type ImageModelId = ${union(ids.filter((id) => kinds[id] === "image"))};\n`,
  `/** Models that make video: text and image to video, lip-sync, and captions. */\nexport type VideoModelId = ${union(ids.filter((id) => kinds[id] !== "image"))};\n`,
  `/** Each known model's kind, so a run needs no catalog lookup to pick its router. */\nexport const MODEL_KINDS: Readonly<Record<string, "image" | "video" | "lipsync" | "captions">> = ${JSON.stringify(kinds, null, 2)};\n`,
  ...nested.values(),
  routerInterface("image"),
  routerInterface("video"),
  models,
  `/** The input type of each model, by id. */\nexport interface ModelInputs {\n${map}}\n`,
].join("\n");

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== next) {
    console.error("src/generated.ts is behind the API. Run `node scripts/generate.mjs`.");
    process.exit(1);
  }
  console.log("Generated types match the API.");
} else {
  writeFileSync(OUT, next);
  console.log(`Wrote ${ids.length} models and ${nested.size + 2} input types to src/generated.ts`);
}
