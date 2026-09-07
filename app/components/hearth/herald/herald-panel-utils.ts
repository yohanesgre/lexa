import type { Editor } from "@tiptap/core";
import { markdownToDoc, docToMarkdown } from "../../../../shared/markdown";
import type { Attachment, LexaAgent, LexaSkill, TipTapDoc } from "../../../../shared/types";
import { ENGINE_AGENT_IDS } from "../../../lib/use-hearth-engine";
import type { HeraldSettingsMasked } from "../../../../shared/herald";

// Embedded /api/attachments/<uuid> image nodes in the open document are the
// only image source for a Herald run (herald-popover.html State 1/5) — same
// exact-shape uuid rule as shared/markdown.ts safeImageSrc.
const ATTACHMENT_SRC_RE = /^\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function docAttachmentIds(editor: Editor): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; attrs?: Record<string, unknown> | null; content?: unknown };
    if (n.type === "image" && typeof n.attrs?.src === "string") {
      const m = ATTACHMENT_SRC_RE.exec(n.attrs.src.trim());
      if (m && !seen.has(m[1]!)) {
        seen.add(m[1]!);
        ids.push(m[1]!);
      }
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(editor.state.doc.toJSON());
  return ids;
}

export function pickAttachmentRows(
  documentType: "task" | "wiki",
  taskRows: Attachment[] | undefined,
  wikiRows: Attachment[] | undefined
): Attachment[] | undefined {
  return documentType === "task" ? taskRows : wikiRows;
}

// Each attachment query only targets rows of its own document type — the
// other call gets an empty id (hook treats "" as disabled).
export function attachmentQueryId(documentType: "task" | "wiki", wanted: "task" | "wiki", documentId: string): string {
  return documentType === wanted ? documentId : "";
}

// The persona is the project's configured Herald Agent — its junction rows
// are the only skills the panel offers. An unpicked/out-of-junction id
// falls back to the agent's first skill.
export function pickHeraldSkill(
  agents: LexaAgent[],
  skills: LexaSkill[],
  skillId: string
): { agentSkills: LexaSkill[]; effectiveSkillId: string; skillName: string } {
  const heraldSkillIds = new Set(agents.find((a) => a.id === ENGINE_AGENT_IDS.herald)?.skillIds ?? []);
  const agentSkills = skills.filter((s) => heraldSkillIds.has(s.id));
  const effectiveSkillId = heraldSkillIds.has(skillId) ? skillId : (agentSkills[0]?.id ?? "");
  return { agentSkills, effectiveSkillId, skillName: agentSkills.find((s) => s.id === effectiveSkillId)?.name ?? "Herald" };
}

export function buildRunRequest(args: {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  prompt: string;
  skillId: string;
  selection: string;
  docImages: Attachment[];
}) {
  return {
    slug: args.slug,
    documentType: args.documentType,
    documentId: args.documentId,
    prompt: args.prompt.trim(),
    agentId: ENGINE_AGENT_IDS.herald,
    skillId: args.skillId,
    ...(args.selection.trim() ? { selection: args.selection } : {}),
    // Attachment rows expose sha256 but not storage_key; Lexa/Storage keys
    // are deterministic (storageKeyFor → blobs/<sha256>) so the ref is
    // rebuilt here until the API exposes storage_key directly.
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

export function toDocImages(
  attachmentRows: Attachment[] | undefined,
  editor: Editor
): Attachment[] {
  const byId = new Map((attachmentRows ?? []).map((a) => [a.id, a]));
  return docAttachmentIds(editor)
    .map((id) => byId.get(id))
    .filter((a): a is Attachment => a !== undefined);
}

// The selection rides along as Markdown so Herald can preserve and mirror
// the document's formatting (same contract as the Blacksmith popover).
export function selectionToMarkdown(editor: Editor): string {
  try {
    const slice = editor.state.doc.slice(editor.state.selection.from, editor.state.selection.to);
    return docToMarkdown({ type: "doc", content: slice.content.toJSON() } as TipTapDoc);
  } catch {
    return "";
  }
}

export function getSelection(editor: Editor): { text: string; markdown: string } {
  const text = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
  return { text, markdown: text ? selectionToMarkdown(editor) : "" };
}

// Polish with no selection falls back to the whole document (markdown first,
// then plain text) so the skill still has material to work on.
export function resolveRunSelection(
  editor: Editor,
  skillId: string,
  selection: { text: string; markdown: string }
): string {
  let effectiveSelection = selection.markdown;
  if (skillId === "polish" && !effectiveSelection.trim()) {
    try {
      const full = docToMarkdown(editor.state.doc.toJSON() as unknown as TipTapDoc);
      if (full.trim()) effectiveSelection = full;
      else if (editor.state.doc.textContent.trim()) effectiveSelection = editor.state.doc.textContent;
      else if (selection.text.trim()) effectiveSelection = selection.text;
    } catch {
      if (editor.state.doc.textContent.trim()) effectiveSelection = editor.state.doc.textContent;
      else if (selection.text.trim()) effectiveSelection = selection.text;
    }
  }
  return effectiveSelection;
}

export function insertMarkdown(editor: Editor, text: string): void {
  const doc = markdownToDoc(text);
  editor.chain().focus().insertContent(doc.content ?? []).run();
}

export function monoBox(maxHeight: number): React.CSSProperties {
  return {
    background: "var(--lx-surface-input)",
    border: "1px solid var(--lx-border-default)",
    borderRadius: 6,
    padding: "10px 12px",
    fontFamily: "var(--lx-font-mono)",
    fontSize: 11,
    lineHeight: "18px",
    color: "var(--lx-text-secondary)",
    maxHeight,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  };
}

export function providerLine(settings: HeraldSettingsMasked | null | undefined): string {
  let host = "";
  try {
    if (settings?.baseUrl) host = `${new URL(settings.baseUrl).host} · `;
  } catch {
    host = "";
  }
  return `${host}herald · ${settings?.kind ?? ""}`;
}
