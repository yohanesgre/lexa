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
      className={cn("toolbar-btn", isActive && "active")}
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
    <div className="editor-wrapper">
      <div className="editor-toolbar wiki-toolbar-host">
        <div className="wiki-toolbar-row">
          <WikiToolbarButton
            command={() => editor.chain().focus().undo().run()}
            isActive={false}
            title="Undo"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 14L4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().redo().run()}
            isActive={false}
            title="Redo"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M15 14l5-5-5-5" />
              <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" />
            </svg>
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleBold().run()}
            isActive={editor.isActive("bold")}
            title="Bold"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 12a4 4 0 0 0 0-8H6v8" />
              <path d="M15 20a4 4 0 0 0 0-8H6v8Z" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleItalic().run()}
            isActive={editor.isActive("italic")}
            title="Italic"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="19" y1="4" x2="10" y2="4" />
              <line x1="14" y1="20" x2="5" y2="20" />
              <line x1="15" y1="4" x2="9" y2="20" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleUnderline().run()}
            isActive={editor.isActive("underline")}
            title="Underline"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
              <line x1="4" y1="21" x2="20" y2="21" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleStrike().run()}
            isActive={editor.isActive("strike")}
            title="Strike"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M17.3 19c-1.4 1.4-3.3 2-5.3 2-4.4 0-8-2.7-8-6 0-1.3.5-2.5 1.4-3.5" />
              <path d="M14.6 5c1.4-1.4 3.2-2 5.1-2 4.4 0 8 2.7 8 6 0 1.4-.6 2.6-1.6 3.6" />
              <line x1="4" y1="12" x2="20" y2="12" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleHighlight().run()}
            isActive={editor.isActive("highlight")}
            title="Highlight"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 11l-6 6v3h9l3-3" />
              <path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
              <path d="M17 3l4 4" />
            </svg>
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            isActive={headingLevel === 1}
            title="Heading 1"
          >
            H1
          </WikiToolbarButton>
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
        </div>
        <div className="wiki-toolbar-row">
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleBulletList().run()}
            isActive={editor.isActive("bulletList")}
            title="Bullet list"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleOrderedList().run()}
            isActive={editor.isActive("orderedList")}
            title="Ordered list"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="10" y1="6" x2="21" y2="6" />
              <line x1="10" y1="12" x2="21" y2="12" />
              <line x1="10" y1="18" x2="21" y2="18" />
              <path d="M4 6h1v4" />
              <path d="M4 10h2" />
              <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleTaskList().run()}
            isActive={editor.isActive("taskList")}
            title="Task list"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 17l2 2 4-4" />
              <path d="M3 7l2 2 4-4" />
              <line x1="13" y1="6" x2="21" y2="6" />
              <line x1="13" y1="12" x2="21" y2="12" />
              <line x1="13" y1="18" x2="21" y2="18" />
            </svg>
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleBlockquote().run()}
            isActive={editor.isActive("blockquote")}
            title="Blockquote"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21c0 1 0 1 1 1z" />
              <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().toggleCodeBlock().run()}
            isActive={editor.isActive("codeBlock")}
            title="Code block"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
              <line x1="12" y1="2" x2="12" y2="4" />
              <line x1="12" y1="20" x2="12" y2="22" />
            </svg>
          </WikiToolbarButton>
          <WikiToolbarButton
            command={() => editor.chain().focus().setHorizontalRule().run()}
            isActive={false}
            title="Horizontal rule"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </WikiToolbarButton>
          <span className="toolbar-sep" />
          <WikiToolbarButton
            command={() => setLink(editor)}
            isActive={editor.isActive("link")}
            title="Link"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </WikiToolbarButton>
        </div>
      </div>
      <EditorContent editor={editor} className="editor-content" />
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

  const parent = page.parentId ? pages.find((p) => p.id === page.parentId) : null;
  const parentPath = parent ? `${parent.slug}/` : "";
  const initialSlugSegment = page.slug.slice(parentPath.length);

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [slugSegment, setSlugSegment] = useState(initialSlugSegment);
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

  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave", String(autosaveEnabled));
  }, [autosaveEnabled]);

  useEffect(() => {
    window.localStorage.setItem("lexa-wiki-autosave-delay", String(autosaveDelay));
  }, [autosaveDelay]);

  const editorRef = useRef<Editor | null>(null);
  const titleRef = useRef(title);
  const slugSegmentRef = useRef(slugSegment);
  const autosaveTimer = useRef<number | null>(null);
  const markDirtyRef = useRef<() => void>(() => {});

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    slugSegmentRef.current = slugSegment;
  }, [slugSegment]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
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
  });

  useEffect(() => {
    editorRef.current = editor ?? null;
  }, [editor]);

  const breadcrumb = buildAncestors(pages, page)
    .map((a) => a.title)
    .concat(page.title)
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
        slug: `${parentPath}${slugSegmentRef.current}`,
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
    setSlugSegment(initialSlugSegment);
    setLastSavedPage(page);
    setLastSavedAt(null);
    setIsDirty(false);
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
    setSlugSegment(lastSavedPage.slug.slice(parentPath.length));
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
      <div className="wiki-edit-main">
        <div className="max-w-wiki-content mx-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-lx-text-muted font-body">{breadcrumb}</span>
              <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">Editing</span>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-ghost" onClick={handleCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          <input
            className="wiki-title-input"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              markDirty();
            }}
            placeholder="Page title"
          />

          <div className="wiki-slug-row">
            <span className="prop-label shrink-0">Slug</span>
            <div className="wiki-slug-input">
              <span className="wiki-slug-prefix">/wiki/{parentPath}</span>
              <input
                className="wiki-slug-segment"
                value={slugSegment}
                onChange={(e) => {
                  setSlugSegment(e.target.value);
                  markDirty();
                }}
                placeholder="page-slug"
              />
            </div>
          </div>

          {editor && <WikiEditor editor={editor} />}

          <div className="wiki-edit-footer">
            <span className="save-indicator text-lx-text-muted">
              {lastSavedAt ? formatSavedAt(lastSavedAt) : `Last edited ${formatRelative(lastSavedPage.updatedAt)}`}
            </span>
            {isDirty && (
              <span className="save-indicator text-lx-text-warning">Unsaved changes</span>
            )}
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
      />
    </div>
  );
}
