import { useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import type { CSSProperties } from "react";
import type { TaskComment } from "../../../shared/types";
import { extractText } from "../../../shared/tiptap-text";
import { textEditorExtensions } from "../../lib/tiptap";
import { CommentBody } from "./CommentBody";
import { RobotGlyph } from "./RobotGlyph";

export interface CurrentUser {
  id: string | null;
  email: string | null;
  name: string | null;
  role: string | null;
}

interface CommentCardProps {
  comment: TaskComment;
  members: string[];
  currentUser: CurrentUser;
  onDelete: (commentId: number) => void;
  onUpdate: (commentId: number, body: TaskComment["body"]) => void;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function CommentCard({ comment, members, currentUser, onDelete, onUpdate }: CommentCardProps) {
  const [editing, setEditing] = useState(false);
  const isAgent = comment.authorKind === "agent" || comment.authorKind === "system";
  const isAuthor = !isAgent && comment.authorId !== null && comment.authorId === currentUser.id;
  const canEdit = isAuthor;
  const canDelete = isAuthor || currentUser.role === "admin";
  // Provenance pill (herald-write-approvals.html State 5): comments posted by
  // the add_comment tool. Fixed at creation — later edits keep it. Read
  // defensively; the field rides the API payload when serialized.
  const viaHerald = (comment as { viaHerald?: unknown }).viaHerald === true;

  const extensions = useMemo(
    () =>
      textEditorExtensions.map((e) =>
        (e as { name?: string } | null)?.name === "placeholder"
          ? Placeholder.configure({ placeholder: "Edit comment…" })
          : e
      ),
    []
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: comment.body as unknown as JSONContent,
    editorProps: {
      attributes: { class: "composer-editor" },
    },
  });

  const handleSave = () => {
    if (!editor || extractText(editor.getJSON() as TaskComment["body"]).trim() === "") return;
    onUpdate(comment.id, editor.getJSON() as TaskComment["body"]);
    setEditing(false);
  };

  return (
    <div className="comment-card" style={{ "--marker-center": "24px" } as CSSProperties}>
      {isAgent ? (
        <div className="avatar agent-avatar">
          <RobotGlyph size={12} />
        </div>
      ) : (
        <div className="avatar">{initials(comment.authorLabel)}</div>
      )}
      <div className="comment-content">
        <div className="comment-header">
          {isAgent ? (
            <>
              <span className="agent-tag">
                <RobotGlyph size={10} /> agent
              </span>
              <span className="agent-label">{comment.authorLabel}</span>
            </>
          ) : (
            <span className="comment-author">{comment.authorLabel}</span>
          )}
          <span className="comment-time">{formatTime(comment.createdAt)}</span>
          {viaHerald && <span className="via-pill">via Herald</span>}
          {comment.editedAt && <span className="comment-edited">edited</span>}
          {(canEdit || canDelete) && !editing && (
            <div className="comment-actions">
              {canEdit && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 20, height: 20 }}
                  title="Edit comment"
                  aria-label="Edit comment"
                  onClick={() => setEditing(true)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 20, height: 20 }}
                  title="Delete comment"
                  aria-label="Delete comment"
                  onClick={() => onDelete(comment.id)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
        {editing && editor ? (
          <div className="composer" style={{ marginTop: 6 }}>
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
              <button type="button" className="toolbar-btn" title="Link" aria-label="Link" onClick={() => setEditLink(editor)}>
                <i className="ph ph-link" />
              </button>
              <button type="button" className="toolbar-btn" title="Code block" aria-label="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
                <i className="ph ph-code-block" />
              </button>
            </div>
            <EditorContent editor={editor} className="editor-content" />
            <div className="composer-footer">
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Enter to save · Shift+Enter newline</span>
              <div className="flex items-center gap-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={handleSave}>
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : (
          <CommentBody body={comment.body} members={members} />
        )}
      </div>
    </div>
  );
}

function setEditLink(editor: NonNullable<ReturnType<typeof useEditor>>) {
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
