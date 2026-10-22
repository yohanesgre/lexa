import type { MarkdownTarget } from "../editor/MarkdownEditorPane";

function setLink(target: MarkdownTarget) {
  const url = window.prompt("Link URL", "");
  if (url === null || url.trim() === "") return;
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  target.wrap("[", `](${href})`);
}

export function CommentToolbar({ target }: { target: { current: MarkdownTarget | null } }) {
  return (
    <div className="composer-toolbar">
      <button type="button" className="toolbar-btn" title="Bold" aria-label="Bold" onClick={() => target.current?.wrap("**", "**")}>
        <i className="ph ph-text-b" />
      </button>
      <button type="button" className="toolbar-btn" title="Italic" aria-label="Italic" onClick={() => target.current?.wrap("*", "*")}>
        <i className="ph ph-text-italic" />
      </button>
      <button type="button" className="toolbar-btn" title="Bullet list" aria-label="Bullet list" onClick={() => target.current?.prefix("- ")}>
        <i className="ph ph-list-bullets" />
      </button>
      <span className="toolbar-sep" role="separator" aria-hidden="true" />
      <button type="button" className="toolbar-btn" title="Link" aria-label="Link" onClick={() => target.current && setLink(target.current)}>
        <i className="ph ph-link" />
      </button>
      <button type="button" className="toolbar-btn" title="Code block" aria-label="Code block" onClick={() => target.current?.wrap("```\n", "\n```")}>
        <i className="ph ph-code-block" />
      </button>
    </div>
  );
}
