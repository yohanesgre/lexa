import { safeHref } from "../../shared/safe-href";
import { safeImageSrc } from "../../shared/markdown";

type TipTapMark = { type: string; attrs?: Record<string, unknown> | undefined };
type TipTapNode = {
  type: string;
  attrs?: Record<string, unknown> | undefined;
  content?: TipTapNode[] | undefined;
  text?: string | undefined;
  marks?: TipTapMark[] | undefined;
};
type TipTapDoc = { type: "doc"; content: TipTapNode[] };

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+.!|<>~-])/g, "\\$1");
}

function renderCodeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
  const pad = ((text.startsWith(" ") || text.endsWith(" ")) && !/^ +$/.test(text)) ||
    text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function renderInline(nodes: TipTapNode[], opts?: LegacySerializeOptions, table = false): string {
  const parts: string[] = [];
  let previous = "";
  let previousFormatted = false;
  for (const node of nodes) {
    const rendered = renderInlineNode(node, opts, table);
    if (!rendered) continue;
    const formatted = node.type === "text" && (node.marks?.length ?? 0) > 0;
    const delimiter = previous.at(-1);
    if (previousFormatted && formatted &&
        (delimiter === "*" || delimiter === "~" || delimiter === "`") &&
        rendered.startsWith(delimiter)) {
      reject("inline", "adjacent formatting delimiter runs require manual cleanup");
    }
    parts.push(rendered);
    previous = rendered;
    previousFormatted = formatted;
  }
  return parts.join("");
}

function renderInlineNode(node: TipTapNode, opts?: LegacySerializeOptions, table = false): string {
  if (node.type === "text") {
    const rawText = node.text ?? "";
    const marks = node.marks ?? [];
    if (marks.some((mark) => mark.type === "code")) return renderCodeSpan(table ? rawText.replaceAll("|", "\\|") : rawText);
    let result = escapeMarkdownText(rawText);
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i];
      if (!mark || mark.type === "link") continue;
      result = applyMark(mark, result, table);
    }
    const link = marks.find((mark) => mark.type === "link");
    if (link) result = applyMark(link, result, table);
    return result;
  }
  if (node.type === "image") {
    const src = safeImageSrc(node.attrs?.src);
    if (!src) reject("image", "unsafe or missing image source");
    const alt = node.attrs?.alt ? escapeMarkdownText(String(node.attrs.alt)) : "";
    const titleText = String(node.attrs?.title ?? "");
    const title = titleText ? ` "${table ? titleText.replaceAll("|", "\\|") : titleText}"` : "";
    return `![${alt}](${table ? src.replaceAll("|", "\\|") : src}${title})`;
  }
  if (node.type === "hardBreak") return "\\\n";
  if (node.type === "mention") {
    const attrs = node.attrs ?? {};
    const refId = typeof attrs.refId === "string" ? attrs.refId : "";
    const label = typeof attrs.label === "string" ? attrs.label : "";
    if (!refId || !label.trim()) reject("mention", "missing reference or label");
    const projectSlug = opts?.projectSlug;
    if (!projectSlug) reject("mention", "project slug required to preserve document link");
    const base = `${opts?.baseUrl?.replace(/\/+$/, "") ?? ""}/${encodeURIComponent(projectSlug)}`;
    const href = attrs.refType === "wiki"
      ? `${base}/wiki/${encodeURIComponent(refId)}`
      : `${base}/board?task=${encodeURIComponent(refId)}`;
    return `[${escapeMarkdownText(label)}](${href})`;
  }
  return node.text ?? "";
}

// A Markdown emphasis run cannot open or close against whitespace: `**bold **`
// is not emphasis, so marked reads it back as literal text and the mark is lost
// on the round trip. The editor keeps the space inside the run when it is typed
// that way, so the boundary whitespace is hoisted outside the markers — which is
// where Markdown requires it anyway.
function wrapTrimmed(inner: string, open: string, close: string): string {
  const lead = /^\s*/.exec(inner)?.[0] ?? "";
  const rest = inner.slice(lead.length);
  const trail = /\s*$/.exec(rest)?.[0] ?? "";
  const body = rest.slice(0, rest.length - trail.length);
  return body ? `${lead}${open}${body}${close}${trail}` : inner;
}

function applyMark(mark: TipTapMark, inner: string, table: boolean): string {
  switch (mark.type) {
    case "bold": return wrapTrimmed(inner, "**", "**");
    case "italic": return wrapTrimmed(inner, "*", "*");
    case "strike": return wrapTrimmed(inner, "~~", "~~");
    case "code": return wrapTrimmed(inner, "`", "`");
    case "link": {
      const href = String(mark.attrs?.href ?? "");
      const titleText = String(mark.attrs?.title ?? "");
      const title = titleText ? ` "${table ? titleText.replaceAll("|", "\\|") : titleText}"` : "";
      return `[${inner}](${table ? href.replaceAll("|", "\\|") : href}${title})`;
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

function renderBlock(nodes: TipTapNode[], opts?: LegacySerializeOptions): string {
  let previousList: "ordered" | "unordered" | null = null;
  let previousBlockquote = false;
  let orderedDelimiter: "." | ")" = opts?.orderedDelimiter ?? ".";
  let unorderedMarker: "-" | "+" = opts?.unorderedMarker ?? "-";
  return nodes.map((node) => {
    if (node.type === "blockquote" && previousBlockquote) {
      throw new Error("Adjacent blockquotes require manual cleanup before conversion");
    }
    let nodeOptions = opts;
    const listKind = node.type === "orderedList" ? "ordered"
      : node.type === "bulletList" || node.type === "taskList" ? "unordered" : null;
    if (listKind === "ordered") {
      orderedDelimiter = previousList === "ordered"
        ? orderedDelimiter === "." ? ")" : "."
        : opts?.orderedDelimiter ?? ".";
      nodeOptions = { ...opts, orderedDelimiter };
    } else if (listKind === "unordered") {
      unorderedMarker = previousList === "unordered"
        ? unorderedMarker === "-" ? "+" : "-"
        : opts?.unorderedMarker ?? "-";
      nodeOptions = { ...opts, unorderedMarker };
    }
    const rendered = renderNode(node, nodeOptions);
    if (rendered.trim().length > 0) {
      previousList = listKind;
      previousBlockquote = node.type === "blockquote";
    }
    return rendered;
  }).join("\n\n");
}

function renderNode(node: TipTapNode, opts?: LegacySerializeOptions): string {
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
      const text = (node.content ?? []).map(collectText).join("");
      const runs = text.match(/`+/g) ?? [];
      const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case "bulletList":
      return (node.content ?? []).map(item => renderListItem(item, opts?.unorderedMarker ?? "-", opts)).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      const delimiter = opts?.orderedDelimiter ?? ".";
      return (node.content ?? []).map(item => renderListItem(item, `${start}${delimiter}`, opts)).join("\n");
    }
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
      const header = rows[0]!;
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
            return alignCell(renderInline(inline, opts, true), a);
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
    case "hardBreak":
      return "\\\n";
    case "tableRow": {
      // A row outside a table (shouldn't happen) falls back to its cells.
      return renderBlock(node.content ?? [], opts);
    }
    case "image":
      // Top-level images are wrapped in a paragraph so the renderer emits
      // valid CommonMark (a bare ![..] line is a paragraph in the lexer).
      return renderInline(node.content ?? [], opts) + renderInlineNode(node, opts);
    default: {
      const text = collectText(node);
      return `\`\`\`\n${text}\n\`\`\``;
    }
  }
}

// Continuations belong to the marker's content column, including multi-digit
// ordered markers and every line of nested code fences.
function renderListLines(text: string, prefix: string, pad: string): string {
  return text.split("\n").map((line, index) =>
    index === 0 ? prefix + line : line ? pad + line : line
  ).join("\n");
}

function renderListItem(item: TipTapNode, marker: string, opts?: LegacySerializeOptions): string {
  return renderListLines(renderBlock(item.content ?? [], opts), `${marker} `, " ".repeat(marker.length + 1));
}

function renderTaskItem(item: TipTapNode, opts?: LegacySerializeOptions): string {
  const checked = Boolean(item.attrs?.checked) ? "x" : " ";
  return renderListLines(renderBlock(item.content ?? [], opts), `${opts?.unorderedMarker ?? "-"} [${checked}] `, "  ");
}

function collectText(node: TipTapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.content && node.content.length > 0) {
    return node.content.flatMap((c) => { const t = collectText(c); return t ? [t] : []; }).join(" ");
  }
  return "";
}

interface LegacySerializeOptions {
  baseUrl?: string;
  projectSlug?: string;
  orderedDelimiter?: "." | ")";
  unorderedMarker?: "-" | "+";
}

type LegacyNode = Record<string, unknown> & { type: string };

const NODE_FIELDS: Record<string, string[]> = {
  doc: ["content"],
  paragraph: ["content"],
  heading: ["attrs", "content"],
  blockquote: ["content"],
  codeBlock: ["attrs", "content"],
  bulletList: ["content"],
  orderedList: ["attrs", "content"],
  listItem: ["content"],
  taskList: ["content"],
  taskItem: ["attrs", "content"],
  horizontalRule: [],
  table: ["content"],
  tableRow: ["content"],
  tableHeader: ["attrs", "content"],
  tableCell: ["attrs", "content"],
  text: ["text", "marks"],
  image: ["attrs"],
  hardBreak: [],
  mention: ["attrs"],
};
const CHILD_TYPES: Record<string, string[]> = {
  doc: ["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "taskList", "horizontalRule", "table", "image"],
  paragraph: ["text", "image", "hardBreak", "mention"],
  heading: ["text", "image", "mention"],
  blockquote: ["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "taskList", "horizontalRule", "table"],
  codeBlock: ["text"],
  bulletList: ["listItem"],
  orderedList: ["listItem"],
  taskList: ["taskItem"],
  listItem: ["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "taskList", "horizontalRule", "table"],
  taskItem: ["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "taskList", "horizontalRule", "table"],
  table: ["tableRow"],
  tableRow: ["tableHeader", "tableCell"],
  tableHeader: ["paragraph"],
  tableCell: ["paragraph"],
};
const MARK_FIELDS: Record<string, string[]> = {
  bold: [], italic: [], strike: [], code: [], link: ["href", "title"],
};

function reject(path: string, message: string): never {
  throw new Error(`Unsupported legacy TipTap content at ${path}: ${message}`);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject(path, "expected object");
}

function checkFields(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reject(path, `unknown field ${key}`);
}

function checkMark(mark: unknown, path: string): void {
  assertRecord(mark, path);
  const type = mark.type;
  if (typeof type !== "string" || !Object.hasOwn(MARK_FIELDS, type)) reject(path, `unsupported mark ${String(type)}`);
  checkFields(mark, ["type", "attrs"], path);
  if (mark.attrs !== undefined) {
    assertRecord(mark.attrs, `${path}.attrs`);
    checkFields(mark.attrs, MARK_FIELDS[type]!, `${path}.attrs`);
    if (type === "link") {
      if (typeof mark.attrs.href !== "string" || !safeHref(mark.attrs.href) || /[\s<>()\\]/.test(mark.attrs.href)) reject(path, "unsafe or unsupported link href");
      if (mark.attrs.title !== undefined && (typeof mark.attrs.title !== "string" || /[()"\\\r\n]/.test(mark.attrs.title))) reject(path, "invalid link title");
    }
  } else if (type === "link") reject(path, "missing link href");
}

function checkAttrs(node: LegacyNode, path: string): void {
  if (node.attrs === undefined) return;
  assertRecord(node.attrs, `${path}.attrs`);
  const attrs = node.attrs;
  const keys: Record<string, string[]> = {
    heading: ["level"],
    codeBlock: ["language"],
    orderedList: ["start"],
    taskItem: ["checked"],
    tableHeader: ["align", "colspan", "rowspan", "colwidth"],
    tableCell: ["align", "colspan", "rowspan", "colwidth"],
    image: ["src", "alt", "title"],
    mention: ["refType", "refId", "label"],
  };
  checkFields(attrs, keys[node.type] ?? [], `${path}.attrs`);
  if (node.type === "heading" && (!Number.isInteger(attrs.level) || Number(attrs.level) < 1 || Number(attrs.level) > 6)) reject(path, "invalid heading level");
  if (node.type === "codeBlock" && attrs.language !== undefined &&
      (typeof attrs.language !== "string" || !/^[A-Za-z0-9_+-]*$/.test(attrs.language))) reject(path, "invalid code language");
  if (node.type === "orderedList" && attrs.start !== undefined &&
      (!Number.isSafeInteger(attrs.start) || Number(attrs.start) < 1 || Number(attrs.start) > 999_999_999)) reject(path, "invalid ordered-list start");
  if (node.type === "taskItem" && attrs.checked !== undefined && typeof attrs.checked !== "boolean") reject(path, "invalid checked state");
  if (node.type === "image") {
    if (typeof attrs.src !== "string" || !safeImageSrc(attrs.src) || /[\s<>()\\]/.test(attrs.src)) reject(path, "unsafe or unsupported image source");
    for (const key of ["alt", "title"]) if (attrs[key] !== undefined &&
        (typeof attrs[key] !== "string" || (key === "title" ? /[()"\\\r\n]/ : /[\r\n"]/).test(String(attrs[key])))) reject(path, `invalid image ${key}`);
  }
  if (node.type === "mention" && (attrs.refType !== "task" && attrs.refType !== "wiki" ||
      typeof attrs.refId !== "string" || !/^[A-Za-z0-9._~-]+$/.test(attrs.refId) ||
      typeof attrs.label !== "string" || !attrs.label.trim())) {
    reject(path, "mention has no supported task/wiki route");
  }
  if (node.type === "tableCell" || node.type === "tableHeader") {
    if (attrs.align !== undefined && attrs.align !== null && !["left", "center", "right"].includes(String(attrs.align))) reject(path, "unsupported table alignment");
    for (const key of ["colspan", "rowspan"]) if (attrs[key] !== undefined && attrs[key] !== 1) reject(path, `unsupported ${key}`);
    if (attrs.colwidth !== undefined && attrs.colwidth !== null) reject(path, "unsupported table column widths");
  }
}

function nodeType(value: unknown): string | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value &&
    typeof value.type === "string" ? value.type : null;
}

function assertNode(nodeValue: unknown, path: string, parentType?: string): asserts nodeValue is LegacyNode {
  assertRecord(nodeValue, path);
  if (nodeType(nodeValue) === null) reject(path, "missing node type");
  const node = nodeValue as LegacyNode;
  if (!Object.hasOwn(NODE_FIELDS, node.type)) reject(path, `unsupported node ${node.type}`);
  checkFields(node, ["type", ...NODE_FIELDS[node.type]!], path);
  checkAttrs(node, path);
  if (node.type === "text") {
    if (typeof node.text !== "string") reject(path, "text node has no text");
    if ((node.text.includes("\n") || node.text.includes("\r")) && parentType !== "codeBlock") {
      reject(path, "newline-bearing text node cannot be represented without loss");
    }
    if (node.text.includes("\r")) reject(path, "carriage returns in text nodes cannot be represented without loss");
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) reject(path, "marks must be an array");
      const seen = new Set<string>();
      for (const [index, mark] of node.marks.entries()) {
        checkMark(mark, `${path}.marks[${index}]`);
        const type = nodeType(mark)!;
        if (seen.has(type)) reject(path, "duplicate text mark");
        seen.add(type);
      }
      if (parentType === "codeBlock" && node.marks.length > 0) reject(path, "marks inside a code block");
      if (seen.has("code") && node.marks.length !== 1) reject(path, "unsupported code-mark combination");
    }
    return;
  }
  if (node.marks !== undefined) reject(path, "marks on non-text node");
  if (node.type in CHILD_TYPES && node.content === undefined &&
      node.type !== "paragraph" && node.type !== "heading" && node.type !== "codeBlock") reject(path, "missing content array");
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) reject(path, "content must be an array");
    const allowedChildren = CHILD_TYPES[node.type] ?? [];
    node.content.forEach((child, index) => {
      const childType = nodeType(child);
      if (!childType || !allowedChildren.includes(childType)) reject(`${path}.content[${index}]`, `unsupported child ${String(childType)}`);
      assertNode(child, `${path}.content[${index}]`, node.type);
    });
  }
  if (["bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote"].includes(node.type) &&
      Array.isArray(node.content) && node.content.length === 0) reject(path, "empty container");
  if (node.type === "table") {
    const content = node.content;
    if (!Array.isArray(content) || content.length === 0) reject(path, "table has no rows");
    const rows = content as LegacyNode[];
    const headerCells = rows[0]!.content;
    if (!Array.isArray(headerCells) || headerCells.length === 0 || headerCells.some((cell) => nodeType(cell) !== "tableHeader")) {
      reject(path, "table requires a Markdown-compatible header row");
    }
    for (const row of rows.slice(1)) {
      const cells = row.content;
      if (!Array.isArray(cells) || cells.length !== headerCells.length ||
          cells.some((cell) => nodeType(cell) !== "tableCell")) reject(path, "table rows must match the header width");
      for (let index = 0; index < cells.length; index += 1) {
        const headerAttrs = headerCells[index]!.attrs;
        const bodyAttrs = cells[index]!.attrs;
        const headerAlign = typeof headerAttrs === "object" && headerAttrs !== null && "align" in headerAttrs ? headerAttrs.align : undefined;
        const bodyAlign = typeof bodyAttrs === "object" && bodyAttrs !== null && "align" in bodyAttrs ? bodyAttrs.align : undefined;
        if (bodyAlign !== undefined && bodyAlign !== null && bodyAlign !== headerAlign) reject(path, "body table alignment differs from header");
      }
    }
  }
  if (node.type === "tableRow") {
    const content = node.content;
    if (!Array.isArray(content) || content.length === 0 ||
        content.some((cell) => !["tableCell", "tableHeader"].includes(nodeType(cell) ?? ""))) reject(path, "malformed table row");
  }
  if (node.type === "tableCell" || node.type === "tableHeader") {
    const content = node.content;
    if (!Array.isArray(content) || content.length !== 1 || nodeType(content[0]) !== "paragraph") reject(path, "table cell must contain exactly one paragraph");
    const paragraph = content[0] as LegacyNode;
    if (Array.isArray(paragraph.content) && paragraph.content.some((inline) => nodeType(inline) === "hardBreak")) {
      reject(path, "hard breaks inside a table cell have no lossless Markdown representation");
    }
  }
}

function assertLegacyDoc(value: unknown): asserts value is TipTapDoc {
  assertRecord(value, "$");
  if (value.type !== "doc" || !Array.isArray(value.content)) reject("$", "expected a document with a content array");
  assertNode(value, "$");
}

export function serializeLegacyTiptap(source: string, opts?: LegacySerializeOptions): string {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new Error("Malformed legacy TipTap JSON"); }
  assertLegacyDoc(parsed);
  return renderBlock(parsed.content, opts);
}

