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
import { Effect } from "effect";
import { createWikiAutosaveEffect } from "../../lib/effect-api";

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
  | { type: "reset"; page: WikiPage }
  | { type: "start"; page: WikiPage }
  | { type: "title"; title: string }
  | { type: "dirty" }
  | { type: "saving" }
  | { type: "saved"; page: WikiPage; at: Date; stale?: boolean }
  | { type: "cancel"; page: WikiPage }
  | { type: "stopEditing" }
  | { type: "done" };

function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "reset":
      return initEditState(action.page);
    case "start":
      return { ...initEditState(action.page), isEditing: true };
    case "title":
      return { ...state, title: action.title, isDirty: true };
    case "dirty":
      return state.isDirty ? state : { ...state, isDirty: true };
    case "saving":
      return { ...state, isSaving: true };
    case "saved":
      // A save that overlapped further edits must not adopt the server title
      // or clear the dirty flag — those edits would be silently dropped.
      if (action.stale) {
        return { ...state, lastSavedPage: action.page, lastSavedAt: action.at };
      }
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
  // Monotonic edit counter: bumped on every meaningful edit so an in-flight
  // save can tell whether newer edits landed while it awaited the server.
  const editVersionRef = useRef(0);
  const embeds = useAttachmentEmbeds({ slug, documentType: "wiki", documentId: page.slug });
  const markDirtyRef = useRef<() => void>(() => {});
  const reviewActiveRef = useRef(false);
  const historyPreviewRef = useRef<string | null>(null);
  const previewSnapshotRef = useRef<TipTapDoc | null>(null);
  const autosaveHandleRef = useRef<ReturnType<typeof createWikiAutosaveEffect> | null>(null);
  // Latest async handles for the debounced autosave effect, whose deps stay
  // stable (autosaveDelay / page.slug / slug) so a re-render never destroys the
  // armed timer. `useMutation` returns a new object every render.
  const autosaveMutationRef = useRef(updateWikiPage.mutateAsync);
  const navigateRef = useRef(navigate);
  const slugRef = useRef(slug);
  const pageSlugRef = useRef(page.slug);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  // P0-5 backstop: if the page prop changes without a remount (missing key),
  // reset edit state and swap the editor doc so A's content can never be
  // PATCHed into B's slug.
  const previousSlugRef = useRef(page.slug);
  useEffect(() => {
    if (previousSlugRef.current === page.slug) return;
    previousSlugRef.current = page.slug;
    // Bump the edit counter so any save already in flight is recognised as
    // stale on resolve — its response must not adopt the previous page's
    // title/state onto the new page.
    editVersionRef.current += 1;
    autosaveHandleRef.current?.cancel();
    previewSnapshotRef.current = null;
    setHistoryPreviewId(null);
    dispatch({ type: "reset", page });
    editorRef.current?.setEditable(true);
    editorRef.current?.commands.setContent((page.content ?? emptyDoc) as unknown as JSONContent);
    setPreviewContent(page.content ?? emptyDoc);
  }, [page]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4, 5] }, code: false }),
      // Code must combine with other marks (bold+code is valid CommonMark,
      // common in Runtime results) or accepting such a result throws.
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
    autosaveHandleRef.current?.cancel();
    const versionAtStart = editVersionRef.current;
    dispatch({ type: "saving" });
    // Lock the editor for the manual save's duration so the request payload is
    // the doc the user saw when they pressed Save.
    if (saveType === "manual") editor.setEditable(false);
    let stale = false;
    try {
      const savedPage = await updateWikiPage.mutateAsync({
        pageSlug: page.slug,
        title: titleRef.current,
        content: editor.getJSON() as unknown as TipTapDoc,
        saveType,
      });
      stale = editVersionRef.current !== versionAtStart;
      dispatch({ type: "saved", page: savedPage, at: new Date(), stale });
      if (savedPage.slug !== page.slug) {
        navigate({
          to: "/$slug/wiki/$pageSlug",
          params: { slug, pageSlug: savedPage.slug },
          replace: true,
        });
      }
    } finally {
      if (saveType === "manual" && editorRef.current === editor) editor.setEditable(true);
      dispatch({ type: "done" });
    }
    return stale;
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
    autosaveMutationRef.current = updateWikiPage.mutateAsync;
    navigateRef.current = navigate;
    slugRef.current = slug;
    pageSlugRef.current = page.slug;
  });

  useEffect(() => {
    autosaveHandleRef.current?.destroy();
    const handle = createWikiAutosaveEffect(
      (decodedDoc) =>
        Effect.tryPromise({
          try: () => {
            const ed = editorRef.current;
            if (!ed) return Promise.resolve(null);
            const versionAtStart = editVersionRef.current;
            dispatch({ type: "saving" });
            return autosaveMutationRef.current({
              pageSlug: pageSlugRef.current,
              title: titleRef.current,
              content: decodedDoc,
              saveType: "autosave",
            }).then((saved) => ({ saved, versionAtStart }));
          },
          catch: (e) => e as unknown as Error,
        }).pipe(
          Effect.flatMap((result) =>
            Effect.sync(() => {
              if (!result) return;
              const { saved, versionAtStart } = result as { saved: WikiPage; versionAtStart: number };
              dispatch({
                type: "saved",
                page: saved,
                at: new Date(),
                stale: editVersionRef.current !== versionAtStart,
              });
              if (saved.slug !== pageSlugRef.current) {
                navigateRef.current({
                  to: "/$slug/wiki/$pageSlug",
                  params: { slug: slugRef.current, pageSlug: saved.slug },
                  replace: true,
                });
              }
            })
          ),
          Effect.ensuring(Effect.sync(() => dispatch({ type: "done" }))),
          Effect.catchAll(() => Effect.succeed(undefined))
        ),
      autosaveDelay
    );
    autosaveHandleRef.current = handle;
    return () => handle.destroy();
  }, [autosaveDelay, page.slug, slug]);

  const markDirty = useCallback(() => {
    editVersionRef.current += 1;
    dispatch({ type: "dirty" });
    if (reviewActiveRef.current) return;
    if (!autosaveEnabled) return;
    const ed = editorRef.current;
    if (!ed) return;
    const doc = ed.getJSON() as unknown as TipTapDoc;
    autosaveHandleRef.current?.trigger(doc);
  }, [autosaveEnabled]);

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
    autosaveHandleRef.current?.cancel();
    try {
      const restored = await restoreWikiPage.mutateAsync({ pageSlug: page.slug, revisionId });
      dispatch({ type: "title", title: restored.title });
      dispatch({ type: "saved", page: restored, at: new Date() });
      editorRef.current?.commands.setContent((restored.content ?? emptyDoc) as unknown as JSONContent);
      autosaveHandleRef.current?.cancel();
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
    autosaveHandleRef.current?.cancel();
    previewSnapshotRef.current = null;
    setHistoryPreviewId(null);
    dispatch({ type: "cancel", page: lastSavedPage });
    editorRef.current?.setEditable(true);
    editorRef.current?.commands.setContent(lastSavedPage.content as unknown as JSONContent);
    dispatch({ type: "stopEditing" });
  };

  const handleSave = async () => {
    if (isDirty) {
      let stale = false;
      try {
        stale = (await saveRef.current("manual")) ?? false;
      } catch {
        // Save failed — stay in edit mode so the user can retry.
        return;
      }
      // Edits landed while the save was in flight — the server now holds an
      // older doc, so leaving edit mode here would silently drop them.
      if (stale) return;
    }
    editorRef.current?.setEditable(false);
    dispatch({ type: "stopEditing" });
  };

  useEffect(() => {
    return () => {
      autosaveHandleRef.current?.destroy();
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
