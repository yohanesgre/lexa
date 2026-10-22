import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { mentionAtCursor } from "./markdown-source-mentions";

describe("source document links", () => {
  it("only completes a caret token outside native Markdown code nodes", () => {
    const stateFor = (doc: string) => EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("@MS") + 3 },
      extensions: [markdown()],
    });
    expect(mentionAtCursor(stateFor("See @MS"))).toEqual({ from: 4, to: 7, query: "MS" });
    for (const doc of ["`@MS`", "````md\n```\n@MS\n````", "    @MS"]) {
      expect(mentionAtCursor(stateFor(doc))).toBeNull();
    }
    const selected = stateFor("See @MS").update({ selection: { anchor: 4, head: 7 } }).state;
    expect(mentionAtCursor(selected)).toBeNull();
  });
});
