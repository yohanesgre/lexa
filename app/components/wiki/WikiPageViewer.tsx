import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
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
import { useUpdateWikiPage } from "../../lib/queries";
import { Toolbar } from "../TextEditor";
import { ForgeReviewSurface } from "../forge/ForgeReviewSurface";
import { useForgeReview } from "../forge/useForgeReview";
import { cn } from "../ui/cn";
import { renderDoc, extractHeadings, slugifyHeading } from "../tiptap-render";
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

interface WikiEditorProps {
  editor: Editor;
  forge?: { slug: string; documentType: "task" | "wiki"; documentId: string };
  onReviewStateChange?: (active: boolean, accepted: boolean) => void;
}

function WikiEditor({ editor, forge, onReviewStateChange }: WikiEditorProps) {
  const { review, appliedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useForgeReview(editor, onReviewStateChange);
  return (
    <div className={cn("editor-wrapper flex flex-col flex-1 min-h-0", review && "is-reviewing")}>
      <Toolbar editor={editor} headingLevel={(editor.getAttributes("heading").level as number | undefined) ?? 0} forge={forge} reviewActive={review !== null} appliedTaskId={appliedTaskId} onReview={handleReview} />
      {review && (
        <ForgeReviewSurface action={review.action} runtime={review.runtime} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <EditorContent editor={editor} className="editor-content flex-1 p-4 px-5" />
    </div>
  );
}

interface WikiPageViewerProps {
  slug: string;
  page: WikiPage;
  pages: WikiPageMeta[];
}

export function WikiPageViewer({ slug, page, pages }: WikiPageViewerProps) {
  const navigate = useNavigate();
  const updateWikiPage = useUpdateWikiPage(slug);

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [lastSavedPage, setLastSavedPage] = useState(page);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [autosaveEnabled, setAutosaveEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("lexa-wiki-autosave");
    return stored === null ? true : stored === "true";
  });
  const [autosaveDelay, setAutosaveDelay] = useState(() => {
    if (typeof window === "undefined") return 800;
    const stored = window.localStorage.getItem("lexa-wiki-autosave-delay");
    return stored === null ? 800 : Number(stored) || 800;
  });
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [outlineVisible, setOutlineVisible] = useState(true);
  const [previewContent, setPreviewContent] = useState<TipTapDoc>(emptyDoc);

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
    if (!editor) return;
    const handler = () => {
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
    setIsSaving(true);
    try {
      const savedPage = await updateWikiPage.mutateAsync({
        pageSlug: page.slug,
        title: titleRef.current,
        content: editor.getJSON() as unknown as TipTapDoc,
        saveType,
      });
      setLastSavedPage(savedPage);
      setLastSavedAt(new Date());
      setIsDirty(false);
      if (savedPage.slug !== page.slug) {
        navigate({
          to: "/$slug/wiki/$pageSlug",
          params: { slug, pageSlug: savedPage.slug },
          replace: true,
        });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;

  const markDirty = () => {
    setIsDirty(true);
    if (reviewActiveRef.current) return;
    if (!autosaveEnabled) return;
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      void saveRef.current("autosave");
    }, autosaveDelay);
  };

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
    setTitle(page.title);
    setLastSavedPage(page);
    setLastSavedAt(null);
    setIsDirty(false);
    setPreviewContent(page.content ?? emptyDoc);
    editorRef.current?.setEditable(true);
    editorRef.current?.commands.setContent((page.content ?? emptyDoc) as unknown as JSONContent);
    setIsEditing(true);
  };

  const handleCancel = () => {
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    setTitle(lastSavedPage.title);
    editorRef.current?.setEditable(false);
    editorRef.current?.commands.setContent(lastSavedPage.content as unknown as JSONContent);
    setIsDirty(false);
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (isDirty) await saveRef.current("manual");
    editorRef.current?.setEditable(false);
    setIsEditing(false);
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
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {/* Title input */}
        <div style={{ padding: "12px 16px 0" }}>
          <input
            className="wiki-title-input"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              markDirty();
            }}
            placeholder="Page title"
          />
        </div>

        {/* Side-by-side: Preview left, Editor right */}
        <div className="flex flex-1 overflow-hidden" style={{ borderTop: "1px solid var(--lx-border-subtle)" }}>
          {/* Left: Preview */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <div
              style={{
                padding: "4px 8px",
                borderBottom: "1px solid var(--lx-border-subtle)",
                background: "var(--lx-bg-surface)",
              }}
            >
              <span className="text-xs text-lx-text-muted font-body uppercase tracking-[0.05em]">Preview</span>
            </div>
            <div
              className="wiki-prose flex-1 overflow-y-auto"
              style={{ padding: "16px 20px", background: "var(--lx-bg-page)" }}
            >
              {renderDoc(previewContent, "wiki")}
            </div>
          </div>

          {/* Right: Editor */}
          <div
            className="flex flex-1 flex-col overflow-hidden"
            style={{ borderLeft: "1px solid var(--lx-border-subtle)" }}
          >
            <div
              style={{
                padding: "4px 8px",
                borderBottom: "1px solid var(--lx-border-subtle)",
                background: "var(--lx-bg-surface)",
              }}
            >
              <span className="text-xs text-lx-text-muted font-body uppercase tracking-[0.05em]">Editor</span>
            </div>
            {editor && <WikiEditor editor={editor} forge={{ slug, documentType: "wiki", documentId: page.slug }} onReviewStateChange={handleReviewStateChange} />}
            <div
              className="flex items-center justify-between"
              style={{
                padding: "8px 12px",
                borderTop: "1px solid var(--lx-border-subtle)",
                background: "var(--lx-bg-surface)",
              }}
            >
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                {isSaving
                  ? "Saving…"
                  : lastSavedAt
                    ? formatSavedAt(lastSavedAt)
                    : `Last edited ${formatRelative(lastSavedPage.updatedAt)}`}
              </span>
              {isSaving ? (
                <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">Saving…</span>
              ) : (
                isDirty && (
                  <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">
                    Unsaved changes
                  </span>
                )
              )}
            </div>
          </div>
        </div>
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
      />
    </div>
  );
}
