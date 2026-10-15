import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthenticationError, DEFAULT_BASE_URL, KEYS_URL, SumeError } from "./errors.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `https://api.open.sume.com/v1/` → `https://api.open.sume.com`. Plain http is
 * accepted for a local server only: anywhere else it would send the key across
 * the network in the clear.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SumeError(`baseUrl is not a URL: "${raw}".`, {
      hint: `Use the full address, like ${DEFAULT_BASE_URL}.`,
      code: "invalid_base_url",
    });
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new SumeError(`baseUrl must use https: "${raw}".`, {
      hint: "Plain http is accepted only for localhost.",
      code: "invalid_base_url",
    });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "")}`;
}

/**
 * `SUME_API_KEY` from a `.env` file in `directory`. Only that one line is read:
 * the API host never comes from a project file, so a cloned repository cannot
 * send your key elsewhere.
 */
export function dotEnvKey(directory: string = process.cwd()): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(directory, ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?SUME_API_KEY\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[1] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, "");
    return value.trim() || undefined;
  }
  return undefined;
}

/** A key goes into an HTTP header: refuse anything a key never contains, without quoting it. */
export function checkKey(raw: string): string {
  const key = raw.trim();
  if (!/^[\x21-\x7e]+$/u.test(key)) {
    throw new AuthenticationError("The API key contains spaces, line breaks or other characters a key never has.", {
      hint: `Copy the key again from ${KEYS_URL}.`,
      code: "invalid_api_key",
    });
  }
  return key;
}

/** `apiKey` first, then `SUME_API_KEY`, then `SUME_API_KEY` in `./.env`. */
export function resolveApiKey(explicit: string | undefined): string | undefined {
  if (explicit?.trim()) return checkKey(explicit);
  const fromEnv = process.env.SUME_API_KEY;
  if (fromEnv?.trim()) return checkKey(fromEnv);
  const fromFile = dotEnvKey();
  return fromFile ? checkKey(fromFile) : undefined;
}

/** `baseUrl` first, then `SUME_API_BASE_URL`, then Open's production API. */
export function resolveBaseUrl(explicit: string | undefined): string {
  return normalizeBaseUrl(explicit || process.env.SUME_API_BASE_URL || DEFAULT_BASE_URL);
}

/** Keys spend money: refuse to run where a page's visitors could read them. */
export function assertServer(): void {
  const scope = globalThis as { window?: unknown; document?: unknown };
  if (typeof scope.window !== "undefined" && typeof scope.document !== "undefined") {
    throw new SumeError(
      "@sume-com/open runs on servers only: a key in a browser can be read by anyone who opens the page.",
      {
        hint: "Call it from your backend (an API route, a server action, a worker) and send the result to the browser.",
        code: "browser_not_supported",
      },
    );
  }
}
