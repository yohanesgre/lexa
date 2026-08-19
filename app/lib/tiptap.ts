// Editor extensions shared by the task and wiki editors. Lives outside the
// component file so the config export doesn't break component-file hygiene.
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import Placeholder from "@tiptap/extension-placeholder";

export const textEditorExtensions = [
  StarterKit.configure({
    heading: { levels: [2, 3, 4, 5] },
    link: { openOnClick: false },
    code: false,
  }),
  // StarterKit's code mark excludes all other marks (bold+code is invalid
  // in the schema), but valid CommonMark like **`code`** produces exactly
  // that combination — and Forge results routinely contain it. Without this,
  // accepting such a result throws and the review panel is stuck open.
  Code.extend({ excludes: "" }),
  Underline,
  Highlight.configure({ multicolor: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Image.configure({
    // Image URLs flow through the same scheme allowlist as links; inline
    // allows `text ![alt](src)` to produce an inline image node.
    inline: true,
    allowBase64: false,
  }),
  Table.configure({
    resizable: false,
  }),
  TableRow,
  TableHeader,
  TableCell,
  Placeholder.configure({ placeholder: "Start writing..." }),
];
