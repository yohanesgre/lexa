import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useEditor } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Placeholder from "@tiptap/extension-placeholder";
import type { WikiPage, TipTapDoc } from "../../../shared/types";
import { useUpdateWikiPage, useRestoreWikiRevision } from "../../lib/queries";
import { useAttachmentEmbeds } from "../../lib/useAttachmentEmbeds";
import { createMentionExtension } from "../../lib/mention-suggestion";
import * as api from "../../lib/api";

const emptyDoc: TipTapDoc = { type: "doc", content: [] };

interface EditState {
  isEditing: boolean;
  title: string;
  lastSavedPage: WikiPage;
  lastSavedAt: Date | null;
  isDirty: boolean;
  isSaving: boolean;
}

function initEditState(page: WikiPage): EditState {
  return {
    isEditing: false,
    title: page.title,
    lastSavedPage: page,
    lastSavedAt: null,
    isDirty: false,
    isSaving: false,
  };
}

type EditAction =
  | { type: "start"; page: WikiPage }
  | { type: "title"; title: string }
  | { type: "dirty" }
  | { type: "saving" }
  | { type: "saved"; page: WikiPage; at: Date }
  | { type: "cancel"; page: WikiPage }
  | { type: "stopEditing" }
  | { type: "done" };

function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "start":
      return { ...initEditState(action.page), isEditing: true };
    case "title":
      return { ...state, title: action.title, isDirty: true };
    case "dirty":
      return state.isDirty ? state : { ...state, isDirty: true };
    case "saving":
      return { ...state, isSaving: true };
    case "saved":
      return { ...state, title: action.page.title, lastSavedPage: action.page, lastSavedAt: action.at, isDirty: false };
    case "cancel":
      return { ...state, title: action.page.title, lastSavedPage: action.page, isDirty: false };
    case "stopEditing":
      return { ...state, isEditing: false, isDirty: false };
    case "done":
      return { ...state, isSaving: false };
  }
}

export function useWikiEditor({ slug, page }: { slug: string; page: WikiPage }) {
  const navigate = useNavigate();
  const updateWikiPage = useUpdateWikiPage(slug);
  const restoreWikiPage = useRestoreWikiRevision(slug);

  const [edit, dispatch] = useReducer(editReducer, page, initEditState);
  const { isEditing, title, lastSavedPage, lastSavedAt, isDirty, isSaving } = edit;
  const [previewContent, setPreviewContent] = useState<TipTapDoc>(emptyDoc);
  const [historyPreviewId, setHistoryPreviewId] = useState<string | null>(null);
  const [autosaveEnabled, setAutosaveEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("lexa-wiki-autosave");
    return stored === null ? false : stored === "true";
  });
  const [autosaveDelay, setAutosaveDelay] = useState(() => {
    if (typeof window === "undefined") return 800;
    const stored = window.localStorage.getItem("lexa-wiki-autosave-delay");
    return stored === null ? 800 : Number(stored) || 800;
  });

  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave", String(autosaveEnabled));
  }, [autosaveEnabled]);

  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave-delay", String(autosaveDelay));
  }, [autosaveDelay]);

  const editorRef = useRef<Editor | null>(null);
  const titleRef = useRef(title);
  // Paste/drop-to-embed: images upload via the attachments API and insert
  // with src=/api/attachments/<id>; other types upload as plain attachments.
  const embeds = useAttachmentEmbeds({ slug, documentType: "wiki", documentId: page.slug });
  const autosaveTimer = useRef<number | null>(null);
  const markDirtyRef = useRef<() => void>(() => {});
  // While a Forge result is being reviewed, autosave is suspended — the
  // unaccepted insert must not reach the database before Accept.
  const reviewActiveRef = useRef(false);
  const historyPreviewRef = useRef<string | null>(null);
  const previewSnapshotRef = useRef<TipTapDoc | null>(null);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4, 5] }, code: false }),
      // Code must combine with other marks (bold+code is valid CommonMark,
      // common in Forge results) or accepting such a result throws.
      Code.extend({ excludes: "" }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false }),
      Highlight,
      Underline,
      // Image + table nodes must be in the schema for stored pages to open
      // without ProseMirror dropping the nodes (unknown nodes are stripped).
      Image.configure({ inline: true, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: "Start writing..." }),
      // Per-editor mention plugin (project-scoped "@" autocomplete).
      createMentionExtension({ slug }),
    ],
    content: (page.content ?? emptyDoc) as unknown as JSONContent,
    editable: isEditing,
    onUpdate: () => markDirtyRef.current?.(),
    editorProps: {
      attributes: {
        style: "line-height: 26px",
      },
      handlePaste: embeds.handlePaste,
      handleDrop: embeds.handleDrop,
    },
  });

  useEffect(() => {
    editorRef.current = editor ?? null;
  }, [editor]);

  const updatePreviewRef = useRef<(json: TipTapDoc) => void>(() => {});

  useEffect(() => {
    updatePreviewRef.current = (json: TipTapDoc) => setPreviewContent(json);
  }, []);

  useEffect(() => {
    historyPreviewRef.current = historyPreviewId;
  }, [historyPreviewId]);

  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      // A history preview owns the preview pane — live editor updates must
      // not clobber it until Close preview hands the pane back.
      if (historyPreviewRef.current !== null) return;
      updatePreviewRef.current(editor.getJSON() as unknown as TipTapDoc);
    };
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor]);

  const save = async (saveType: "autosave" | "manual" = "manual") => {
    const editor = editorRef.current;
    if (!editor) return;
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    dispatch({ type: "saving" });
    try {
      const savedPage = await updateWikiPage.mutateAsync({
        pageSlug: page.slug,
        title: titleRef.current,
        content: editor.getJSON() as unknown as TipTapDoc,
        saveType,
      });
      dispatch({ type: "saved", page: savedPage, at: new Date() });
      if (savedPage.slug !== page.slug) {
        navigate({
          to: "/$slug/wiki/$pageSlug",
          params: { slug, pageSlug: savedPage.slug },
          replace: true,
        });
      }
    } finally {
      dispatch({ type: "done" });
    }
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const markDirty = useCallback(() => {
    dispatch({ type: "dirty" });
    if (reviewActiveRef.current) return;
    if (!autosaveEnabled) return;
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      void saveRef.current("autosave");
    }, autosaveDelay);
  }, [autosaveEnabled, autosaveDelay]);

  useEffect(() => {
    markDirtyRef.current = markDirty;
  }, [markDirty]);

  const handleSelectRevision = async (revisionId: string) => {
    if (historyPreviewId === revisionId) return;
    try {
      const { revision } = await api.getWikiRevision(slug, page.slug, revisionId);
      const editor = editorRef.current;
      // First preview captures the live doc (may hold unsaved typing); a
      // revision-to-revision swap must not clobber that snapshot.
      if (previewSnapshotRef.current === null && editor) {
        previewSnapshotRef.current = editor.getJSON() as unknown as TipTapDoc;
      }
      editor?.commands.setContent(revision.content as unknown as JSONContent, { emitUpdate: false });
      editor?.setEditable(false);
      setHistoryPreviewId(revisionId);
      setPreviewContent(revision.content);
    } catch {
      const snapshot = previewSnapshotRef.current;
      if (snapshot) {
        previewSnapshotRef.current = null;
        const editor = editorRef.current;
        editor?.commands.setContent(snapshot as unknown as JSONContent, { emitUpdate: false });
        editor?.setEditable(true);
      }
      setHistoryPreviewId(null);
    }
  };

  const handleClosePreview = () => {
    const snapshot = previewSnapshotRef.current;
    previewSnapshotRef.current = null;
    setHistoryPreviewId(null);
    const editor = editorRef.current;
    if (editor) {
      if (snapshot) editor.commands.setContent(snapshot as unknown as JSONContent, { emitUpdate: false });
      editor.setEditable(true);
      setPreviewContent(editor.getJSON() as unknown as TipTapDoc);
    }
  };

  const handleRestore = async (revisionId: string) => {
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    try {
      const restored = await restoreWikiPage.mutateAsync({ pageSlug: page.slug, revisionId });
      dispatch({ type: "title", title: restored.title });
      dispatch({ type: "saved", page: restored, at: new Date() });
      editorRef.current?.commands.setContent((restored.content ?? emptyDoc) as unknown as JSONContent);
      if (autosaveTimer.current !== null) {
        window.clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
      previewSnapshotRef.current = null;
      editorRef.current?.setEditable(true);
      setHistoryPreviewId(null);
      setPreviewContent(restored.content ?? emptyDoc);
      if (restored.slug !== page.slug) {
        navigate({
          to: "/$slug/wiki/$pageSlug",
          params: { slug, pageSlug: restored.slug },
          replace: true,
        });
      }
    } catch {
      // restore failed — mutation cache untouched, UI stays as-is
    }
  };

  const handleReviewStateChange = (active: boolean, _accepted: boolean) => {
    reviewActiveRef.current = active;
    if (!active) {
      // Accept/Reject ended the review — persist whatever the doc holds now
      // (the accepted result, or the restored pre-review snapshot).
      markDirtyRef.current?.();
    }
  };

  const handleStartEditing = () => {
    dispatch({ type: "start", page });
    setPreviewContent(page.content ?? emptyDoc);
    editorRef.current?.setEditable(true);
    editorRef.current?.commands.setContent((page.content ?? emptyDoc) as unknown as JSONContent);
  };

  const handleCancel = () => {
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    previewSnapshotRef.current = null;
    setHistoryPreviewId(null);
    dispatch({ type: "cancel", page: lastSavedPage });
    editorRef.current?.setEditable(true);
    editorRef.current?.commands.setContent(lastSavedPage.content as unknown as JSONContent);
    dispatch({ type: "stopEditing" });
  };

  const handleSave = async () => {
    if (isDirty) await saveRef.current("manual");
    editorRef.current?.setEditable(false);
    dispatch({ type: "stopEditing" });
  };

  useEffect(() => {
    return () => {
      if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
    };
  }, []);

  return {
    editor,
    isEditing,
    title,
    lastSavedPage,
    lastSavedAt,
    isDirty,
    isSaving,
    restoring: restoreWikiPage.isPending,
    previewContent,
    historyPreviewId,
    autosaveEnabled,
    autosaveDelay,
    setAutosaveEnabled,
    setAutosaveDelay,
    handleStartEditing,
    handleCancel,
    handleSave,
    handleSelectRevision,
    handleClosePreview,
    handleRestore,
    handleReviewStateChange,
    handleTitleChange: (next: string) => {
      dispatch({ type: "title", title: next });
      markDirty();
    },
  };
}
