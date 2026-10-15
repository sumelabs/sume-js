import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { InvalidRequestError } from "./errors.js";
import { contentTypeForName, EXTENSIONS_LIST, extensionFor, sniffContentType } from "./media.js";

/** What `upload` and media inputs accept: a path, bytes, or a Blob/File. */
export type FileInput = string | URL | Uint8Array | ArrayBuffer | Blob;

export interface Payload {
  data: Uint8Array;
  contentType: string;
  filename: string;
}

/** A path, bytes, or a Blob, as bytes with a media type. */
export async function readPayload(value: unknown, contentType?: string): Promise<Payload> {
  let data: Uint8Array;
  let name: string;
  let kind: string | undefined;
  if (typeof value === "string" || value instanceof URL) {
    const path = value instanceof URL ? fileURLToPath(value) : value;
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      throw new InvalidRequestError(`No such file: ${path}`, {
        hint: "Pass a public https URL, or the path of a file that exists.",
        code: "file_not_found",
      });
    }
    data = new Uint8Array(await readFile(path));
    name = basename(path);
    kind = contentType ?? contentTypeForName(name) ?? sniffContentType(data);
  } else if (value instanceof Uint8Array) {
    data = value;
    name = "upload";
    kind = contentType ?? sniffContentType(data);
  } else if (value instanceof ArrayBuffer) {
    data = new Uint8Array(value);
    name = "upload";
    kind = contentType ?? sniffContentType(data);
  } else if (typeof Blob !== "undefined" && value instanceof Blob) {
    data = new Uint8Array(await value.arrayBuffer());
    const fileName = (value as { name?: unknown }).name;
    name = typeof fileName === "string" && fileName ? basename(fileName) : "upload";
    kind = contentType ?? (value.type || undefined) ?? contentTypeForName(name) ?? sniffContentType(data);
  } else {
    throw new InvalidRequestError(`Cannot upload ${value === null ? "null" : typeof value}.`, {
      hint: "Pass a URL, a file path, bytes (Uint8Array or Buffer), or a Blob.",
      code: "invalid_input",
    });
  }
  if (data.length === 0) throw new InvalidRequestError(`${name} is empty.`, { code: "empty_file" });
  if (!kind) {
    throw new InvalidRequestError(`Cannot tell the media type of ${name}.`, {
      hint: `Pass contentType, or use a file ending in one of: ${EXTENSIONS_LIST}.`,
      code: "unknown_media_type",
    });
  }
  if (!extname(name)) name += extensionFor(kind);
  return { data, contentType: kind, filename: name };
}

/** `job_7513b52d-3669-…` → `7513b52d`. */
export const shortJobId = (jobId: string) => jobId.replace(/^job_/u, "").split("-")[0]?.slice(0, 8) || jobId;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export interface SavableFile {
  url: string;
  type: string;
  contentType: string | null;
}

/**
 * Where each file goes. No path: the working directory, as `<model>-<job>.<ext>`,
 * never overwriting a file. A directory (existing, or ending in `/`): the same
 * names inside it. A file name: the first file takes it, the rest are
 * numbered (`kite.png`, `kite-2.png`). Paths come back absolute.
 */
export async function planPaths(
  files: readonly SavableFile[],
  path: string | undefined,
  model: string | null,
  jobId: string,
): Promise<string[]> {
  const exts = files.map((f) => extensionFor(f.contentType, f.url, f.type));
  const stem = `${(model ?? "sume").replace(/[^A-Za-z0-9._-]+/gu, "-")}-${shortJobId(jobId)}`;
  const many = files.length > 1;
  const target = path ? resolve(path) : undefined;
  const isDir =
    target === undefined ||
    path?.endsWith("/") ||
    path?.endsWith(sep) ||
    (await stat(target).then(
      (s) => s.isDirectory(),
      () => false,
    ));
  if (isDir) {
    const directory = target ?? process.cwd();
    const taken = new Set<string>();
    const out: string[] = [];
    for (const [i, ext] of exts.entries()) {
      const base = many ? `${stem}-${i + 1}` : stem;
      let candidate = join(directory, `${base}${ext}`);
      for (let n = 2; taken.has(candidate) || (await exists(candidate)); n++)
        candidate = join(directory, `${base}-${n}${ext}`);
      taken.add(candidate);
      out.push(candidate);
    }
    return out;
  }
  const given = extname(target);
  const base = given ? target.slice(0, -given.length) : target;
  return exts.map((ext, i) => (i === 0 ? `${base}${given || ext}` : `${base}-${i + 1}${ext}`));
}

/** Write a response body to `path` through a `.part` file, so a failure never leaves half a file. */
export async function writeResponse(response: Response, path: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  try {
    if (!response.body) throw new Error("empty response");
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(part),
    );
    await rename(part, path);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return (await stat(path)).size;
}
