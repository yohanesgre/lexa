// Link-href scheme allowlist, applied at every render/authoring sink.
// Renderers drop disallowed hrefs entirely (text stays plain, no anchor);
// markdownToDoc drops them at the authoring boundary so the payload is
// never stored. `javascript:` (and friends) in a stored href would execute
// in any viewer's session when clicked.
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  const scheme = trimmed.split(":", 1)[0]?.toLowerCase() ?? "";
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return trimmed;
  return null;
}

// Same-origin root-relative guard, mirrored from safeRedirect
// (app/routes/login.tsx): a leading "/" is in-app, but "//" (protocol-relative)
// and "/\" (backslash-smuggled origin) point elsewhere and are rejected.
export function isSameOriginPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

// Link-sink variant that additionally accepts same-origin relative paths.
// Used only where relative in-app navigation is legitimate (the public share
// render path); image sinks and markdown conversion keep using safeHref so
// non-attachment relative srcs stay dropped.
export function safeRelativeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (isSameOriginPath(trimmed)) return trimmed;
  return safeHref(trimmed);
}
