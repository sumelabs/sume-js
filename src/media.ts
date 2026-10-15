import { extname } from "node:path";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "model/gltf-binary": ".glb",
  "application/json": ".json",
};

export const EXTENSIONS_LIST = Object.keys(TYPES).sort().join(" ");

export function contentTypeForName(name: string): string | undefined {
  return TYPES[extname(name).toLowerCase()];
}

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** The media type from the first bytes, for uploads that have no file name. */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] === 0xfb || b[1] === 0xf3 || b[1] === 0xf2)))
    return "audio/mpeg";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(b, 0, 4) === "fLaC") return "audio/flac";
  return undefined;
}

/** The file extension for a result: its content type first, then its URL, then its kind. */
export function extensionFor(contentType: string | null | undefined, url?: string, kind?: string): string {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type && EXTENSIONS[type]) return EXTENSIONS[type];
  if (url) {
    try {
      const ext = extname(new URL(url).pathname).toLowerCase();
      if (ext && TYPES[ext]) return ext;
    } catch {
      // Not a URL; fall through.
    }
  }
  return kind === "image" ? ".png" : kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".bin";
}

export const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value);
