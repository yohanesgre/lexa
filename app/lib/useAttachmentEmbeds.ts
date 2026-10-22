import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { ActivityEvent, Attachment } from "../../shared/types";
import { prependActivity } from "./queries";
import * as api from "./api";
import { useToast } from "../components/ui/Toast";

export function isEmbeddableImage(file: File): boolean {
  return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

interface AttachmentEmbedsOptions {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  enabled?: boolean | undefined;
}

interface PendingInsertion {
  position: number;
  sessionKey: string;
  valid: boolean;
}
export function useAttachmentEmbeds({ slug, documentType, documentId, enabled = true }: AttachmentEmbedsOptions) {
  const qc = useQueryClient();
  const toast = useToast();
  const sessionKey = `${documentType}:${slug}:${documentId}:${enabled ? "editable" : "readonly"}`;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const pendingRef = useRef(new Map<EditorView, Set<PendingInsertion>>());
  const cacheKey = useMemo(
    () => [documentType === "task" ? "task-attachments" : "wiki-attachments", slug, documentId],
    [documentType, slug, documentId]
  );

  useEffect(() => {
    for (const insertions of pendingRef.current.values()) {
      for (const insertion of insertions) {
        insertion.valid = false;
        insertion.sessionKey = "";
      }
    }
  }, [sessionKey]);

  const uploadAndCache = useCallback(async (file: File): Promise<Attachment | null> => {
    try {
      const result = documentType === "task"
        ? await api.uploadTaskAttachment(slug, documentId, file)
        : await api.uploadWikiAttachment(slug, documentId, file);
      qc.setQueryData<Attachment[]>(cacheKey, (old) => (old ? [result.data, ...old] : [result.data]));
      if (documentType === "task") {
        const activity = (result as { activity?: ActivityEvent[] }).activity;
        if (activity?.length) {
          prependActivity(qc, slug, documentId, activity.map((item) => ({ kind: "event" as const, ...item })));
        }
      }
      return result.data;
    } catch (error) {
      toast.push("error", "Upload failed", error instanceof Error ? error.message : "Something went wrong");
      return null;
    }
  }, [cacheKey, documentType, documentId, qc, slug, toast]);

  const handleViewUpdate = useCallback((update: ViewUpdate) => {
    if (!update.docChanged) return;
    const insertions = pendingRef.current.get(update.view);
    if (!insertions) return;
    for (const insertion of insertions) {
      for (const transaction of update.transactions) {
        transaction.changes.iterChangedRanges((fromA, toA) => {
          if (fromA === 0 && toA === transaction.startState.doc.length && toA > 0) insertion.valid = false;
        });
        insertion.position = transaction.changes.mapPos(insertion.position, 1);
      }
    }
  }, []);

  const cancelPending = useCallback(() => {
    for (const insertions of pendingRef.current.values()) {
      for (const insertion of insertions) {
        insertion.valid = false;
        insertion.sessionKey = "";
      }
    }
  }, []);

  const processFiles = useCallback(async (view: EditorView, files: File[], position: number) => {
    if (!enabled) return;
    const insertion: PendingInsertion = { position, sessionKey, valid: true };
    let insertions = pendingRef.current.get(view);
    if (!insertions) {
      insertions = new Set();
      pendingRef.current.set(view, insertions);
    }
    insertions.add(insertion);
    const uploaded = await Promise.all(files.map(async (file) => ({ file, attachment: await uploadAndCache(file) })));
    insertions.delete(insertion);
    if (insertions.size === 0) pendingRef.current.delete(view);
    if (!insertion.valid || sessionKeyRef.current !== insertion.sessionKey || !view.dom.isConnected) return;
    const embeds = uploaded
      .filter((item): item is { file: File; attachment: Attachment } => item.attachment !== null && isEmbeddableImage(item.file))
      .map(({ file, attachment }) => `![${file.name.replace(/[\\\]\n\r]/g, " ")}](/api/attachments/${attachment.id})`);
    if (!embeds.length) return;
    const source = view.state.doc.toString();
    const before = source.slice(0, insertion.position);
    const after = source.slice(insertion.position);
    const prefix = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const suffix = after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    const markdown = `${prefix}${embeds.join("\n")}${suffix}`;
    view.dispatch({ changes: { from: insertion.position, insert: markdown }, userEvent: "input" });
  }, [enabled, sessionKey, uploadAndCache]);

  const handlePaste = useCallback((view: EditorView, event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return false;
    event.preventDefault();
    void processFiles(view, files, view.state.selection.main.from);
    return true;
  }, [processFiles]);

  const handleDrop = useCallback((view: EditorView, event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return false;
    event.preventDefault();
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
    void processFiles(view, files, position);
    return true;
  }, [processFiles]);

  return { handlePaste, handleDrop, handleViewUpdate, cancelPending };

}
