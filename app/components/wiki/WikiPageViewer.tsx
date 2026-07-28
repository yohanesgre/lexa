import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import type { WikiPage, WikiPageMeta, TipTapDoc } from "../../../shared/types";
import { useUpdateWikiPage } from "../../lib/queries";
import { cn } from "../ui/cn";
import { renderDoc } from "../tiptap-render";
import { EditSidebar } from "./EditSidebar";

const emptyDoc: TipTapDoc = { type: "doc", content: [] };

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
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

function setLink(editor: Editor) {
  const previousUrl = (editor.getAttributes("link").href as string | undefined) ?? "";
  const url = window.prompt("Link URL", previousUrl);
  if (url === null) return;
  if (url === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  } else {
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }
}

interface WikiToolbarButtonProps {
  command: () => void;
  isActive: boolean;
  title: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

function WikiToolbarButton({ command, isActive, title, children, style }: WikiToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={command}
      className={cn("toolbar-btn", isActive && "active !text-lx-text-link")}
      style={style}
    >
      {children}
    </button>
  );
}

interface WikiEditorProps {
  editor: Editor;
}

function WikiEditor({ editor }: WikiEditorProps) {
  const headingLevel = (editor.getAttributes("heading").level as number | undefined) ?? 0;

  return (
    <div className="editor-wrapper flex flex-col flex-1 min-h-0">
      <div className="editor-toolbar wiki-toolbar-host bg-lx-surface-elevated">
        <div className="wiki-toolbar-row">
          <WikiToolbarButton
            command={() => editor.chain().focus().undo().run()}
            isActive={false}
            title="Undo"
          >
            <i className="ph ph-arrow-arc-left" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().redo().run()}
            isActive={false}
            title="Redo"
          >
            <i className="ph ph-arrow-arc-right" />
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleBold().run()}
            isActive={editor.isActive("bold")}
            title="Bold"
          >
            <i className="ph ph-text-b" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleItalic().run()}
            isActive={editor.isActive("italic")}
            title="Italic"
          >
            <i className="ph ph-text-italic" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleUnderline().run()}
            isActive={editor.isActive("underline")}
            title="Underline"
          >
            <i className="ph ph-text-underline" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleStrike().run()}
            isActive={editor.isActive("strike")}
            title="Strike"
          >
            <i className="ph ph-text-strikethrough" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleHighlight().run()}
            isActive={editor.isActive("highlight")}
            title="Highlight"
          >
            <i className="ph ph-highlighter" />
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            isActive={headingLevel === 2}
            title="Heading 2"
          >
            H2
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            isActive={headingLevel === 3}
            title="Heading 3"
          >
            H3
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
            isActive={headingLevel === 4}
            title="Heading 4"
          >
            H4
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleHeading({ level: 5 }).run()}
            isActive={headingLevel === 5}
            title="Heading 5"
          >
            H5
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleBulletList().run()}
            isActive={editor.isActive("bulletList")}
            title="Bullet list"
          >
            <i className="ph ph-list-bullets" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleOrderedList().run()}
            isActive={editor.isActive("orderedList")}
            title="Ordered list"
          >
            <i className="ph ph-list-numbers" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleTaskList().run()}
            isActive={editor.isActive("taskList")}
            title="Task list"
          >
            <i className="ph ph-check-square" />
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleBlockquote().run()}
            isActive={editor.isActive("blockquote")}
            title="Blockquote"
          >
            <i className="ph ph-quotes" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleCodeBlock().run()}
            isActive={editor.isActive("codeBlock")}
            title="Code block"
          >
            <i className="ph ph-code" />
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().setHorizontalRule().run()}
            isActive={false}
            title="Horizontal rule"
          >
            <i className="ph ph-minus" />
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => setLink(editor)}
            isActive={editor.isActive("link")}
            title="Link"
          >
            <i className="ph ph-link" />
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => {}}
            isActive={false}
            title="AI writing assistant"
            style={{ width: "auto", padding: "0 6px", gap: 4 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 10H6a4 4 0 0 1-4-4 1 1 0 0 1 1-1h4" />
              <path d="M7 5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1 7 7 0 0 1-7 7H8a1 1 0 0 1-1-1z" />
              <path d="M9 12v5" />
              <path d="M15 12v5" />
              <path d="M5 20a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3 1 1 0 0 1-1 1H6a1 1 0 0 1-1-1" />
            </svg>
            Forge
          </WikiToolbarButton>
        </div>
      </div>
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
  const [previewContent, setPreviewContent] = useState<TipTapDoc>(emptyDoc);
  const previewTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4, 5] } }),
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

  useEffect(() => {
    if (!editor) return;
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = window.setTimeout(() => {
      setPreviewContent(editor.getJSON() as unknown as TipTapDoc);
    }, 300);
    return () => {
      if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    };
  }, [editor, editor?.state.doc]);

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
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const markDirty = () => {
    setIsDirty(true);
    if (!autosaveEnabled) return;
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      void saveRef.current("autosave");
    }, autosaveDelay);
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
      if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    };
  }, []);

  if (!isEditing) {
    return (
      <div className="wiki-content">
        <div className="wiki-prose">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-lx-text-muted font-body">{breadcrumb}</span>
            <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={handleStartEditing}>
              <Pencil size={14} strokeWidth={1.5} />
              Edit
            </button>
          </div>
          <h1>{page.title}</h1>
          <div>{renderDoc(page.content, "wiki")}</div>
          <div className="mt-8 pt-4 border-t border-lx-border-default">
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
              Last edited {formatRelative(page.updatedAt)}
            </span>
          </div>
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
            {editor && <WikiEditor editor={editor} />}
            <div
              className="flex items-center justify-between"
              style={{
                padding: "8px 12px",
                borderTop: "1px solid var(--lx-border-subtle)",
                background: "var(--lx-bg-surface)",
              }}
            >
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                {lastSavedAt
                  ? formatSavedAt(lastSavedAt)
                  : `Last edited ${formatRelative(lastSavedPage.updatedAt)}`}
              </span>
              {isDirty && (
                <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">
                  Unsaved changes
                </span>
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
