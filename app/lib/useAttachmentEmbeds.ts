import { useQueryClient } from "@tanstack/react-query";
import type { EditorView } from "@tiptap/pm/view";
import type { ActivityEvent, Attachment } from "../../shared/types";
import { prependActivity } from "./queries";
import * as api from "./api";
import { useToast } from "../components/ui/Toast";

// Paste/drop-to-embed (wiki-edit wireframe annotations): pasting or dropping
// an image uploads it via the attachments API first, then inserts an image
// node at the caret / drop point with src=/api/attachments/<id> — never a
// data: URL. svg/html and all other types never render inline; they upload
// as plain attachments (download-only chips/rows).
export function isEmbeddableImage(file: File): boolean {
  return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

interface AttachmentEmbedsOptions {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
}

export function useAttachmentEmbeds({ slug, documentType, documentId }: AttachmentEmbedsOptions) {
  const qc = useQueryClient();
  const toast = useToast();

  const cacheKey = [documentType === "task" ? "task-attachments" : "wiki-attachments", slug, documentId];

  const uploadAndCache = async (file: File): Promise<Attachment | null> => {
    try {
      const result = documentType === "task"
        ? await api.uploadTaskAttachment(slug, documentId, file)
        : await api.uploadWikiAttachment(slug, documentId, file);
      // Cache prepend mirrors useUploadAttachment (invariant 6) — the panel
      // reflects the embedded file without a refetch. Dedupe hits arrive as
      // 201 with activity: [] and land identically.
      qc.setQueryData<Attachment[]>(cacheKey, (old) => (old ? [result.data, ...old] : [result.data]));
      if (documentType === "task") {
        const activity = (result as { activity?: ActivityEvent[] }).activity;
        if (activity?.length) {
          prependActivity(qc, slug, documentId, activity.map((a) => ({ kind: "event" as const, ...a })));
        }
      }
      return result.data;
    } catch (err) {
      toast.push("error", "Upload failed", err instanceof Error ? err.message : "Something went wrong");
      return null;
    }
  };

  const insertImageAt = (view: EditorView, pos: number | null, src: string, alt: string) => {
    const schema = view.state.schema;
    if (!schema.nodes.image) return;
    const node = schema.nodes.image.create({ src, alt });
    view.dispatch(view.state.tr.insert(pos ?? view.state.selection.from, node));
  };

  const processFiles = async (view: EditorView, files: File[], dropPos: number | null) => {
    let pos = dropPos;
    for (const file of files) {
      if (!isEmbeddableImage(file)) {
        await uploadAndCache(file);
        continue;
      }
      const attachment = await uploadAndCache(file);
      if (attachment) {
        insertImageAt(view, pos, `/api/attachments/${attachment.id}`, file.name);
        // Inline image occupies one position — advance so multiple dropped
        // images land in drop order instead of stacking in reverse.
        pos = (pos ?? view.state.selection.from) + 1;
      }
    }
  };

  return {
    handlePaste: (view: EditorView, event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((f) => isEmbeddableImage(f));
      if (!files.length) return false;
      event.preventDefault();
      void processFiles(view, files, null);
      return true;
    },
    handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
      if (moved) return false;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
      void processFiles(view, files, pos);
      return true;
    },
  };
}
