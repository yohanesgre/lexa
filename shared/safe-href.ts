// Link-href scheme allowlist, applied at every render/authoring sink.
// Renderers drop disallowed hrefs entirely (text stays plain, no anchor);
// markdownToDoc drops them at the authoring boundary so the payload is
// never stored. `javascript:` (and friends) in a stored href would execute
// in any viewer's session when clicked — including reading the lxk-api-key
// meta on the same page.
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  const scheme = trimmed.split(":", 1)[0]?.toLowerCase() ?? "";
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return trimmed;
  return null;
}
