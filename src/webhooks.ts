import { createHmac, timingSafeEqual } from "node:crypto";

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? "";
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(",") : (value ?? "");
  }
  return "";
}

export interface VerifyOptions {
  /** Refuse deliveries older than this many seconds (default 600). 0 turns the check off. */
  toleranceSeconds?: number;
  /** The current time in seconds, for tests. */
  now?: number;
}

/**
 * True when `body` was signed by Sume with `secret` within the tolerance.
 *
 * Pass the raw request body, exactly as received: re-serialized JSON will not
 * match. `secret` is the signing secret of the account that made the job. The scheme is `sume-v1`:
 * HMAC-SHA256 over `{x-sume-webhook-timestamp}.{body}`, sent as
 * `x-sume-webhook-signature: sume-v1=<hex>`. During a secret rotation the
 * header carries two signatures, comma-separated; either one passes.
 */
export function verifyWebhook(
  body: string | Uint8Array,
  headers: HeaderBag,
  secret: string,
  options: VerifyOptions = {},
): boolean {
  const timestamp = header(headers, "x-sume-webhook-timestamp").trim();
  const signatures = header(headers, "x-sume-webhook-signature");
  if (!timestamp || !signatures || !secret || !/^\d+$/u.test(timestamp)) return false;
  const tolerance = options.toleranceSeconds ?? 600;
  const now = options.now ?? Date.now() / 1000;
  if (tolerance > 0 && Math.abs(now - Number(timestamp)) > tolerance) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
    .digest();
  for (const part of signatures.split(",")) {
    const [scheme, digest] = part.trim().split("=", 2);
    if (scheme !== "sume-v1" || !digest || !/^[0-9a-fA-F]{64}$/u.test(digest)) continue;
    if (timingSafeEqual(Buffer.from(digest.toLowerCase(), "hex"), expected)) return true;
  }
  return false;
}
