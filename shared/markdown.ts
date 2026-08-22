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

// Attachment image srcs are root-relative Lexa URLs. Relative srcs are only
// accepted for this exact shape (uuid v4); every other relative src is
// dropped, as are non-http(s) schemes (javascript:, data:, file:).
const ATTACHMENT_SRC_RE = /^\/api\/attachments\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function safeImageSrc(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (ATTACHMENT_SRC_RE.test(trimmed)) return trimmed;
  return safeHref(trimmed);
}

function absolutizeAttachmentSrc(src: string, baseUrl: string | undefined): string {
  if (!baseUrl || !ATTACHMENT_SRC_RE.test(src)) return src;
  try {
    return new URL(src, baseUrl).toString();
  } catch {
    return src;
  }
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
      case "image": {
        flush();
        // Same scheme allowlist as links, applied at the authoring boundary:
        // a stored image src that can't render as http(s) is dropped entirely.
        // `javascript:` in src is inert in an <img>, but data: / file: can
        // carry tracking or huge payloads, so the allowlist still applies.
        // Root-relative /api/attachments/<uuid> srcs are accepted so pulled
        // issue bodies keep their Lexa attachment references (host-agnostic).
        const src = safeImageSrc(t.href);
        if (!src) break;
        const attrs: Record<string, unknown> = { src };
        // marked puts the alt text in t.text, not an attrs field.
        if (t.text) attrs.alt = t.text;
        if (t.title) attrs.title = t.title;
        out.push({ type: "image", attrs });
        break;
      }
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
    case "table": {
      // GFM table: header cells + row cells, each with inline tokens.
      // Alignments (left/center/right) are carried per column; a column with
      // no alignment marker maps to undefined (renderer emits unaligned).
      const mapCells = (cells: Tokens.TableCell[], isHeader: boolean): TipTapNode[] =>
        cells.map((cell, i) => {
          const content = flattenInline(cell.tokens ?? []);
          if (!content.length) content.push({ type: "text", text: cell.text ?? "" });
          // Table cells require block+ content in the TipTap schema — bare
          // inline nodes get dropped when the doc loads in the editor. Wrap
          // the inline content in a paragraph so the round-trip holds.
          return {
            type: isHeader ? "tableHeader" : "tableCell",
            attrs: t.align[i] ? { align: t.align[i] } : undefined,
            content: [{ type: "paragraph", content }],
          };
        });
      const headerRow = t.header.length
        ? [{ type: "tableRow", content: mapCells(t.header, true) }]
        : [];
      const bodyRows = (t.rows ?? []).map((row: Tokens.TableCell[]) => ({
        type: "tableRow",
        content: mapCells(row, false),
      }));
      if (!headerRow.length && bodyRows.length === 0) return null;
      return { type: "table", attrs: undefined, content: [...headerRow, ...bodyRows] };
    }
    case "html": {
      return { type: "codeBlock", content: [{ type: "text", text: t.raw }] };
    }
    case "image": {
      // Images are inline tokens (they carry no block semantics on their
      // own), so block-level standalone images arrive via flattenInline in
      // the enclosing paragraph — this case is a safety net.
      return null;
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

function renderInline(nodes: TipTapNode[], opts?: DocToMarkdownOptions): string {
  return nodes.map((node) => renderInlineNode(node, opts)).join("");
}

function renderInlineNode(node: TipTapNode, opts?: DocToMarkdownOptions): string {
  if (node.type === "text") {
    let result = node.text ?? "";
    const marks = node.marks ?? [];
    for (let i = marks.length - 1; i >= 0; i--) {
      result = applyMark(marks[i], result);
    }
    return result;
  }
  if (node.type === "image") {
    // Round-trips back through the allowlist — a stored image whose src has
    // since become non-http(s) is not re-emitted. With baseUrl, attachment
    // srcs are absolutized so pushed GitHub issue bodies carry absolute URLs.
    const raw = safeImageSrc(node.attrs?.src);
    if (!raw) return "";
    const src = absolutizeAttachmentSrc(raw, opts?.baseUrl);
    const alt = node.attrs?.alt ? String(node.attrs.alt) : "";
    const title = node.attrs?.title ? ` "${String(node.attrs.title)}"` : "";
    return `![${alt}](${src}${title})`;
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

// Pad a table cell so the cell's alignment carries through the pipe-split
// round-trip: right/center-aligned cells get leading/trailing spaces, which
// marked's table parser discards before splitting on pipes.
function alignCell(text: string, align: string | null): string {
  if (!align || align === "left") return text;
  return align === "right" ? ` ${text}` : ` ${text} `;
}

function renderBlock(nodes: TipTapNode[], opts?: DocToMarkdownOptions): string {
  return nodes.map((node) => renderNode(node, opts)).join("\n\n");
}

function renderNode(node: TipTapNode, opts?: DocToMarkdownOptions): string {
  switch (node.type) {
    case "doc":
      return renderBlock(node.content ?? [], opts);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${renderInline(node.content ?? [], opts)}`;
    }
    case "paragraph":
      return renderInline(node.content ?? [], opts);
    case "blockquote": {
      const inner = renderBlock(node.content ?? [], opts);
      return inner
        .split("\n")
        .map(l => `> ${l}`)
        .join("\n");
    }
    case "codeBlock": {
      const lang = node.attrs?.language ? String(node.attrs.language) : "";
      const text = renderInline(node.content ?? [], opts);
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "bulletList":
      return (node.content ?? []).map(item => renderListItem(item, "-", opts)).join("\n");
    case "orderedList":
      return (node.content ?? []).map(item => renderListItem(item, "1.", opts)).join("\n");
    case "taskList":
      return (node.content ?? []).map(item => renderTaskItem(item, opts)).join("\n");
    case "listItem":
      return renderBlock(node.content ?? []);
    case "taskItem":
      return renderBlock(node.content ?? []);
    case "horizontalRule":
      return "---";
    case "table": {
      const rows = (node.content ?? []).filter((n) => n.type === "tableRow");
      const header = rows[0];
      const body = rows.slice(1);
      const colspan = (c: TipTapNode) => {
        const n = Number(c.attrs?.colspan ?? 1);
        return Number.isFinite(n) && n >= 1 ? n : 1;
      };
      // Table dimensions: the row with the most cells (each cell spanning
      // `colspan` columns) sets the column count. Plain cells carry no
      // colstart, so counting cells directly is the reliable measure.
      const columnCount = Math.max(
        1,
        ...rows.map((r) =>
          (r.content ?? []).reduce((sum, c) => sum + colspan(c), 0)
        )
      );
      // Per-column alignment comes from the header cells only; body cells
      // inherit via colstart so `| :--- | ---: |` maps col 2 right.
      const align: Record<number, string> = {};
      const headerCells = (header?.content ?? []).filter(
        (n) => n.type === "tableHeader" || n.type === "tableCell"
      );
      let headerCol = 1;
      for (const c of headerCells) {
        const a = c.attrs?.align ? String(c.attrs.align) : "";
        align[headerCol] = a;
        headerCol += colspan(c);
      }
      const renderCells = (cells: TipTapNode[]): string => {
        // Alignment follows the header column position: track the running
        // column index (cells with colspan occupy multiple columns) so a
        // right-aligned header column aligns its body cells too.
        let col = 1;
        return cells
          .map((c) => {
            const a = align[col] || "";
            col += colspan(c);
            // Cell content is paragraph-wrapped (schema requires block+);
            // unwrap the single paragraph so the pipe-split rendering stays
            // flat — a nested paragraph block would emit blank lines.
            const inline = (c.content ?? []).flatMap((n) =>
              n.type === "paragraph" ? (n.content ?? []) : [n]
            );
            return alignCell(renderInline(inline, opts), a);
          })
          .join(" | ");
      };
      const line = (row?: TipTapNode) => `| ${renderCells((row?.content ?? []).filter((n) => n.type === "tableHeader" || n.type === "tableCell"))} |`;
      const delimiter = `| ${Array.from({ length: columnCount }, (_, i) => {
        const a = align[i + 1] || "";
        return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
      }).join(" | ")} |`;
      const out: string[] = [];
      if (header) out.push(line(header), delimiter);
      for (const r of body) out.push(line(r));
      return out.join("\n");
    }
    case "tableRow": {
      // A row outside a table (shouldn't happen) falls back to its cells.
      return renderBlock(node.content ?? [], opts);
    }
    case "image":
      // Top-level images are wrapped in a paragraph so the renderer emits
      // valid CommonMark (a bare ![..] line is a paragraph in the lexer).
      return renderInline(node.content ?? [], opts) + renderInlineNode(node, opts);
    case "hardBreak":
      return "  \\\n";
    default: {
      const text = collectText(node);
      return `\`\`\`\n${text}\n\`\`\``;
    }
  }
}

function renderListItem(item: TipTapNode, marker: string, opts?: DocToMarkdownOptions): string {
  const blocks = renderBlock(item.content ?? [], opts).split("\n\n");
  return blocks
    .map((b, i) => (i === 0 ? `${marker} ${b}` : `  ${b}`))
    .join("\n\n");
}

function renderTaskItem(item: TipTapNode, opts?: DocToMarkdownOptions): string {
  const checked = Boolean(item.attrs?.checked) ? "x" : " ";
  const blocks = renderBlock(item.content ?? [], opts).split("\n\n");
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

export interface DocToMarkdownOptions {
  // Public origin (e.g. PUBLIC_URL). When set, root-relative attachment image
  // srcs are absolutized so pushed GitHub issue bodies carry absolute URLs.
  // Pure option — no env access here; the call site passes the value.
  baseUrl?: string;
}

export function docToMarkdown(doc: TipTapDoc, opts?: DocToMarkdownOptions): string {
  try {
    return renderBlock(doc.content as TipTapNode[], opts);
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
