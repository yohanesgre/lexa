import { parseMarkdown } from "@tanstack/markdown/parser";
import type { BlockNode, InlineNode } from "@tanstack/markdown";
import type { MarkdownSource } from "../../editor/MarkdownEditorPane";
import type { Attachment } from "../../../../shared/types";
import { ASSISTANT_AGENT_ID } from "../../../lib/assistant-agent";

const ATTACHMENT_SRC_RE = /^\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function markdownAttachmentIds(source: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const addInline = (nodes: InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === "image") {
        const id = ATTACHMENT_SRC_RE.exec(node.src.trim())?.[1];
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      } else if ("children" in node) {
        addInline(node.children);
      }
    }
  };
  const addBlocks = (blocks: BlockNode[]) => {
    for (const block of blocks) {
      if (block.type === "heading" || block.type === "paragraph") {
        addInline(block.children);
      } else if (block.type === "blockquote" || block.type === "callout" || block.type === "component") {
        addBlocks(block.children);
      } else if (block.type === "list") {
        for (const item of block.items) addBlocks(item.children);
      } else if (block.type === "table") {
        for (const cell of block.header) addInline(cell.children);
        for (const row of block.rows) for (const cell of row) addInline(cell.children);
      } else if (block.type === "footnotes") {
        for (const item of block.items) addBlocks(item.children);
      }
    }
  };
  addBlocks(parseMarkdown(source, { allowHtml: false, frontmatter: false }).children);
  return ids;
}

export function pickAttachmentRows(
  documentType: "task" | "wiki",
  taskRows: Attachment[] | undefined,
  wikiRows: Attachment[] | undefined
): Attachment[] | undefined {
  return documentType === "task" ? taskRows : wikiRows;
}

export function attachmentQueryId(documentType: "task" | "wiki", wanted: "task" | "wiki", documentId: string): string {
  return documentType === wanted ? documentId : "";
}

export function buildRunRequest(args: {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  prompt: string;
  selection: string;
  docImages: Attachment[];
}) {
  return {
    slug: args.slug,
    documentType: args.documentType,
    documentId: args.documentId,
    prompt: args.prompt.trim(),
    agentId: ASSISTANT_AGENT_ID,
    ...(args.selection.trim() ? { selection: args.selection } : {}),
    ...(args.docImages.length
      ? {
          attachments: args.docImages.map((a) => ({
            storageKey: `blobs/${a.sha256}`,
            mimeType: a.mimeType,
            name: a.filename,
          })),
        }
      : {}),
  };
}

export function toDocImages(attachmentRows: Attachment[] | undefined, source: string): Attachment[] {
  const byId = new Map((attachmentRows ?? []).map((attachment) => [attachment.id, attachment]));
  return markdownAttachmentIds(source)
    .map((id) => byId.get(id))
    .filter((attachment): attachment is Attachment => attachment !== undefined);
}

export function getSelection(source: MarkdownSource | null): { text: string; markdown: string } {
  const text = source?.getSelection() ?? "";
  return { text, markdown: text };
}

export function resolveRunSelection(selection: { markdown: string }): string {
  return selection.markdown;
}
