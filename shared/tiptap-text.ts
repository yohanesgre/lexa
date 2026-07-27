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

export function extractText(doc: TipTapDoc): string {
  try {
    if (!doc || !Array.isArray(doc.content)) return "";
    return processNodes(doc.content);
  } catch {
    return "";
  }
}

function processNodes(nodes: unknown[]): string {
  const blocks: string[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Node;
    if (BLOCK_TYPES.has(node.type)) {
      blocks.push(extractBlock(node));
    } else {
      const text = extractInline(node);
      if (blocks.length === 0) {
        blocks.push(text);
      } else {
        blocks[blocks.length - 1] += text;
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
