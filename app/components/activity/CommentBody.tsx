import type { TipTapDoc } from "../../../shared/types";
import { cn } from "../ui/cn";
import { hasText } from "../tiptap-render";
import { renderCommentBody } from "../../lib/mention";
import { TTNode } from "../tiptap-render";

// Comment body rendering: the doc-walk + mention splitting lives in
// app/lib/mention.tsx (renderCommentBody); this component owns only the
// wrapper element and the empty-doc guard.

export function CommentBody({ body, members }: { body: TipTapDoc; members: string[] }) {
  const nodes = body.content as TTNode[];
  if (!hasText(nodes ?? [])) return null;
  return <div className={cn("comment-text")}>{renderCommentBody(body, members)}</div>;
}
