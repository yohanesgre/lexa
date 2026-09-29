import type { ReactNode } from "react";
import { withKeys } from "./withKeys";

// Transcript token chips (mentions-autocomplete.html, transcript state):
// stored message text is PLAIN; the client renders resolvable tokens as
// chips at display time. Task keys (@NIM-231 shape) are unambiguous and link
// to the board deep-link. Slug-shaped lowercase tokens are ambiguous — the
// client cannot tell a wiki slug from a milestone/swimlane/column derived
// slug — so they render as plain chips with no link. `$name` skill tokens
// render as accent-tinted non-link chips (.mention-chip-skill). Anything
// else (member names like @Maria, unknown refs) stays plain text.

const TASK_TOKEN_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const SLUG_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_TOKEN_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

export interface TokenSegment {
  kind: "text" | "task" | "wiki" | "skill";
  text: string;
  ref?: string | undefined;
}

export function tokenizeMentionText(text: string): TokenSegment[] {
  const out: TokenSegment[] = [];
  // "@" or "$" preceded by line start or a non-ref character; token =
  // [A-Za-z0-9-]+ (the "$" path additionally requires a letter first).
  const re = /(^|[^A-Za-z0-9-])([@$])([A-Za-z0-9-]+)/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const prefix = match[1]!;
    const sigil = match[2]!;
    const token = match[3]!;
    const start = match.index! + prefix!.length;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    if (sigil === "$") {
      if (SKILL_TOKEN_RE.test(token!)) {
        out.push({ kind: "skill", text: `$${token}`, ref: token });
      } else {
        out.push({ kind: "text", text: `$${token}` });
      }
    } else if (TASK_TOKEN_RE.test(token!)) {
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
  return withKeys(tokenizeMentionText(text), (seg) => `${seg.kind}:${seg.text}`).map(({ item: seg, key: k }) => {
    if (seg.kind === "text") return <span key={k}>{seg.text}</span>;
    if (seg.kind === "skill") {
      return (
        <span key={k} className="mention-chip-skill">
          {seg.text}
        </span>
      );
    }
    if (seg.kind === "wiki") {
      // Slug-shaped @token: the target could be a wiki page OR an entity
      // (milestone/swimlane/column) derived slug, and the client cannot tell
      // them apart — chip without a link rather than a dead /wiki route.
      return (
        <span key={k} className="mention-chip">
          {seg.text}
        </span>
      );
    }
    const href = `/${encodeURIComponent(slug)}/board?task=${encodeURIComponent(seg.ref ?? "")}`;
    return (
      <a key={k} href={href} className="mention-chip">
        <span className="task-key">{seg.text}</span>
      </a>
    );
  });
}