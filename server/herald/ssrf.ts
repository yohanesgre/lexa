import { Data } from "effect";

export const FETCH_URL_TEXT_CAP = 512 * 1024;
export const FETCH_URL_PDF_CAP = 5 * 1024 * 1024;
export const FETCH_URL_TIMEOUT_MS = 15_000;
export const FETCH_URL_MAX_REDIRECTS = 5;

export class UrlBlocked extends Data.TaggedError("UrlBlocked")<{ reason: string }> {}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = [Number(m[1]!), Number(m[2]!), Number(m[3]!), Number(m[4]!)];
  if (octets.some((n) => n > 255)) return false;
  const a = octets[0]!; // length 4 guaranteed
  const b = octets[1]!; // length 4 guaranteed
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("::ffff:")) return isPrivateIpv4(h.slice(7));
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

// Hostname suffix match: "example.com" allows "example.com" and
// "api.example.com" but not "notexample.com".
export function hostAllowed(hostname: string, allowlist: string | null): boolean {
  if (allowlist === null || allowlist.trim() === "") return true;
  const hosts = allowlist
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) return true;
  const target = hostname.toLowerCase();
  return hosts.some((h) => target === h || target.endsWith(`.${h}`));
}

// Validate one hop. Re-run for every redirect location — a redirect never
// bypasses scheme/IP/allowlist checks.
export function validateUrl(raw: string, allowlist: string | null): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlBlocked({ reason: "invalid URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlBlocked({ reason: `scheme '${url.protocol}' is not allowed` });
  }
  if (isBlockedHost(url.hostname)) {
    throw new UrlBlocked({ reason: "private or reserved addresses are blocked" });
  }
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new UrlBlocked({ reason: "host is not on the project's URL allowlist" });
  }
  return url;
}
