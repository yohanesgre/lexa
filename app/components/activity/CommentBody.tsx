import { isMarkdownEmpty } from "../../../shared/markdown";
import { MarkdownContent } from "../MarkdownContent";
import { renderCommentText } from "../../lib/mention";

export function CommentBody({ body, members }: { body: string; members: string[] }) {
  if (isMarkdownEmpty(body)) return null;
  return (
    <div className="comment-text">
      <MarkdownContent md={body} surface="comment" renderText={(text) => renderCommentText(text, members)} />
    </div>
  );
}
