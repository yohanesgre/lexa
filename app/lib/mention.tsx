import { type ReactNode } from "react";
import { withKeys } from "./withKeys";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitMentions(text: string, memberNames: string[]): { text: string; mention: boolean }[] {
  if (!memberNames.length || !text.includes("@")) return [{ text, mention: false }];
  const names = memberNames
    .filter((name) => name.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (!names.length) return [{ text, mention: false }];
  const re = new RegExp(`@(?:${names.join("|")})(?=\\s|[.,;!?]|$)`, "g");
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), mention: false });
    parts.push({ text: match[0], mention: true });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts.length ? parts : [{ text, mention: false }];
}

export function renderCommentText(text: string, memberNames: string[]): ReactNode {
  const segments = splitMentions(text, memberNames);
  return withKeys(segments, (segment) => `${segment.mention ? "m" : "p"}:${segment.text}`).map(({ item, key }) =>
    item.mention ? <span key={key} className="mention-chip">{item.text}</span> : item.text
  );
}
