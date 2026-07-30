import { useRef, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import type { TipTapDoc } from "../../shared/types";
import { cn } from "./ui/cn";

export const textEditorExtensions = [
  StarterKit.configure({
    heading: { levels: [2, 3, 4, 5] },
    link: { openOnClick: false },
  }),
  Highlight.configure({ multicolor: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: "Start writing..." }),
];

interface TextEditorProps {
  initialContent: TipTapDoc;
  onChange?: (doc: TipTapDoc) => void;
  onBlur?: (doc: TipTapDoc) => void;
  placeholder?: string;
  editable?: boolean;
  editorProps?: Record<string, unknown>;
  className?: string;
  extensions?: typeof textEditorExtensions;
}

export function Toolbar({ editor, headingLevel }: { editor: NonNullable<ReturnType<typeof useEditor>>; headingLevel: number }) {
  return (
    <div className="editor-toolbar wiki-toolbar-host" style={{ borderBottom: "1px solid var(--lx-border-default)", borderRadius: "6px 6px 0 0" }}>
      <div className="wiki-toolbar-row">
        <button type="button" title="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} className="toolbar-btn">
          <i className="ph ph-arrow-arc-left" />
        </button>
        <button type="button" title="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} className="toolbar-btn">
          <i className="ph ph-arrow-arc-right" />
        </button>
        <span className="toolbar-sep" />
        <ToolbarButton command={() => editor.chain().focus().toggleBold().run()} isActive={editor.isActive("bold")} title="Bold">
          <i className="ph ph-text-b" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleItalic().run()} isActive={editor.isActive("italic")} title="Italic">
          <i className="ph ph-text-italic" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleUnderline().run()} isActive={editor.isActive("underline")} title="Underline">
          <i className="ph ph-text-underline" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleStrike().run()} isActive={editor.isActive("strike")} title="Strikethrough">
          <i className="ph ph-text-strikethrough" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHighlight().run()} isActive={editor.isActive("highlight")} title="Highlight">
          <i className="ph ph-highlighter-circle" />
        </ToolbarButton>
        <span className="toolbar-sep" />
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} isActive={headingLevel === 2} title="Heading 2">
          <i className="ph ph-text-h-two" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} isActive={headingLevel === 3} title="Heading 3">
          <i className="ph ph-text-h-three" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 4 }).run()} isActive={headingLevel === 4} title="Heading 4">
          <i className="ph ph-text-h-four" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 5 }).run()} isActive={headingLevel === 5} title="Heading 5">
          <i className="ph ph-text-h-five" />
        </ToolbarButton>
        <span className="toolbar-sep" />
        <ToolbarButton command={() => editor.chain().focus().toggleBulletList().run()} isActive={editor.isActive("bulletList")} title="Bullet list">
          <i className="ph ph-list-bullets" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleOrderedList().run()} isActive={editor.isActive("orderedList")} title="Ordered list">
          <i className="ph ph-list-numbers" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleTaskList().run()} isActive={editor.isActive("taskList")} title="Task list">
          <i className="ph ph-list-checks" />
        </ToolbarButton>
        <span className="toolbar-sep" />
        <ToolbarButton command={() => editor.chain().focus().toggleBlockquote().run()} isActive={editor.isActive("blockquote")} title="Blockquote">
          <i className="ph ph-quotes" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleCodeBlock().run()} isActive={editor.isActive("codeBlock")} title="Code block">
          <i className="ph ph-code-block" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().setHorizontalRule().run()} isActive={false} title="Horizontal rule">
          <i className="ph ph-minus" />
        </ToolbarButton>
        <span className="toolbar-sep" />
        <button type="button" title="Link" onClick={() => { const url = window.prompt("URL"); if (url) editor.chain().focus().setLink({ href: url }).run(); }} className={cn("toolbar-btn", editor.isActive("link") && "active")}>
          <i className="ph ph-link" />
        </button>
        <span className="toolbar-sep" />
        <button type="button" title="AI writing assistant" className="toolbar-btn">
          <i className="ph ph-hammer" style={{ fontSize: 16 }} />
          Forge
        </button>
      </div>
    </div>
  );
}

function ToolbarButton({
  command,
  isActive,
  title,
  children,
}: {
  command: () => void;
  isActive: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={command}
      className={cn("toolbar-btn", isActive && "active")}
    >
      {children}
    </button>
  );
}

export function TextEditor({
  initialContent,
  onChange,
  onBlur,
  placeholder,
  editable = true,
  editorProps,
  className,
  extensions,
}: TextEditorProps) {
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const finalExtensions = useMemo(() => {
    const base = extensions ?? textEditorExtensions;
    if (!placeholder) return base;
    return base.map((e: any) => {
      if (typeof e === "object" && (e as any)?.name === "placeholder") {
        return Placeholder.configure({ placeholder });
      }
      return e;
    });
  }, [extensions, placeholder]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: finalExtensions,
    content: initialContent as unknown as JSONContent,
    editable,
    editorProps,
    onUpdate: ({ editor: nextEditor }) => {
      onChangeRef.current?.(nextEditor.getJSON() as unknown as TipTapDoc);
    },
    onBlur: ({ editor: ed }) => {
      onBlurRef.current?.(ed.getJSON() as unknown as TipTapDoc);
    },
  });

  if (!editor) return null;

  const headingLevel = (editor.getAttributes("heading").level as number | undefined) ?? 0;

  return (
    <div className={cn("editor-wrapper", className)}>
      <Toolbar editor={editor} headingLevel={headingLevel} />
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}
