// Only same-origin paths are safe redirect targets. On the client the WHATWG
// URL parser normalizes whitespace/backslash tricks ("/\t/evil.com",
// "/\evil.com") before the origin check, so protocol-relative and external
// forms are rejected; anything else falls back to home. SSR (window absent)
// falls back to prefix checks.
export function safeRedirect(raw: string | undefined): string {
  if (typeof window !== "undefined") {
    try {
      const u = new URL(raw ?? "", window.location.origin);
      if (u.origin !== window.location.origin) return "/";
      return u.pathname + u.search + u.hash || "/";
    } catch {
      return "/";
    }
  }
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
