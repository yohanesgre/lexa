import { type ReactNode } from "react";
import type { TipTapDoc } from "../../../shared/types";
import { cn } from "../ui/cn";

// Render-time mention highlight over project member names (wireframe:
// mention chip, no delivery). Unknown @names render plain. The doc walk is
// a local copy of tiptap-render's renderNode/renderInline — Task 16 owns
// that file, so mention splitting lives here instead of the shared renderer.

type TTNode = {
  type: string;
  content?: TTNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split a text run into plain / mention segments. Mentions match whole
// member names preceded by @ (longest name first so "Maria Kim" wins over
// "Maria"), and stop at whitespace or punctuation.
function splitMentions(text: string, memberNames: string[]): { text: string; mention: boolean }[] {
  if (!memberNames.length || !text.includes("@")) return [{ text, mention: false }];
  const names = memberNames
    .filter((n) => n.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (!names.length) return [{ text, mention: false }];
  const re = new RegExp(`@(?:${names.join("|")})(?=\\s|[.,;!?]|$)`, "g");
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: text.slice(last, idx), mention: false });
    parts.push({ text: m[0], mention: true });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts.length ? parts : [{ text, mention: false }];
}

function applyMarks(segment: { text: string; mention: boolean }, marks: TTNode["marks"], keyPrefix: string): ReactNode {
  let el: ReactNode = segment.mention ? (
    <span key={`${keyPrefix}-m`} className="mention-chip">
      {segment.text}
    </span>
  ) : (
    segment.text
  );
  for (const mark of marks ?? []) {
    if (mark.type === "bold") el = <strong key={`${keyPrefix}-b`}>{el}</strong>;
    else if (mark.type === "italic") el = <em key={`${keyPrefix}-i`}>{el}</em>;
    else if (mark.type === "code") el = <code key={`${keyPrefix}-c`} className="td-code">{el}</code>;
    else if (mark.type === "link")
      el = (
        <a key={`${keyPrefix}-l`} href={String(mark.attrs?.href ?? "#")} target="_blank" rel="noreferrer">
          {el}
        </a>
      );
  }
  return el;
}

function renderInlineNodes(nodes: TTNode[] | undefined, members: string[], keyPrefix: string): ReactNode {
  if (!nodes) return null;
  return nodes.map((node, i) => {
    const nodeKey = `${keyPrefix}-${i}`;
    if (node.type === "text") {
      const segments = splitMentions(node.text ?? "", members);
      return (
        <span key={`${nodeKey}-t`}>
          {segments.map((s, j) => applyMarks(s, node.marks, `${nodeKey}-s${j}`))}
        </span>
      );
    }
    if (node.type === "hardBreak") return <br key={nodeKey} />;
    return renderBlockNode(node, members, nodeKey);
  });
}

function renderBlockNode(node: TTNode, members: string[], key: string): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={key} className="td-p">{renderInlineNodes(node.content, members, key)}</p>;
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const cls = level <= 1 ? "td-h1" : level === 2 ? "td-h2" : "td-h3";
      return <h2 key={key} className={cls}>{renderInlineNodes(node.content, members, key)}</h2>;
    }
    case "bulletList":
      return <ul key={key} className="td-ul">{renderInlineNodes(node.content, members, key)}</ul>;
    case "orderedList":
      return <ol key={key} className="td-ol">{renderInlineNodes(node.content, members, key)}</ol>;
    case "listItem":
      return <li key={key}>{renderInlineNodes(node.content, members, key)}</li>;
    case "codeBlock":
      return (
        <pre key={key} className="td-pre">
          <code>{collectText(node)}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={key} className="td-quote">{renderInlineNodes(node.content, members, key)}</blockquote>;
    case "horizontalRule":
      return <hr key={key} className="td-hr" />;
    default:
      return node.content ? <div key={key}>{renderInlineNodes(node.content, members, key)}</div> : null;
  }
}

function collectText(node: TTNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(collectText).join("");
}

function hasText(nodes: TTNode[]): boolean {
  return nodes.some((n) => (n.type === "text" && !!n.text?.trim()) || (n.content ? hasText(n.content) : false));
}

export function CommentBody({ body, members }: { body: TipTapDoc; members: string[] }) {
  const nodes = body.content as TTNode[];
  if (!hasText(nodes ?? [])) return null;
  return <div className={cn("comment-text")}>{nodes.map((node, i) => renderBlockNode(node, members, `n${i}`))}</div>;
}
