import { type Token, type Tokens, marked } from "marked";
import type { TipTapDoc } from "./types";
import { safeHref } from "./safe-href";

type TipTapMark = { type: string; attrs?: Record<string, unknown> };
type TipTapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  text?: string;
  marks?: TipTapMark[];
};

function rawToken(t: Token): string {
  return "raw" in t ? String((t as { raw: unknown }).raw) : JSON.stringify(t);
}

function flattenInline(tokens: Token[], parentMarks: TipTapMark[] = []): TipTapNode[] {
  const out: TipTapNode[] = [];
  let buf = "";

  const flush = () => {
    if (buf) {
      out.push({ type: "text", text: buf, marks: parentMarks.length ? [...parentMarks] : undefined });
      buf = "";
    }
  };

  for (const t of tokens) {
    switch (t.type) {
      case "text":
      case "escape": {
        buf += t.text;
        break;
      }
      case "strong": {
        flush();
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "bold" }]));
        break;
      }
      case "em": {
        flush();
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "italic" }]));
        break;
      }
      case "del": {
        flush();
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "strike" }]));
        break;
      }
      case "codespan": {
        flush();
        out.push({ type: "text", text: t.text, marks: [...parentMarks, { type: "code" }] });
        break;
      }
      case "link": {
        flush();
        // Scheme allowlist at the authoring boundary: disallowed hrefs are
        // dropped entirely — a stored javascript: href would execute in any
        // viewer's session (see shared/safe-href.ts).
        const href = safeHref(t.href);
        const attrs: Record<string, unknown> = {};
        if (href) attrs.href = href;
        if (t.title) attrs.title = t.title;
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "link", attrs }]));
        break;
      }
      case "br": {
        flush();
        out.push({ type: "hardBreak" });
        break;
      }
      case "image":
      case "html": {
        flush();
        out.push({ type: "text", text: t.raw, marks: parentMarks.length ? [...parentMarks] : undefined });
        break;
      }
      default: {
        flush();
        out.push({ type: "text", text: rawToken(t), marks: parentMarks.length ? [...parentMarks] : undefined });
        break;
      }
    }
  }

  flush();
  return out;
}

function mapBlock(siblings: Token[]): TipTapNode[] {
  const out: TipTapNode[] = [];
  for (const t of siblings) {
    const node = mapOne(t);
    if (node) out.push(node);
  }
  return out;
}

function mapOne(t: Token): TipTapNode | null {
  switch (t.type) {
    case "heading": {
      const content = flattenInline(t.tokens ?? []);
      return { type: "heading", attrs: { level: t.depth }, content: content.length ? content : [{ type: "text", text: "" }] };
    }
    case "paragraph":
    case "text": {
      const content = flattenInline(t.tokens ?? []);
      if (!content.length && t.text) content.push({ type: "text", text: t.text });
      return content.length ? { type: "paragraph", content } : null;
    }
    case "blockquote": {
      const content = mapBlock(t.tokens ?? []);
      return content.length ? { type: "blockquote", content } : null;
    }
    case "code": {
      return { type: "codeBlock", attrs: t.lang ? { language: t.lang } : undefined, content: [{ type: "text", text: t.text }] };
    }
    case "list": {
      const mapped = t.items.map((item: Tokens.ListItem) => mapListItem(item));
      const items = mapped.filter((x: TipTapNode | null): x is TipTapNode => x !== null);
      if (items.length === 0) return null;
      const allTasks = t.items.every((i: Tokens.ListItem) => i.task);
      const noTasks = t.items.every((i: Tokens.ListItem) => !i.task);
      if (noTasks) {
        return {
          type: t.ordered ? "orderedList" : "bulletList",
          attrs: t.ordered && t.start !== 1 ? { start: t.start } : undefined,
          content: items,
        };
      }
      if (allTasks) {
        return { type: "taskList", content: items };
      }
      return { type: "codeBlock", content: [{ type: "text", text: t.raw }] };
    }
    case "hr": {
      return { type: "horizontalRule" };
    }
    case "table":
    case "image":
    case "html": {
      return { type: "codeBlock", content: [{ type: "text", text: t.raw }] };
    }
    case "checkbox":
    case "space": {
      return null;
    }
    default: {
      return { type: "codeBlock", content: [{ type: "text", text: rawToken(t) }] };
    }
  }
}

function mapListItem(item: Tokens.ListItem): TipTapNode | null {
  const children = mapBlock(item.tokens);
  if (children.length === 0) return null;
  return {
    type: item.task ? "taskItem" : "listItem",
    attrs: item.task ? { checked: item.checked ?? false } : undefined,
    content: children,
  };
}

export function markdownToDoc(md: string): TipTapDoc {
  try {
    const tokens: Token[] = [...marked.lexer(md)];
    return { type: "doc", content: mapBlock(tokens) };
  } catch {
    return { type: "doc", content: [] };
  }
}

function renderInline(nodes: TipTapNode[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: TipTapNode): string {
  if (node.type === "text") {
    let result = node.text ?? "";
    const marks = node.marks ?? [];
    for (let i = marks.length - 1; i >= 0; i--) {
      result = applyMark(marks[i], result);
    }
    return result;
  }
  if (node.type === "hardBreak") return "  \\\n";
  return node.text ?? "";
}

function applyMark(mark: TipTapMark, inner: string): string {
  switch (mark.type) {
    case "bold": return `**${inner}**`;
    case "italic": return `*${inner}*`;
    case "strike": return `~~${inner}~~`;
    case "code": return `\`${inner}\``;
    case "link": {
      const href = String(mark.attrs?.href ?? "");
      const title = mark.attrs?.title ? ` "${String(mark.attrs.title)}"` : "";
      return `[${inner}](${href}${title})`;
    }
    default: return inner;
  }
}

function renderBlock(nodes: TipTapNode[]): string {
  return nodes.map(renderNode).join("\n\n");
}

function renderNode(node: TipTapNode): string {
  switch (node.type) {
    case "doc":
      return renderBlock(node.content ?? []);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${renderInline(node.content ?? [])}`;
    }
    case "paragraph":
      return renderInline(node.content ?? []);
    case "blockquote": {
      const inner = renderBlock(node.content ?? []);
      return inner
        .split("\n")
        .map(l => `> ${l}`)
        .join("\n");
    }
    case "codeBlock": {
      const lang = node.attrs?.language ? String(node.attrs.language) : "";
      const text = renderInline(node.content ?? []);
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "bulletList":
      return (node.content ?? []).map(item => renderListItem(item, "-")).join("\n");
    case "orderedList":
      return (node.content ?? []).map(item => renderListItem(item, "1.")).join("\n");
    case "taskList":
      return (node.content ?? []).map(item => renderTaskItem(item)).join("\n");
    case "listItem":
      return renderBlock(node.content ?? []);
    case "taskItem":
      return renderBlock(node.content ?? []);
    case "horizontalRule":
      return "---";
    case "hardBreak":
      return "  \\\n";
    default: {
      const text = collectText(node);
      return `\`\`\`\n${text}\n\`\`\``;
    }
  }
}

function renderListItem(item: TipTapNode, marker: string): string {
  const blocks = renderBlock(item.content ?? []).split("\n\n");
  return blocks
    .map((b, i) => (i === 0 ? `${marker} ${b}` : `  ${b}`))
    .join("\n\n");
}

function renderTaskItem(item: TipTapNode): string {
  const checked = Boolean(item.attrs?.checked) ? "x" : " ";
  const blocks = renderBlock(item.content ?? []).split("\n\n");
  return blocks
    .map((b, i) => (i === 0 ? `- [${checked}] ${b}` : `  ${b}`))
    .join("\n\n");
}

function collectText(node: TipTapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.content && node.content.length > 0) {
    return node.content.flatMap((c) => { const t = collectText(c); return t ? [t] : []; }).join(" ");
  }
  return "";
}

export function docToMarkdown(doc: TipTapDoc): string {
  try {
    return renderBlock(doc.content as TipTapNode[]);
  } catch {
    return "";
  }
}

// Echo-comparison normalization for GitHub content sync: GitHub normalizes
// boundary whitespace (trailing newline, CRLF) when it stores an issue body,
// so a raw compare would flag our own push as an external edit. Trim + LF only
// at the string edges — the Markdown structure itself is never touched.
export function normalizeMarkdownForEcho(text: string | null): string {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").trim();
}
