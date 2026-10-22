import { parseMarkdown, type BlockNode, type InlineNode } from "@tanstack/markdown";
import { parser as sourceParser } from "@lezer/markdown";
import { safeHref } from "./safe-href";

const MISSING_TASK_SPACE = /\[[ xX]\](?=\r?\n|$)/;

/** Parsing-only compatibility; the stored source must remain unchanged. */
export function normalizeTaskListMarkersForParsing(source: string): string {
  if (!MISSING_TASK_SPACE.test(source)) return source;
  let copiedFrom = 0;
  let projected = "";
  sourceParser.parse(source).iterate({
    enter(node) {
      const checked = source[node.from + 1];
      if (node.name !== "Paragraph" || source[node.from] !== "[" ||
          source[node.from + 2] !== "]" || (checked !== " " && checked !== "x" && checked !== "X")) return;
      const end = node.from + 3;
      if (source[end] !== undefined && source[end] !== "\n" &&
          !(source[end] === "\r" && source[end + 1] === "\n")) return;
      const paragraph = node.node;
      if (paragraph.parent?.name !== "ListItem" || paragraph.prevSibling?.name !== "ListMark") return;
      projected += source.slice(copiedFrom, end) + " ";
      copiedFrom = end;
    },
  });
  return copiedFrom === 0 ? source : projected + source.slice(copiedFrom);
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

function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
      case "inlineCode":
        return node.value;
      case "image":
        return "";
      case "break":
        return "\n";
      case "footnoteReference":
        return `[^${node.id}]`;
      case "inlineHtml":
        return node.value;
      default:
        return "children" in node ? inlineText(node.children) : "";
    }
  }).join("");
}

function blockText(nodes: BlockNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "heading":
      case "paragraph":
        return inlineText(node.children);
      case "code":
        return node.value;
      case "list":
        return node.items.map((item) => blockText(item.children)).join("\n");
      case "blockquote":
      case "callout":
      case "component":
        return blockText(node.children);
      case "table":
        return [node.header, ...node.rows]
          .map((row) => row.map((cell) => inlineText(cell.children)).join("\t"))
          .join("\n");
      case "footnotes":
        return node.items.map((item) => blockText(item.children)).join("\n");
      case "html":
        return node.value;
      case "thematicBreak":
        return "";
    }
  }).join("\n");
}

/** Plain-text projection for diffs and search; image alt text is intentionally omitted. */
export function markdownToText(markdown: string): string {
  return blockText(parseMarkdown(normalizeTaskListMarkersForParsing(markdown), { frontmatter: false }).children).trim();
}

function inlineHasMeaningfulContent(nodes: InlineNode[]): boolean {
  return nodes.some((node) => {
    switch (node.type) {
      case "text":
      case "inlineCode":
        return node.value.trim().length > 0;
      case "image":
        return safeImageSrc(node.src) !== null;
      case "break":
        return false;
      case "footnoteReference":
        return true;
      case "inlineHtml":
        return node.value.trim().length > 0;
      default:
        return "children" in node && inlineHasMeaningfulContent(node.children);
    }
  });
}

function blockHasMeaningfulContent(nodes: BlockNode[]): boolean {
  return nodes.some((node) => {
    switch (node.type) {
      case "heading":
      case "paragraph":
        return inlineHasMeaningfulContent(node.children);
      case "code":
        return node.value.trim().length > 0;
      case "list":
        return node.items.some((item) => blockHasMeaningfulContent(item.children));
      case "blockquote":
      case "component":
        return blockHasMeaningfulContent(node.children);
      case "callout":
        return node.title.trim().length > 0 || blockHasMeaningfulContent(node.children);
      case "table":
        return [...node.header, ...node.rows.flat()].some((cell) => inlineHasMeaningfulContent(cell.children));
      case "footnotes":
        return node.items.some((item) => blockHasMeaningfulContent(item.children));
      case "thematicBreak":
        return true;
      case "html":
        return node.value.trim().length > 0;
    }
  });
}

/** True when Markdown has no visible text, code, safe image, rule, or meaningful table cell. */
export function isMarkdownEmpty(markdown: string): boolean {
  return !blockHasMeaningfulContent(parseMarkdown(normalizeTaskListMarkersForParsing(markdown), { frontmatter: false }).children);
}


// Echo-comparison normalization for GitHub content sync: GitHub normalizes
// boundary whitespace (trailing newline, CRLF) when it stores an issue body,
// so a raw compare would flag our own push as an external edit. Trim + LF only
// at the string edges — the Markdown structure itself is never touched.
export function normalizeMarkdownForEcho(text: string | null): string {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").trim();
}
