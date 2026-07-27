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
      const Tag = (level <= 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
      const cls = isWiki
        ? undefined
        : level <= 1
          ? "td-h1"
          : level === 2
            ? "td-h2"
            : "td-h3";
      return (
        <Tag key={key} className={cls}>
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

export function renderDoc(doc: TipTapDoc, variant: "task" | "wiki" = "task"): ReactNode {
  const nodes = doc.content as TTNode[];
  if (!hasText(nodes)) {
    return variant === "task" ? (
      <p className="td-p italic text-lx-text-muted">Add a description...</p>
    ) : (
      <p className="italic text-lx-text-muted">This page is empty.</p>
    );
  }
  return nodes.map((node, i) => renderNode(node, `n${i}`, variant));
}
