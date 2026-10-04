import type { TipTapDoc } from "./types";

interface Node {
  type: string;
  content?: Node[];
  text?: string;
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "codeBlock",
  "blockquote",
  "horizontalRule",
  "bulletList",
  "orderedList",
]);

// Mirrors the server's `isEmptyDoc` (server/services/task.service.ts): a doc is
// empty when it holds no text and no meaningful content nodes (image,
// horizontalRule, table). Container nodes (paragraph, heading, blockquote,
// list) always recurse — a paragraph of whitespace is empty.
export function isEmptyDoc(doc: TipTapDoc): boolean {
  if (!doc || typeof doc !== "object") return true;
  const hasContent = (node: Record<string, unknown>): boolean => {
    const children = node.content as Record<string, unknown>[] | undefined;
    if (node.type === "text") {
      return (typeof node.text === "string" ? node.text : "").trim().length > 0;
    }
    if (children && children.length > 0) {
      return children.some(hasContent);
    }
    return node.type !== "paragraph" && node.type !== "doc";
  };
  return !hasContent(doc as unknown as Record<string, unknown>);
}

export function extractText(doc: TipTapDoc): string {
  try {
    if (!doc || !Array.isArray(doc.content)) return "";
    return processNodes(doc.content);
  } catch {
    return "";
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof (value as { type: unknown }).type === "string";
}

function processNodes(nodes: unknown[]): string {
  const blocks: string[] = [];
  for (const raw of nodes) {
    if (!isNode(raw)) continue;
    const node = raw;
    if (BLOCK_TYPES.has(node.type)) {
      blocks.push(extractBlock(node));
    } else {
      const text = extractInline(node);
      if (blocks.length === 0) {
        blocks.push(text);
      } else {
        const lastIdx = blocks.length - 1;
        const last = blocks[lastIdx];
        if (last !== undefined) blocks[lastIdx] = last + text;
        else blocks.push(text);
      }
    }
  }
  return blocks.filter((b) => b !== "").join("\n");
}

function extractBlock(node: Node): string {
  if (Array.isArray(node.content)) {
    return processNodes(node.content);
  }
  return "";
}

function extractInline(node: Node): string {
  if (node.type === "text" && typeof node.text === "string") {
    return node.text;
  }
  if (Array.isArray(node.content)) {
    return processNodes(node.content);
  }
  return "";
}
