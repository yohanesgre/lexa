import { type ReactNode } from "react";
import type { TipTapDoc } from "../../shared/types";
import { safeHref, safeRelativeHref } from "../../shared/safe-href";
import { withKeys } from "../lib/withKeys";
import { cn } from "./ui/cn";

// Root-relative attachment srcs render because cookie auth covers the GET —
// same exact-shape uuid rule as shared/markdown.ts (safeImageSrc). Local copy:
// importing markdown.ts would pull the marked parser into every render surface.
const ATTACHMENT_SRC_RE = /^\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function safeImageSrc(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (ATTACHMENT_SRC_RE.test(trimmed)) return trimmed;
  return safeHref(trimmed);
}

// Public share render context (wiki-shared.html): the token is the credential
// and only pages inside the shared subtree may be reached. Internal links that
// leave the subtree resolve to the dead-link Variant B (an unknown `page` id)
// instead of rendering into the app; embedded images re-serve read-only from
// the share attachment endpoint.
export interface ShareRenderContext {
  token: string;
  /** wiki page slug -> page id for pages inside the shared subtree */
  pageIds: Map<string, string>;
}

export const SHARE_OUTSIDE_SUBTREE = "__outside__";

function sharePageHref(share: ShareRenderContext, pageId: string): string {
  return `/share/${encodeURIComponent(share.token)}?page=${encodeURIComponent(pageId)}`;
}

function resolveShareHref(href: string, share: ShareRenderContext): string {
  if (!href.startsWith("/")) return href;
  if (href.startsWith("/share/")) return href;
  const wikiRef = /\/wiki\/([^/?#]+)/.exec(href);
  const rawSegment = wikiRef?.[1];
  if (rawSegment !== undefined) {
    let segment = rawSegment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      // keep the raw segment — a malformed escape still matches on raw slug
    }
    const id = share.pageIds.get(segment);
    if (id) return sharePageHref(share, id);
  }
  return sharePageHref(share, SHARE_OUTSIDE_SUBTREE);
}

function resolveImageSrc(src: unknown, share?: ShareRenderContext): string | null {
  const safe = safeImageSrc(src);
  if (!safe || !share) return safe;
  const attachmentId = ATTACHMENT_SRC_RE.exec(safe)?.[1];
  if (attachmentId) {
    return `/api/share/${encodeURIComponent(share.token)}/attachments/${attachmentId}`;
  }
  return safe;
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
  text?: string | undefined;
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
  slug?: string,
  share?: ShareRenderContext
): ReactNode {
  if (!nodes) return null;
  return withKeys(nodes, (node) => `${keyPrefix}/${node.type === "text" ? `t:${node.text ?? ""}` : node.type}`).map(({ item: node, key: nodeKey }) => {
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
          // Same-origin relative links are only accepted on the public share
          // path, where they resolve inside the shared subtree (or Variant B);
          // the app path keeps dropping them (unchanged).
          const safe = share ? safeRelativeHref(mark.attrs?.href) : safeHref(mark.attrs?.href);
          const href = safe && share ? resolveShareHref(safe, share) : safe;
          if (href)
            el = (
              <a href={href} target="_blank" rel="noreferrer">
                {el}
              </a>
            );
        }
      }
      return <span key={nodeKey}>{el}</span>;
    }
    if (node.type === "hardBreak") return <br key={nodeKey} />;
    if (node.type === "mention") return renderMention(node.attrs, nodeKey, slug, variant);
    if (node.type === "image") {
      // Inline images (e.g. `text ![alt](src)` inside a paragraph): render
      // only the allowlisted src — disallowed schemes become nothing, never
      // a broken <img> carrying a `javascript:`/`data:` value.
      const src = resolveImageSrc(node.attrs?.src, share);
      if (!src) return null;
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      return <img key={nodeKey} src={src} alt={alt} loading="lazy" />;
    }
    return renderNode(node, nodeKey, variant, slug, share);
  });
}

// Render a node's children as block nodes (used for table cells, whose
// content is paragraph-wrapped per the TipTap schema).
function renderBlocks(
  nodes: TTNode[] | undefined,
  keyPrefix: string,
  variant: "task" | "wiki",
  slug?: string,
  share?: ShareRenderContext
): ReactNode {
  return withKeys(nodes ?? [], (node) => node.type).map(({ item: node, key }) =>
    renderNode(node, `${keyPrefix}/b/${key}`, variant, slug, share)
  );
}

export function renderNode(
  node: TTNode,
  key: string,
  variant: "task" | "wiki" = "task",
  slug?: string,
  share?: ShareRenderContext
): ReactNode {
  const isWiki = variant === "wiki";
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className={isWiki ? undefined : "td-p"}>
          {renderInline(node.content, key, variant, slug, share)}
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
          {renderInline(node.content, key, variant, slug, share)}
        </Tag>
      );
    }
    case "bulletList":
      return (
        <ul key={key} className={isWiki ? undefined : "td-ul"}>
          {renderInline(node.content, key, variant, slug, share)}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className={isWiki ? undefined : "td-ol"}>
          {renderInline(node.content, key, variant, slug, share)}
        </ol>
      );
    case "listItem":
      return <li key={key}>{renderInline(node.content, key, variant, slug, share)}</li>;
    case "taskList":
      return (
        <ul key={key} className="checklist">
          {renderInline(node.content, key, variant, slug, share)}
        </ul>
      );
    case "taskItem": {
      const checked = node.attrs?.checked === true;
      return (
        <li key={key} className={cn(checked && "checked")}>
          <span className={cn("checkbox", checked && "checked")} />
          <span>{renderInline(node.content, key, variant, slug, share)}</span>
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
          {renderInline(node.content, key, variant, slug, share)}
        </blockquote>
      );
    case "horizontalRule":
      return <hr key={key} className={isWiki ? undefined : "td-hr"} />;
    case "table":
      return (
        <div key={key} className={isWiki ? "table-wrap" : "td-table-wrap"}>
          <table className={isWiki ? undefined : "td-table"}>
            {renderInline(node.content, key, variant, slug, share)}
          </table>
        </div>
      );
    case "tableRow":
      return <tr key={key}>{renderInline(node.content, key, variant, slug, share)}</tr>;
    case "tableHeader": {
      const align = typeof node.attrs?.align === "string" ? (node.attrs.align as "left" | "center" | "right") : undefined;
      return (
        <th key={key} align={align}>
          {renderBlocks(node.content, key, variant, slug, share)}
        </th>
      );
    }
    case "tableCell": {
      const align = typeof node.attrs?.align === "string" ? (node.attrs.align as "left" | "center" | "right") : undefined;
      return (
        <td key={key} align={align}>
          {renderBlocks(node.content, key, variant, slug, share)}
        </td>
      );
    }
    case "image": {
      // Block-level image (top-level node in a doc, or a list/quote child).
      // Same allowlist as inline images — no scheme, no render.
      const src = resolveImageSrc(node.attrs?.src, share);
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
      return node.content ? <div key={key}>{renderInline(node.content, key, variant, slug, share)}</div> : null;
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

export function renderDoc(doc: TipTapDoc, variant: "task" | "wiki" = "task", slug?: string, share?: ShareRenderContext): ReactNode {
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
  return withKeys(visibleNodes, (node) => node.type).map(({ item: node, key }) =>
    renderNode(node, `n/${key}`, variant, slug, share)
  );
}
