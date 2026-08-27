import type { ReactNode } from "react";

// Transcript token chips (mentions-autocomplete.html, transcript state):
// stored message text is PLAIN; the client renders resolvable tokens as
// clickable chips at display time. Task keys (@NIM-231 shape) link to the
// board deep-link; slug-shaped lowercase tokens link to the wiki page.
// Anything else (member names like @Maria, unknown refs) stays plain text.

const TASK_TOKEN_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const SLUG_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TokenSegment {
  kind: "text" | "task" | "wiki";
  text: string;
  ref?: string | undefined;
}

export function tokenizeMentionText(text: string): TokenSegment[] {
  const out: TokenSegment[] = [];
  // "@" preceded by line start or a non-ref character; token = [A-Za-z0-9-]+
  const re = /(^|[^A-Za-z0-9-])@([A-Za-z0-9-]+)/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const prefix = match[1]!;
    const token = match[2]!;
    const start = match.index! + prefix!.length;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    if (TASK_TOKEN_RE.test(token!)) {
      out.push({ kind: "task", text: `@${token}`, ref: token });
    } else if (SLUG_TOKEN_RE.test(token!)) {
      out.push({ kind: "wiki", text: `@${token}`, ref: token });
    } else {
      out.push({ kind: "text", text: `@${token}` });
    }
    last = start + token!.length + 1;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function renderTokenized(text: string, slug: string): ReactNode {
  return tokenizeMentionText(text).map((seg, i) => {
    if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
    const href =
      seg.kind === "task"
        ? `/${encodeURIComponent(slug)}/board?task=${encodeURIComponent(seg.ref ?? "")}`
        : `/${encodeURIComponent(slug)}/wiki/${encodeURIComponent(seg.ref ?? "")}`;
    return (
      <a key={i} href={href} className="mention-chip">
        {seg.kind === "task" ? <span className="task-key">{seg.text}</span> : seg.text}
      </a>
    );
  });
}