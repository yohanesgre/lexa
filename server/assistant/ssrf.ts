import { Data } from "effect";
import { lookup } from "node:dns/promises";

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
  const a = octets[0]!;
  const b = octets[1]!;
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

async function validateIpBlocks(hostname: string): Promise<void> {
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    return;
  }
  for (const a of addrs) {
    const ip = a.address;
    if (isPrivateIpv4(ip) || isPrivateIpv6(ip)) {
      throw new UrlBlocked({ reason: "private or reserved addresses are blocked" });
    }
  }
}

export async function validateUrl(raw: string, allowlist: string | null): Promise<URL> {
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
  await validateIpBlocks(url.hostname);
  return url;
}
