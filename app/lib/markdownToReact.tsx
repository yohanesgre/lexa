import { headingCollectionExtension } from "@tanstack/markdown/extensions/headings";
import { Children, isValidElement, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { parseMarkdown, type MarkdownExtension, type RenderOptions } from "@tanstack/markdown";
import { renderMarkdownReact, type MarkdownComponents } from "@tanstack/markdown/react";
import hljs from "highlight.js/lib/common";
import { safeHref, safeRelativeHref } from "../../shared/safe-href";
import { normalizeTaskListMarkersForParsing, safeImageSrc } from "../../shared/markdown";

export type MarkdownSurface = "chat" | "task" | "document" | "comment" | "share";

export interface ShareRenderContext {
  token: string;
  /** Wiki page slug -> page id for pages inside the shared subtree. */
  pageIds: Map<string, string>;
}

export const SHARE_OUTSIDE_SUBTREE = "__outside__";

export interface MarkdownRenderOptions {
  renderText?: ((text: string) => ReactNode) | undefined;
  surface?: MarkdownSurface | undefined;
  share?: ShareRenderContext | undefined;
  headingIds?: ((text: string, index: number) => string) | undefined;
  headingAnchors?: boolean | RenderOptions["headingAnchors"];
}

export function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

const ATTACHMENT_SRC_RE = /^\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function sharePageHref(share: ShareRenderContext, pageId: string): string {
  return `/share/${encodeURIComponent(share.token)}?page=${encodeURIComponent(pageId)}`;
}

function resolveShareHref(href: string, share: ShareRenderContext): string {
  if (!href.startsWith("/") || href.startsWith("/share/")) return href;
  const segment = /\/wiki\/([^/?#]+)/.exec(href)?.[1];
  if (segment !== undefined) {
    let slug = segment;
    try {
      slug = decodeURIComponent(segment);
    } catch {
      // Malformed escapes cannot match a validated page slug.
    }
    const pageId = share.pageIds.get(slug);
    if (pageId) return sharePageHref(share, pageId);
  }
  return sharePageHref(share, SHARE_OUTSIDE_SUBTREE);
}

function transformUrl(url: string, kind: "link" | "image", surface: MarkdownSurface, share?: ShareRenderContext): string | null {
  if (kind === "image") {
    if (surface === "chat" || surface === "comment") return null;
    const safe = safeImageSrc(url);
    if (!safe) return null;
    const attachmentId = share && ATTACHMENT_SRC_RE.exec(safe)?.[1];
    return attachmentId ? `/api/share/${encodeURIComponent(share.token)}/attachments/${attachmentId}` : safe;
  }
  const safe = surface === "chat" || surface === "comment" ? safeHref(url) : safeRelativeHref(url);
  return safe && surface === "share" && share ? resolveShareHref(safe, share) : safe;
}

function textComponent(renderText?: (text: string) => ReactNode) {
  return (props: ComponentPropsWithoutRef<"span"> & { "data-markdown-text"?: string }): ReactNode => {
    const text = props["data-markdown-text"];
    if (renderText && typeof text === "string") return renderText(text);
    return <span>{props.children}</span>;
  };
}

function isCheckbox(node: ReactNode): node is ReactElement<ComponentPropsWithoutRef<"input">> {
  return isValidElement<ComponentPropsWithoutRef<"input">>(node) && node.type === "input" && node.props.type === "checkbox";
}

function renderDocumentList({ children, className, ...props }: ComponentPropsWithoutRef<"ul">, proseClass?: string) {
  const items = Children.toArray(children);
  const taskList = items.length > 0 && items.every((item) =>
    isValidElement<{ children?: ReactNode }>(item) && isCheckbox(Children.toArray(item.props.children)[0]));
  return <ul {...props} className={taskList ? "checklist" : proseClass ?? className}>{children}</ul>;
}

function renderDocumentListItem({ children, ...props }: ComponentPropsWithoutRef<"li">) {
  const parts = Children.toArray(children);
  const checkbox = parts[0];
  if (!isCheckbox(checkbox)) return <li {...props}>{children}</li>;
  const checked = checkbox.props.checked === true;
  return <li {...props} className={checked ? "checked" : undefined}>
    <span className={checked ? "checkbox checked" : "checkbox"} />
    <div className="min-w-0">{parts.slice(parts[1] === " " ? 2 : 1)}</div>
  </li>;
}

const taskHeadingFour = (props: ComponentPropsWithoutRef<"h4">) => <h4 {...props} className="td-h3" />;
const wikiHeadingFour = (props: ComponentPropsWithoutRef<"h4">) => <h4 {...props} tabIndex={-1} />;

const taskComponents: MarkdownComponents = {
  p: (props) => <p {...props} className="td-p" />,
  h1: (props) => <h1 {...props} className="td-h1" />,
  h2: (props) => <h2 {...props} className="td-h2" />,
  h3: (props) => <h3 {...props} className="td-h3" />,
  h4: taskHeadingFour,
  h5: taskHeadingFour,
  h6: taskHeadingFour,
  ul: (props) => renderDocumentList(props, "td-ul"),
  ol: (props) => <ol {...props} className="td-ol" />,
  li: renderDocumentListItem,
  code: ({ className, ...props }) => <code {...props} className={`td-code${className ? ` ${className}` : ""}`} />,
  pre: (props) => <pre {...props} className="td-pre" />,
  blockquote: (props) => <blockquote {...props} className="td-quote" />,
  hr: (props) => <hr {...props} className="td-hr" />,
  table: (props) => <div className="td-table-wrap"><table {...props} className="td-table" /></div>,
};

const wikiComponents: MarkdownComponents = {
  h1: (props) => <h1 {...props} tabIndex={-1} />,
  h2: (props) => <h2 {...props} tabIndex={-1} />,
  h3: (props) => <h3 {...props} tabIndex={-1} />,
  h4: wikiHeadingFour,
  h5: wikiHeadingFour,
  h6: wikiHeadingFour,
  ul: (props) => renderDocumentList(props),
  li: renderDocumentListItem,
  table: (props) => <div className="table-wrap"><table {...props} /></div>,
};

const chatComponents: MarkdownComponents = {
  h5: "h4",
  h6: "h4",
  code: ({ className, ...props }) => <code {...props} className={`hljs-theme${className ? ` ${className}` : ""}`} />,
};

export function markdownToReact(source: string, options: MarkdownRenderOptions = {}): ReactNode {
  const surface = options.surface ?? "chat";
  const textExtension: MarkdownExtension | undefined = options.renderText ? {
    name: "render-plain-markdown-text",
    transformInline(nodes) {
      return nodes.map((node) => node.type === "text"
        ? {
            type: "inlineComponent" as const,
            name: "render-text",
            tagName: "span",
            properties: { "data-markdown-text": node.value },
            attributes: {},
            children: [],
          }
        : node);
    },
  } : undefined;
  const components: MarkdownComponents = {
    ...(surface === "task" || surface === "comment" ? taskComponents : surface === "chat" ? chatComponents : wikiComponents),
    a: ({ href, children, ...props }) => href
      ? <a {...props} href={href} target={/^https?:/i.test(href) ? "_blank" : undefined} rel={/^https?:/i.test(href) ? "noopener noreferrer" : undefined}>{children}</a>
      : <span>{children}</span>,
    img: ({ src, alt }) => surface === "comment"
      ? null
      : surface === "chat" || !src
        ? <>{alt}</>
        : <img src={src} alt={alt ?? ""} loading="lazy" className={surface === "task" ? "td-img" : undefined} />,
    span: textComponent(options.renderText),
  };
  return renderMarkdownReact(normalizeTaskListMarkersForParsing(source), {
    allowHtml: false,
    frontmatter: false,
    urlTransform: (url, kind) => transformUrl(url, kind, surface, options.share),
    ...(options.headingIds && { headingIds: options.headingIds }),
    ...(options.headingAnchors !== undefined && { headingAnchors: options.headingAnchors }),
    ...(surface === "chat" && { highlighter: highlightCode }),
    extensions: textExtension ? [textExtension] : [],
    components,
  });
}

export function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface HeadingOutline {
  level: number;
  text: string;
  id: string;
}

export interface HeadingPlan {
  headings: HeadingOutline[];
  createHeadingIds: () => (text: string, index: number) => string;
}

function uniqueHeadingId(base: string, used: Set<string>): string {
  const root = base || "section";
  let id = root;
  let suffix = 1;
  while (used.has(id)) id = `${root}-${++suffix}`;
  used.add(id);
  return id;
}

export function planHeadings(source: string, reserved: Iterable<string> = []): HeadingPlan {
  const used = new Set(reserved);
  const ids = new Map<number, string>();
  const document = parseMarkdown(normalizeTaskListMarkersForParsing(source), {
    allowHtml: false,
    frontmatter: false,
    headingIds: (text, index) => {
      const id = uniqueHeadingId(slugifyHeading(text), used);
      ids.set(index, id);
      return id;
    },
    extensions: [headingCollectionExtension()],
  });
  return {
    headings: (document.headings ?? []).map((heading) => ({ level: Math.min(heading.level, 4), text: heading.text, id: heading.id })),
    // The native parser indexes headings by source line, not heading ordinal.
    createHeadingIds: () => (_text, index) => ids.get(index)!,
  };
}

export const BLOCK_TAGS: Readonly<Record<string, true>> = {
  p: true, h1: true, h2: true, h3: true, h4: true, li: true, blockquote: true, td: true, th: true,
};
