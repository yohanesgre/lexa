import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export interface SourceMentionMatch {
  from: number;
  to: number;
  query: string;
}

export function mentionAtCursor(state: EditorState): SourceMentionMatch | null {
  if (!state.selection.main.empty) return null;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const prefix = line.text.slice(0, cursor - line.from);
  const match = /(?:^|[^A-Za-z0-9_-])@([A-Za-z0-9-]*)$/.exec(prefix);
  if (!match || prefix.lastIndexOf("](") > prefix.lastIndexOf(")")) return null;
  const tree = ensureSyntaxTree(state, cursor, 10);
  if (!tree) return null;
  const node = tree.cursorAt(cursor, -1);
  do {
    if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock") return null;
  } while (node.parent());
  const query = match[1]!;
  return { from: cursor - query.length - 1, to: cursor, query };
}
