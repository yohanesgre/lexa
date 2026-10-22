import { describe, expect, it } from "vitest";
import {
  assertChatAttachmentCaps,
  capDocumentText,
  CHAT_ATTACHMENT_CAPS,
  DOCUMENT_TEXT_MAX_CHARS,
  extractDocumentText,
  hasAssistantWriteIntent,
  modelOptionsWithWriteIntent,
} from "./assistant-helpers";
import { WRITE_INTENT_RE } from "../assistant/build-stream";

const positives = [
  "can you remove all tasks?",
  "delete task X",
  "please remove the task",
  "hapus semua task",
  "create a milestone called v2",
  "tambah sprint",
  "update the wiki page",
];

const negatives = [
  "how many tasks are there?",
  "what tasks are in the backlog?",
  "what is the status of the wiki page?",
  "show me the board",
  "",
];

describe("assistant write intent", () => {
  it("matches delete/remove phrasing but not read-only questions, in both single-sourced regexes", () => {
    for (const message of positives) {
      expect(hasAssistantWriteIntent(message), message).toBe(true);
      expect(WRITE_INTENT_RE.test(message), message).toBe(true);
    }
    for (const message of negatives) {
      expect(hasAssistantWriteIntent(message), message).toBe(false);
      expect(WRITE_INTENT_RE.test(message), message).toBe(false);
    }
  });

  it("requires a tool call only when writes are enabled and intent matches", () => {
    expect(modelOptionsWithWriteIntent(undefined, "can you remove all tasks?", ["delete_task"]))
      .toEqual({ tool_choice: "required" });
    expect(modelOptionsWithWriteIntent({ reasoning_effort: "low" }, "delete task X", ["delete_task"]))
      .toEqual({ reasoning_effort: "low", tool_choice: "required" });
    expect(modelOptionsWithWriteIntent(undefined, "how many tasks are there?", ["delete_task"]))
      .toBeUndefined();
    expect(modelOptionsWithWriteIntent(undefined, "can you remove all tasks?", []))
      .toBeUndefined();
  });
});

const MB = 1024 * 1024;

// TaggedError#message is empty by design — the reason lives on the field. Assert
// on the typed error, not its Error message.
function capReason(refs: Array<{ mimeType: string; size: number; name: string }>): string | null {
  try {
    assertChatAttachmentCaps(refs);
    return null;
  } catch (e) {
    return (e as { reason?: string }).reason ?? null;
  }
}

describe("assertChatAttachmentCaps (D4)", () => {
  const ok = { mimeType: "text/plain", size: 10, name: "a.txt" };

  it("accepts an empty and an at-limit list; rejects a 4th (images + documents share the count)", () => {
    expect(capReason([])).toBeNull();
    expect(capReason([ok, ok, ok])).toBeNull();
    expect(capReason([ok, ok, ok, ok])).toBe(`at most ${CHAT_ATTACHMENT_CAPS.maxCount} attachments per message`);
  });

  it("names the file and the limit on type, empty, per-file, and message-total violations", () => {
    expect(capReason([{ mimeType: "image/svg+xml", size: 10, name: "logo.svg" }]))
      .toBe("unsupported file type image/svg+xml for 'logo.svg'");
    expect(capReason([{ mimeType: "text/plain", size: 0, name: "empty.txt" }]))
      .toBe("file 'empty.txt' is empty");
    expect(capReason([{ mimeType: "application/pdf", size: 5 * MB + 1, name: "big.pdf" }]))
      .toBe("file 'big.pdf' exceeds the 5 MB limit");
    const big = { mimeType: "application/pdf", size: 4 * MB, name: "doc.pdf" };
    expect(capReason([big, big, big])).toBe("attachments exceed the 10 MB request limit");
  });
});


describe("extractDocumentText", () => {
  it("decodes Markdown and plain text directly", async () => {
    expect(await extractDocumentText(new TextEncoder().encode("# Title\n\nbody"), "text/markdown", "notes.md"))
      .toBe("# Title\n\nbody");
    expect(await extractDocumentText(new TextEncoder().encode("just words"), "text/plain", "notes.txt"))
      .toBe("just words");
  });

  it("converts supported binary documents through the managed binding", async () => {
    const binding = {
      toMarkdown: async (files: Array<{ name: string; blob: Blob }>) => {
        expect(files[0]?.name).toBe("report.pdf");
        expect(files[0]?.blob.type).toBe("application/pdf");
        return { format: "markdown" as const, data: "# Hello PDF", name: "report.pdf", mimetype: "application/pdf", id: "1" };
      },
    };
    expect(await extractDocumentText(new Uint8Array([1, 2, 3]), "application/pdf", "report.pdf", binding))
      .toBe("# Hello PDF");
  });

  it("returns null on unreadable bytes, unavailable conversion, and unsupported types", async () => {
    expect(await extractDocumentText(new TextEncoder().encode("not a pdf"), "application/pdf", "bad.pdf")).toBeNull();
    expect(await extractDocumentText(new Uint8Array([0xff, 0xfe, 0x00]), "text/markdown", "bad.md")).toBeNull();
    expect(await extractDocumentText(new TextEncoder().encode("x"), "image/png", "image.png")).toBeNull();
  });
});


describe("capDocumentText", () => {
  it("leaves text at or under the limit untouched", () => {
    expect(capDocumentText("hello")).toBe("hello");
    const atLimit = "x".repeat(DOCUMENT_TEXT_MAX_CHARS);
    expect(capDocumentText(atLimit)).toBe(atLimit);
  });

  it("truncates over-limit text with an explicit omitted-char marker", () => {
    const capped = capDocumentText("a".repeat(DOCUMENT_TEXT_MAX_CHARS + 7));
    expect(capped.startsWith("a".repeat(DOCUMENT_TEXT_MAX_CHARS))).toBe(true);
    expect(capped.endsWith("…[truncated: 7 chars omitted]")).toBe(true);
  });

  it("caps markdown extraction at the limit", async () => {
    const text = await extractDocumentText(new TextEncoder().encode("b".repeat(DOCUMENT_TEXT_MAX_CHARS + 3)), "text/markdown", "long.md");
    expect(text).not.toBeNull();
    expect(text!.endsWith("…[truncated: 3 chars omitted]")).toBe(true);
  });
});
