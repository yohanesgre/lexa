import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useEditor } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import type { WikiPage, WikiPageMeta, TipTapDoc } from "../../../shared/types";
import { useUpdateWikiPage, useRestoreWikiRevision } from "../../lib/queries";
import * as api from "../../lib/api";
import { renderDoc, extractHeadings, slugifyHeading } from "../tiptap-render";
import { WikiEditor } from "./WikiEditor";
import { WikiEditSplit } from "./WikiEditSplit";
import { EditSidebar } from "./EditSidebar";
import { OutlineSidebar } from "./OutlineSidebar";
import { SourcesSection } from "../forge/SourcesSection";
import { parseApiDate } from "../../lib/date";

const emptyDoc: TipTapDoc = { type: "doc", content: [] };

function formatRelative(iso: string): string {
  const then = parseApiDate(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatSavedAt(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `Saved ${h}:${m}`;
}

function buildAncestors(pages: WikiPageMeta[], page: WikiPage): WikiPageMeta[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ancestors: WikiPageMeta[] = [];
  let currentId: string | null = page.parentId;
  while (currentId) {
    const parent = byId.get(currentId);
    if (!parent) break;
    ancestors.unshift(parent);
    currentId = parent.parentId;
  }
  return ancestors;
}

interface WikiPageViewerProps {
  slug: string;
  page: WikiPage;
  pages: WikiPageMeta[];
}

type EditState = {
  isEditing: boolean;
  title: string;
  lastSavedPage: WikiPage;
  lastSavedAt: Date | null;
  isDirty: boolean;
  isSaving: boolean;
};

type EditAction =
  | { type: "start"; page: WikiPage }
  | { type: "title"; title: string }
  | { type: "dirty" }
  | { type: "saving" }
  | { type: "saved"; page: WikiPage; at: Date }
  | { type: "cancel"; page: WikiPage }
  | { type: "stopEditing" }
  | { type: "done" };

function initEditState(page: WikiPage): EditState {
  return { isEditing: false, title: page.title, lastSavedPage: page, lastSavedAt: null, isDirty: false, isSaving: false };
}

function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "start":
      return { ...state, isEditing: true, title: action.page.title, lastSavedPage: action.page, lastSavedAt: null, isDirty: false };
    case "title":
      return { ...state, title: action.title };
    case "dirty":
      return { ...state, isDirty: true };
    case "saving":
      return { ...state, isSaving: true };
    case "saved":
      return { ...state, isSaving: false, lastSavedPage: action.page, lastSavedAt: action.at, isDirty: false };
    case "cancel":
      return { ...state, isEditing: false, title: action.page.title, lastSavedPage: action.page, isDirty: false, isSaving: false };
    case "stopEditing":
      return { ...state, isEditing: false, isSaving: false };
    case "done":
      return { ...state, isSaving: false };
  }
}

export function WikiPageViewer({ slug, page, pages }: WikiPageViewerProps) {
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
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [outlineVisible, setOutlineVisible] = useState(true);


  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave", String(autosaveEnabled));
  }, [autosaveEnabled]);

  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave-delay", String(autosaveDelay));
  }, [autosaveDelay]);

  const editorRef = useRef<Editor | null>(null);
  const titleRef = useRef(title);
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
      Placeholder.configure({ placeholder: "Start writing..." }),
    ],
    content: (page.content ?? emptyDoc) as unknown as JSONContent,
    editable: isEditing,
    onUpdate: () => markDirtyRef.current?.(),
    editorProps: {
      attributes: {
        style: "line-height: 26px",
      },
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

  const breadcrumb = buildAncestors(pages, page)
    .map((a) => a.title)
    .join(" / ");

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

  const markDirty = useCallback(() => {
    dispatch({ type: "dirty" });
    if (reviewActiveRef.current) return;
    if (!autosaveEnabled) return;
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      void saveRef.current("autosave");
    }, autosaveDelay);
  }, [autosaveEnabled, autosaveDelay]);

  const handleReviewStateChange = (active: boolean, _accepted: boolean) => {
    reviewActiveRef.current = active;
    if (!active) {
      // Accept/Reject ended the review — persist whatever the doc holds now
      // (the accepted result, or the restored pre-review snapshot).
      markDirtyRef.current?.();
    }
  };

  useEffect(() => {
    markDirtyRef.current = markDirty;
  }, [markDirty]);

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

  if (!isEditing) {
    const rawHeadings = extractHeadings(page.content as unknown as import("../tiptap-render").TTNode);
    const pageTitleId = slugifyHeading(page.title);
    const headings = [
      { level: 1, text: page.title, id: pageTitleId },
      ...rawHeadings.filter((h) => h.level >= 2),
    ];
    return (
      <div className="wiki-content wiki-edit-workspace">
        <div className="flex flex-1 min-w-0">
          <div className="flex-1 overflow-y-auto" style={{ padding: "32px 48px" }}>
            <div className="wiki-prose">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-lx-text-muted font-body">{breadcrumb}</span>
                <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={handleStartEditing}>
                  <Pencil size={14} strokeWidth={1.5} />
                  Edit
                </button>
              </div>
              <h1 id={pageTitleId}>{page.title}</h1>
              <div>{renderDoc(page.content, "wiki")}</div>
              <SourcesSection
                slug={slug}
                documentType="wiki"
                documentId={page.slug}
                className="mt-8 pt-4 border-t border-lx-border-subtle"
              />
              <div className="mt-8 pt-4 border-t border-lx-border-subtle">
                <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                  Last edited {formatRelative(page.updatedAt)}
                </span>
              </div>
            </div>
          </div>
          <OutlineSidebar headings={headings} collapsed={!outlineVisible} onToggle={() => setOutlineVisible(!outlineVisible)} />
        </div>
      </div>
    );
  }

  return (
    <div className="wiki-content wiki-edit-workspace">
      <div className="wiki-edit-main flex flex-col" style={{ padding: 0, overflow: "hidden" }}>
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{ padding: "12px 16px", borderBottom: "1px solid var(--lx-border-subtle)" }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-lx-text-muted font-body">{breadcrumb}</span>
            <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">Editing</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost" onClick={handleCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={isSaving || historyPreviewId !== null}>
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {/* Title input */}
        <div style={{ padding: "12px 16px 0" }}>
          <input
            className="wiki-title-input"
            aria-label="Page title"
            value={title}
            onChange={(e) => {
              dispatch({ type: "title", title: e.target.value });
              markDirty();
            }}
            placeholder="Page title"
          />
        </div>

        <WikiEditSplit
          editor={editor}
          slug={slug}
          pageSlug={page.slug}
          previewContent={previewContent}
          isSaving={isSaving}
          isDirty={isDirty}
          lastSavedAt={lastSavedAt}
          lastSavedLabel={isSaving ? "Saving…" : lastSavedAt ? formatSavedAt(lastSavedAt) : `Last edited ${formatRelative(lastSavedPage.updatedAt)}`}
          onReviewStateChange={handleReviewStateChange}
        />
      </div>

      <EditSidebar
        slug={slug}
        pageSlug={page.slug}
        autosaveEnabled={autosaveEnabled}
        autosaveDelay={autosaveDelay}
        onAutosaveChange={setAutosaveEnabled}
        onDelayChange={setAutosaveDelay}
        collapsed={!sidebarVisible}
        onToggle={() => setSidebarVisible(!sidebarVisible)}
        selectedRevisionId={historyPreviewId}
        onSelectRevision={(id) => void handleSelectRevision(id)}
        onRestore={(id) => void handleRestore(id)}
        onClosePreview={handleClosePreview}
        restoring={restoreWikiPage.isPending}
      />
    </div>
  );
}
