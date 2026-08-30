// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import {
  buildMentionSuggestion,
  createMentionExtension,
  fetchMentionItems,
  insertMentionAtRange,
  isValidMentionQuery,
  type MentionItem,
} from "./mention-suggestion";

const API_BODY = {
  data: {
    tasks: [
      { id: "t1", key: "NIM-231", title: "Reconciliation job retries" },
      { id: "t2", key: "NIM-118", title: "Recovery runbook" },
    ],
    wikiPages: [{ id: "w1", slug: "payments-migration", title: "Payments Migration Runbook" }],
  },
};

function mockFetch(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });
}

describe("fetchMentionItems", () => {
  it("maps tasks first then wiki pages with contract labels", async () => {
    vi.stubGlobal("fetch", mockFetch(API_BODY));
    const items = await fetchMentionItems("nimbus", "rec");
    expect(items).toEqual([
      { refType: "task", refId: "t1", label: "NIM-231", sublabel: "Reconciliation job retries" },
      { refType: "task", refId: "t2", label: "NIM-118", sublabel: "Recovery runbook" },
      { refType: "wiki", refId: "payments-migration", label: "Payments Migration Runbook", sublabel: "payments-migration" },
    ]);
    vi.unstubAllGlobals();
  });
});
describe("buildMentionSuggestion", () => {
  it("keys on @ with the configured debounce and passes query through", async () => {
    const fetcher = vi.fn().mockResolvedValue([1, 2].map((i): MentionItem => ({ refType: "task", refId: `${i}`, label: `K-${i}`, sublabel: `s${i}` })));
    const suggestion = buildMentionSuggestion({ slug: "nimbus", debounceMs: 40, fetchMentions: fetcher }) as {
      char: string;
      debounce: number;
      items: (p: { query: string }) => Promise<MentionItem[]>;
      command: (p: { editor: Editor; range: any; props: MentionItem }) => void;
    };
    expect(suggestion.char).toBe("@");
    expect(suggestion.debounce).toBe(40);
    const items = await suggestion.items({ query: "k" });
    expect(fetcher).toHaveBeenCalledWith("nimbus", "k");
    expect(items).toHaveLength(2);
  });
});
describe("createMentionExtension", () => {
  it("registers a mention node storing only contract attrs and rendering chip text", () => {
    const extension = createMentionExtension({ slug: "nimbus", debounceMs: 0 });
    const editor = new Editor({
      extensions: [Document, Paragraph, Text, extension],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "link " },
              { type: "mention", attrs: { refType: "wiki", refId: "api-reference", label: "API Reference" } },
            ],
          },
        ],
      },
    });
    const json = editor.getJSON() as { content: { content: { type: string; attrs?: Record<string, unknown> }[] }[] };
    const mention = json.content[0]!.content!.find((n) => n.type === "mention");
    expect(mention?.attrs).toMatchObject({ refType: "wiki", refId: "api-reference", label: "API Reference" });
    // Editor-side chip markup carries the ref data + @label text.
    const html = editor.getHTML();
    expect(html).toContain('class="mention-chip"');
    expect(html).toContain('data-ref-type="wiki"');
    expect(html).toContain("@API Reference");
    editor.destroy();
  });
});
