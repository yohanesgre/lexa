import { useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import type { TipTapDoc } from "../../../shared/types";
import { extractText } from "../../../shared/tiptap-text";
import { textEditorExtensions } from "../../lib/tiptap";
import { useAddComment } from "../../lib/queries";
import { CommentToolbar } from "./CommentToolbar";

// Composer per the wireframe: compact TipTap box, trimmed toolbar
// (bold/italic/bullet/link/code), Enter to comment / Shift+Enter newline,
// Comment disabled while the body is empty.

export function CommentComposer({ slug, taskId }: { slug: string; taskId: string }) {
  const addComment = useAddComment(slug, taskId);
  const [empty, setEmpty] = useState(true);

  const extensions = useMemo(
    () =>
      textEditorExtensions.map((e) =>
        (e as { name?: string } | null)?.name === "placeholder"
          ? Placeholder.configure({ placeholder: "Add a comment…" })
          : e
      ),
    []
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: { type: "doc", content: [] },
    editorProps: {
      attributes: { class: "composer-editor" },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      setEmpty(extractText(ed.getJSON() as TipTapDoc).trim() === "");
    },
  });

  const submit = () => {
    if (!editor || empty || addComment.isPending) return;
    addComment.mutate(editor.getJSON() as TipTapDoc, {
      onSuccess: () => {
        editor.commands.clearContent();
        setEmpty(true);
      },
    });
  };

  if (!editor) return null;

  return (
    <div className="composer">
      <CommentToolbar editor={editor} />
      <EditorContent editor={editor} className="editor-content" />
      <div className="composer-footer">
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Enter to comment · Shift+Enter newline</span>
        <button type="button" className="btn btn-primary btn-sm" disabled={empty || addComment.isPending} onClick={submit}>
          Comment
        </button>
      </div>
    </div>
  );
}
