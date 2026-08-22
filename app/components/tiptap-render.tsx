import { type ReactNode } from "react";
import type { TipTapDoc } from "../../shared/types";
import { safeHref } from "../../shared/safe-href";
import { cn } from "./ui/cn";

// Root-relative attachment srcs render because cookie auth covers the GET —
// same exact-shape uuid rule as shared/markdown.ts (safeImageSrc). Local copy:
// importing markdown.ts would pull the marked parser into every render surface.
const ATTACHMENT_SRC_RE = /^\/api\/attachments\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function safeImageSrc(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (ATTACHMENT_SRC_RE.test(trimmed)) return trimmed;
  return safeHref(trimmed);
}

// Mention chips link internally only. Both hrefs are CONSTRUCTED from
// validated segments (charset-checked + encodeURIComponent) — never taken
// from doc content verbatim, so javascript:/external values cannot survive.
const MENTION_REF_RE = /^[A-Za-z0-9._~-]+$/;

export function mentionHref(refType: string | null | undefined, refId: unknown, slug: string | undefined): string | null {
  if (!slug || typeof refId !== "string" || !refId || !MENTION_REF_RE.test(refId)) return null;
  const s = encodeURIComponent(slug);
  if (refType === "wiki") return `/${s}/wiki/${encodeURIComponent(refId)}`;
  return `/${s}/board?task=${encodeURIComponent(refId)}`;
}

export function renderMention(
  attrs: Record<string, unknown> | undefined,
  key: string,
  slug: string | undefined,
  variant: "task" | "wiki"
): ReactNode {
  const refType = typeof attrs?.refType === "string" ? attrs.refType : "task";
  const label = typeof attrs?.label === "string" && attrs.label ? attrs.label : typeof attrs?.refId === "string" ? attrs.refId : "";
  if (!label) return null;
  const href = mentionHref(refType, attrs?.refId, slug);
  const inner = refType === "task" ? <span className="task-key">@{label}</span> : `@${label}`;
  if (!href) {
    // No project context or unresolvable ref — chip without a link.
    return <span key={key} className="mention-chip">{inner}</span>;
  }
  void variant;
  return (
    <a key={key} href={href} className="mention-chip">
      {inner}
    </a>
  );
}

export type TTNode = {
  type: string;
  content?: TTNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
};

export const hasText = (nodes: TTNode[]): boolean =>
  nodes.some(
    (n) =>
      (n.type === "text" && !!n.text?.trim()) ||
      (n.content ? hasText(n.content) : false)
  );

export function renderInline(
  nodes: TTNode[] | undefined,
  keyPrefix: string,
  variant: "task" | "wiki" = "task",
  slug?: string
): ReactNode {
  if (!nodes) return null;
  return nodes.map((node, i) => {
    const nodeKey = `${keyPrefix}-${i}`;
    if (node.type === "text") {
      let el: ReactNode = node.text ?? "";
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") el = <strong>{el}</strong>;
        else if (mark.type === "italic") el = <em>{el}</em>;
        else if (mark.type === "code")
          el = variant === "task" ? (
            <code className="td-code">{el}</code>
          ) : (
            <code>{el}</code>
          );
        else if (mark.type === "link") {
          // Scheme allowlist — disallowed hrefs render as plain text, no anchor.
          const href = safeHref(mark.attrs?.href);
          if (href)
            el = (
              <a href={href} target="_blank" rel="noreferrer">
                {el}
              </a>
            );
        }
      }
      return <span key={`${keyPrefix}-t-${node.text ?? ""}`}>{el}</span>;
    }
    if (node.type === "hardBreak") return <br key={nodeKey} />;
    if (node.type === "mention") return renderMention(node.attrs, nodeKey, slug, variant);
    if (node.type === "image") {
      // Inline images (e.g. `text ![alt](src)` inside a paragraph): render
      // only the allowlisted src — disallowed schemes become nothing, never
      // a broken <img> carrying a `javascript:`/`data:` value.
      const src = safeImageSrc(node.attrs?.src);
      if (!src) return null;
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      return <img key={`${nodeKey}-${src}`} src={src} alt={alt} loading="lazy" />;
    }
    return renderNode(node, nodeKey, variant, slug);
  });
}

// Render a node's children as block nodes (used for table cells, whose
// content is paragraph-wrapped per the TipTap schema).
function renderBlocks(
  nodes: TTNode[] | undefined,
  keyPrefix: string,
  variant: "task" | "wiki",
  slug?: string
): ReactNode {
  return (nodes ?? []).map((node, i) => renderNode(node, `${keyPrefix}-b${i}`, variant, slug));
}

export function renderNode(
  node: TTNode,
  key: string,
  variant: "task" | "wiki" = "task",
  slug?: string
): ReactNode {
  const isWiki = variant === "wiki";
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className={isWiki ? undefined : "td-p"}>
          {renderInline(node.content, key, variant, slug)}
        </p>
      );
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const Tag = (level <= 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : level === 4 ? "h4" : "h5") as "h1" | "h2" | "h3" | "h4" | "h5";
      const cls = isWiki
        ? undefined
        : level <= 1
          ? "td-h1"
          : level === 2
            ? "td-h2"
            : "td-h3";
      const headingText = collectText(node);
      const id = slugifyHeading(headingText);
      return (
        <Tag key={key} className={cls} id={id}>
          {renderInline(node.content, key, variant, slug)}
        </Tag>
      );
    }
    case "bulletList":
      return (
        <ul key={key} className={isWiki ? undefined : "td-ul"}>
          {renderInline(node.content, key, variant, slug)}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className={isWiki ? undefined : "td-ol"}>
          {renderInline(node.content, key, variant, slug)}
        </ol>
      );
    case "listItem":
      return <li key={key}>{renderInline(node.content, key, variant, slug)}</li>;
    case "taskList":
      return (
        <ul key={key} className="checklist">
          {renderInline(node.content, key, variant, slug)}
        </ul>
      );
    case "taskItem": {
      const checked = node.attrs?.checked === true;
      return (
        <li key={key} className={cn(checked && "checked")}>
          <span className={cn("checkbox", checked && "checked")} />
          <span>{renderInline(node.content, key, variant, slug)}</span>
        </li>
      );
    }
    case "codeBlock":
      return (
        <pre key={key} className={isWiki ? undefined : "td-pre"}>
          <code>{collectText(node)}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key} className={isWiki ? undefined : "td-quote"}>
          {renderInline(node.content, key, variant, slug)}
        </blockquote>
      );
    case "horizontalRule":
      return <hr key={key} className={isWiki ? undefined : "td-hr"} />;
    case "table":
      return (
        <div key={key} className={isWiki ? "table-wrap" : "td-table-wrap"}>
          <table className={isWiki ? undefined : "td-table"}>
            {renderInline(node.content, key, variant, slug)}
          </table>
        </div>
      );
    case "tableRow":
      return <tr key={key}>{renderInline(node.content, key, variant, slug)}</tr>;
    case "tableHeader": {
      const align = typeof node.attrs?.align === "string" ? (node.attrs.align as "left" | "center" | "right") : undefined;
      return (
        <th key={key} align={align}>
          {renderBlocks(node.content, key, variant, slug)}
        </th>
      );
    }
    case "tableCell": {
      const align = typeof node.attrs?.align === "string" ? (node.attrs.align as "left" | "center" | "right") : undefined;
      return (
        <td key={key} align={align}>
          {renderBlocks(node.content, key, variant, slug)}
        </td>
      );
    }
    case "image": {
      // Block-level image (top-level node in a doc, or a list/quote child).
      // Same allowlist as inline images — no scheme, no render.
      const src = safeImageSrc(node.attrs?.src);
      if (!src) return null;
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      return (
        <img
          key={key}
          src={src}
          alt={alt}
          loading="lazy"
          className={isWiki ? undefined : "td-img"}
        />
      );
    }
    default:
      return node.content ? <div key={key}>{renderInline(node.content, key, variant, slug)}</div> : null;
  }
}

export function collectText(node: TTNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(collectText).join("");
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface HeadingOutline {
  level: number;
  text: string;
  id: string;
}

export function extractHeadings(node: TTNode): HeadingOutline[] {
  const results: HeadingOutline[] = [];
  const seen = new Map<string, number>();
  function walk(n: TTNode) {
    if (n.type === "heading") {
      const level = Number(n.attrs?.level ?? 1);
      const text = collectText(n);
      let id = slugifyHeading(text);
      const count = seen.get(id) ?? 0;
      if (count > 0) {
        id = `${id}-${count + 1}`;
      }
      seen.set(id, count + 1);
      results.push({ level, text, id });
    }
    for (const child of n.content ?? []) {
      walk(child);
    }
  }
  walk(node);
  return results;
}

export function renderDoc(doc: TipTapDoc, variant: "task" | "wiki" = "task", slug?: string): ReactNode {
  const nodes = doc.content as TTNode[];
  if (!hasText(nodes)) {
    return variant === "task" ? (
      <p className="td-p italic text-lx-text-muted">Add a description...</p>
    ) : (
      <p className="italic text-lx-text-muted">This page is empty.</p>
    );
  }
  const visibleNodes = nodes.filter((node) => {
    if (node.type === "heading") return hasText(node.content ?? []);
    return true;
  });
  return visibleNodes.map((node, i) => renderNode(node, `n${i}`, variant, slug));
}
