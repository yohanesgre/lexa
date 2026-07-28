import { type ReactNode } from "react";
import type { TipTapDoc } from "../../shared/types";
import { cn } from "./ui/cn";

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
  variant: "task" | "wiki" = "task"
): ReactNode {
  if (!nodes) return null;
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
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
        else if (mark.type === "link")
          el = (
            <a href={String(mark.attrs?.href ?? "#")} target="_blank" rel="noreferrer">
              {el}
            </a>
          );
      }
      return <span key={key}>{el}</span>;
    }
    if (node.type === "hardBreak") return <br key={key} />;
    return renderNode(node, key, variant);
  });
}

export function renderNode(
  node: TTNode,
  key: string,
  variant: "task" | "wiki" = "task"
): ReactNode {
  const isWiki = variant === "wiki";
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className={isWiki ? undefined : "td-p"}>
          {renderInline(node.content, key, variant)}
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
          {renderInline(node.content, key, variant)}
        </Tag>
      );
    }
    case "bulletList":
      return (
        <ul key={key} className={isWiki ? undefined : "td-ul"}>
          {renderInline(node.content, key, variant)}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className={isWiki ? undefined : "td-ol"}>
          {renderInline(node.content, key, variant)}
        </ol>
      );
    case "listItem":
      return <li key={key}>{renderInline(node.content, key, variant)}</li>;
    case "taskList":
      return (
        <ul key={key} className="checklist">
          {renderInline(node.content, key, variant)}
        </ul>
      );
    case "taskItem": {
      const checked = node.attrs?.checked === true;
      return (
        <li key={key} className={cn(checked && "checked")}>
          <span className={cn("checkbox", checked && "checked")} />
          <span>{renderInline(node.content, key, variant)}</span>
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
          {renderInline(node.content, key, variant)}
        </blockquote>
      );
    case "horizontalRule":
      return <hr key={key} className={isWiki ? undefined : "td-hr"} />;
    default:
      return node.content ? <div key={key}>{renderInline(node.content, key, variant)}</div> : null;
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

export function renderDoc(doc: TipTapDoc, variant: "task" | "wiki" = "task"): ReactNode {
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
  return visibleNodes.map((node, i) => renderNode(node, `n${i}`, variant));
}
