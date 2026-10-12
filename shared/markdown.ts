import { type Token, type Tokens, marked } from "marked";
import type { TipTapDoc, TipTapNode, TipTapMark, JSONValue } from "./types";
import { safeHref } from "./safe-href";

function rawToken(t: Token): string {
  if ("raw" in t) {
    const raw = (t as { raw: string }).raw;
    return typeof raw === "string" ? raw : String(raw);
  }
  return JSON.stringify(t);
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

// Same charset the renderers use for a mention refId — a mention re-derived
// from a link must not carry anything a mention node can't render.
const MENTION_REF_RE = /^[A-Za-z0-9._~-]+$/;

export interface MarkdownToDocOptions {
  // Editor-side mention recovery. The Markdown pane derives its text with
  // `docToMarkdown`, which writes a document-route mention as a deep link
  // (`{base}/{slug}/tasks?task=…` | `{base}/{slug}/wiki/…`); with this option a
  // link matching that exact shape is re-derived as a mention node instead of
  // degrading to a plain link. Off by default: the GitHub pull path must NOT
  // re-create mentions, because echo suppression needs the next push to
  // reproduce the pulled body byte-for-byte and GitHub may rewrite URLs.
  mentions?: { projectSlug: string; baseUrl?: string };
}

function mentionFromHref(href: string, label: string, opts?: MarkdownToDocOptions): TipTapNode | null {
  const mentions = opts?.mentions;
  if (!mentions?.projectSlug) return null;
  const base = `${(mentions.baseUrl ?? "").replace(/\/+$/, "")}/${mentions.projectSlug}`;
  const taskPrefix = `${base}/tasks?task=`;
  const wikiPrefix = `${base}/wiki/`;
  let refType: "task" | "wiki";
  let raw: string;
  if (href.startsWith(taskPrefix)) {
    refType = "task";
    raw = href.slice(taskPrefix.length);
  } else if (href.startsWith(wikiPrefix)) {
    refType = "wiki";
    raw = href.slice(wikiPrefix.length);
  } else {
    return null;
  }
  let refId: string;
  try {
    refId = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const trimmed = label.trim();
  if (!refId || !MENTION_REF_RE.test(refId) || !trimmed) return null;
  return { type: "mention", attrs: { refType, refId, label: trimmed } };
}

function flattenInline(tokens: Token[], parentMarks: TipTapMark[] = [], opts?: MarkdownToDocOptions): TipTapNode[] {
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
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "bold" }], opts));
        break;
      }
      case "em": {
        flush();
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "italic" }], opts));
        break;
      }
      case "del": {
        flush();
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "strike" }], opts));
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
        // Pulled mention deep links (${base}/{slug}/tasks?task=… |
        // ${base}/{slug}/wiki/…) deliberately stay PLAIN LINKS — they are NOT
        // mapped back to mention nodes. Echo suppression requires the next
        // push to reproduce pushed_body byte-for-byte after normalization;
        // GitHub may rewrite URLs (scheme, trailing slash, encoding), so any
        // mention re-mapping risks permanent outOfSync churn. A plain link is
        // lossless for echo and still navigates.
        // The editor's Markdown pane opts in explicitly (`opts.mentions`), where
        // the text came from docToMarkdown on this same document and no echo is
        // involved.
        const mention = mentionFromHref(t.href, t.text ?? "", opts);
        if (mention) {
          out.push(mention);
          break;
        }
        const href = safeHref(t.href);
        const attrs: Record<string, JSONValue> = {};
        if (href) attrs.href = href;
        if (t.title) attrs.title = t.title;
        out.push(...flattenInline(t.tokens ?? [], [...parentMarks, { type: "link", attrs }], opts));
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
        const attrs: Record<string, JSONValue> = { src };
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

function mapBlock(siblings: Token[], opts?: MarkdownToDocOptions): TipTapNode[] {
  const out: TipTapNode[] = [];
  for (const t of siblings) {
    const node = mapOne(t, opts);
    if (node) out.push(node);
  }
  return out;
}

function mapOne(t: Token, opts?: MarkdownToDocOptions): TipTapNode | null {
  switch (t.type) {
    case "heading": {
      const content = flattenInline(t.tokens ?? [], [], opts);
      return { type: "heading", attrs: { level: t.depth }, content: content.length ? content : [{ type: "text", text: "" }] };
    }
    case "paragraph":
    case "text": {
      const content = flattenInline(t.tokens ?? [], [], opts);
      if (!content.length && t.text) content.push({ type: "text", text: t.text });
      return content.length ? { type: "paragraph", content } : null;
    }
    case "blockquote": {
      const content = mapBlock(t.tokens ?? [], opts);
      return content.length ? { type: "blockquote", content } : null;
    }
    case "code": {
      return { type: "codeBlock", attrs: t.lang ? { language: t.lang } : undefined, content: [{ type: "text", text: t.text }] };
    }
    case "list": {
      const mapped = t.items.map((item: Tokens.ListItem) => mapListItem(item, opts));
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
          const content = flattenInline(cell.tokens ?? [], [], opts);
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

function mapListItem(item: Tokens.ListItem, opts?: MarkdownToDocOptions): TipTapNode | null {
  const children = mapBlock(item.tokens, opts);
  if (children.length === 0) return null;
  return {
    type: item.task ? "taskItem" : "listItem",
    attrs: item.task ? { checked: item.checked ?? false } : undefined,
    content: children,
  };
}

export function markdownToDoc(md: string, opts?: MarkdownToDocOptions): TipTapDoc {
  try {
    const tokens: Token[] = [...marked.lexer(md)];
    return { type: "doc", content: mapBlock(tokens, opts) };
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
      const m = marks[i];
      if (!m) continue;
      result = applyMark(m, result);
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
  if (node.type === "mention") {
    // Mention nodes are LINKS only — never context injection. With
    // baseUrl + projectSlug they render as absolute deep links (GitHub-safe);
    // without them the bare label is emitted (no broken relative href).
    const attrs = node.attrs ?? {};
    const refId = typeof attrs.refId === "string" ? attrs.refId.trim() : "";
    const label = typeof attrs.label === "string" ? attrs.label.trim() : "";
    if (!refId || !label) return "";
    // Only task/wiki mentions have a document route. Entity mentions
    // (milestone/swimlane/column) carry no linkable view, so the GitHub export
    // emits the bare label rather than a dead board/wiki deep link.
    if (opts?.baseUrl !== undefined && opts?.projectSlug && (attrs.refType === "task" || attrs.refType === "wiki")) {
      const base = `${opts.baseUrl.replace(/\/+$/, "")}/${opts.projectSlug}`;
      const href =
        attrs.refType === "wiki"
          ? `${base}/wiki/${encodeURIComponent(refId)}`
          : `${base}/tasks?task=${encodeURIComponent(refId)}`;
      return `[${label}](${href})`;
    }
    return label;
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

function applyMark(mark: TipTapMark, inner: string): string {
  switch (mark.type) {
    case "bold": return wrapTrimmed(inner, "**", "**");
    case "italic": return wrapTrimmed(inner, "*", "*");
    case "strike": return wrapTrimmed(inner, "~~", "~~");
    case "code": return wrapTrimmed(inner, "`", "`");
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

// Every line of a continuation block is indented, not just its first: a fence
// whose contents stay at column 0 closes the list item at the fence, so a code
// block inside a list item came back as an empty block plus stray top-level
// nodes.
function indentLines(text: string, pad: string): string {
  return text.split("\n").map((line) => (line ? pad + line : line)).join("\n");
}

function renderListItem(item: TipTapNode, marker: string, opts?: DocToMarkdownOptions): string {
  const blocks = renderBlock(item.content ?? [], opts).split("\n\n");
  return blocks
    .map((b, i) => (i === 0 ? `${marker} ${b}` : indentLines(b, "  ")))
    .join("\n\n");
}

function renderTaskItem(item: TipTapNode, opts?: DocToMarkdownOptions): string {
  const checked = Boolean(item.attrs?.checked) ? "x" : " ";
  const blocks = renderBlock(item.content ?? [], opts).split("\n\n");
  return blocks
    .map((b, i) => (i === 0 ? `- [${checked}] ${b}` : indentLines(b, "  ")))
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
  // Project slug — required together with baseUrl to build mention deep links
  // (${baseUrl}/{slug}/tasks?task={id} | ${baseUrl}/{slug}/wiki/{slug}).
  projectSlug?: string;
}

export function docToMarkdown(doc: TipTapDoc, opts?: DocToMarkdownOptions): string {
  try {
    return renderBlock(doc.content, opts);
  } catch {
    return "";
  }
}

// Marks with no Markdown syntax. `applyMark` passes them through unwrapped, so
// a Markdown edit would drop them.
const NON_MARKDOWN_MARKS: Record<string, true> = { highlight: true, underline: true };

// The editor's Markdown pane derives its text from the document and converts an
// edit back with markdownToDoc, which can only reproduce what Markdown can
// write. The constructs below have no Markdown syntax (a highlight or underline
// run) or no document route (a milestone/swimlane/column mention, which renders
// as its bare label), so they are carried over from the previous document by
// their text: a decorated run keeps its decoration while its text survives the
// edit, and a label mention keeps its node while its label survives. A restored
// run is split out of the text node it now sits in, so surrounding edits do not
// break the match, and each entry is consumed once — repeated labels map to
// repeated nodes. Nothing is dropped silently: a construct is gone only when
// its text is gone too. The stored TipTap JSON stays the source of truth; the
// markdown text is a projection of it.
type Carried = { text: string; remaining: number } & ({ markType: string } | { node: TipTapNode });

export function carryNonMarkdownContent(prev: TipTapDoc, next: TipTapDoc): TipTapDoc {
  const carried: Carried[] = [];
  const remember = (entry: { text: string } & ({ markType: string } | { node: TipTapNode })): void => {
    const same = carried.find(
      (e) =>
        e.text === entry.text &&
        ("markType" in e && "markType" in entry
          ? e.markType === entry.markType
          : "node" in e && "node" in entry)
    );
    if (same) same.remaining += 1;
    else carried.push({ ...entry, remaining: 1 });
  };
  function collect(nodes: TipTapNode[]): void {
    for (const node of nodes) {
      if (node.type === "text" && node.text) {
        for (const mark of node.marks ?? []) {
          if (NON_MARKDOWN_MARKS[mark.type]) remember({ text: node.text, markType: mark.type });
        }
      } else if (node.type === "mention") {
        const label = typeof node.attrs?.label === "string" ? node.attrs.label : "";
        const refType = typeof node.attrs?.refType === "string" ? node.attrs.refType : "";
        // Document-route mentions come back from their deep link (markdownToDoc
        // with `mentions`); carrying them by label too would fight that.
        if (label && refType !== "task" && refType !== "wiki") remember({ text: label, node });
      }
      if (node.content) collect(node.content);
    }
  }
  collect(prev.content);
  if (carried.length === 0) return next;

  let changed = false;
  function splitFor(entry: Carried, node: TipTapNode): TipTapNode[] | null {
    const value = node.text ?? "";
    const index = value.indexOf(entry.text);
    if (index === -1) return null;
    const before = value.slice(0, index);
    const after = value.slice(index + entry.text.length);
    const middle: TipTapNode =
      "markType" in entry
        ? { ...node, text: entry.text, marks: [...(node.marks ?? []), { type: entry.markType }] }
        : { ...entry.node };
    const pieces: TipTapNode[] = [];
    if (before) pieces.push({ ...node, text: before });
    pieces.push(middle);
    if (after) pieces.push({ ...node, text: after });
    return pieces;
  }
  function carryNode(node: TipTapNode): TipTapNode[] {
    if (node.type === "text" && node.text) {
      for (const entry of carried) {
        if (entry.remaining <= 0) continue;
        if ("markType" in entry && (node.marks ?? []).some((m) => m.type === entry.markType)) continue;
        const pieces = splitFor(entry, node);
        if (!pieces) continue;
        entry.remaining -= 1;
        changed = true;
        return pieces;
      }
      return [node];
    }
    if (!node.content) return [node];
    const content = walk(node.content);
    if (content === node.content) return [node];
    changed = true;
    return [{ ...node, content }];
  }
  function walk(nodes: TipTapNode[]): TipTapNode[] {
    let out: TipTapNode[] = nodes;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const replacement = carryNode(node);
      if (out === nodes) {
        if (replacement.length === 1 && replacement[0] === node) continue;
        out = nodes.slice(0, i);
      }
      out.push(...replacement);
    }
    return out;
  }

  const content = walk(next.content);
  return changed ? { ...next, content } : next;
}

// Echo-comparison normalization for GitHub content sync: GitHub normalizes
// boundary whitespace (trailing newline, CRLF) when it stores an issue body,
// so a raw compare would flag our own push as an external edit. Trim + LF only
// at the string edges — the Markdown structure itself is never touched.
export function normalizeMarkdownForEcho(text: string | null): string {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").trim();
}
