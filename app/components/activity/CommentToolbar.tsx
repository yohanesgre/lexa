import { useEditor } from "@tiptap/react";

type Editor = NonNullable<ReturnType<typeof useEditor>>;

function setLink(editor: Editor) {
  const previous = editor.getAttributes("link").href as string | undefined;
  const url = window.prompt("Link URL", previous ?? "");
  if (url === null) return;
  if (url.trim() === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

// Shared comment-editor toolbar (bold/italic/bullet/link/code) used by
// CommentComposer and the inline edit mode of CommentCard.
export function CommentToolbar({ editor }: { editor: Editor }) {
  return (
    <div className="composer-toolbar">
      <button type="button" className="toolbar-btn" title="Bold" aria-label="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
        <i className="ph ph-text-b" />
      </button>
      <button type="button" className="toolbar-btn" title="Italic" aria-label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
        <i className="ph ph-text-italic" />
      </button>
      <button type="button" className="toolbar-btn" title="Bullet list" aria-label="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <i className="ph ph-list-bullets" />
      </button>
      <span className="toolbar-sep" role="separator" aria-hidden="true" />
      <button type="button" className="toolbar-btn" title="Link" aria-label="Link" onClick={() => setLink(editor)}>
        <i className="ph ph-link" />
      </button>
      <button type="button" className="toolbar-btn" title="Code block" aria-label="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <i className="ph ph-code-block" />
      </button>
    </div>
  );
}
