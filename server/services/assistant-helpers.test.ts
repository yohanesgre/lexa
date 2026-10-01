import { describe, expect, it } from "vitest";
import {
  ASSISTANT_WRITE_INTENT_RE,
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
  it("matches delete/remove phrasing in both single-sourced regexes", () => {
    for (const message of positives) {
      expect(hasAssistantWriteIntent(message), message).toBe(true);
      expect(WRITE_INTENT_RE.test(message), message).toBe(true);
    }
  });

  it("does not match read-only questions", () => {
    for (const message of negatives) {
      expect(hasAssistantWriteIntent(message), message).toBe(false);
      expect(WRITE_INTENT_RE.test(message), message).toBe(false);
    }
  });

  it("single-sources the build-stream guard regex with the gating regex", () => {
    expect(WRITE_INTENT_RE).toBe(ASSISTANT_WRITE_INTENT_RE);
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

  it("accepts an empty and an at-limit list", () => {
    expect(capReason([])).toBeNull();
    expect(capReason([ok, ok, ok])).toBeNull();
  });

  it("rejects a 4th attachment (images + documents share the count)", () => {
    expect(capReason([ok, ok, ok, ok])).toBe(`at most ${CHAT_ATTACHMENT_CAPS.maxCount} attachments per message`);
  });

  it("names the file and the limit on type, empty, and per-file size violations", () => {
    expect(capReason([{ mimeType: "image/svg+xml", size: 10, name: "logo.svg" }]))
      .toBe("unsupported file type image/svg+xml for 'logo.svg'");
    expect(capReason([{ mimeType: "text/plain", size: 0, name: "empty.txt" }]))
      .toBe("file 'empty.txt' is empty");
    expect(capReason([{ mimeType: "application/pdf", size: 5 * MB + 1, name: "big.pdf" }]))
      .toBe("file 'big.pdf' exceeds the 5 MB limit");
  });

  it("rejects a message total over 10 MB even when each file is under the per-file cap", () => {
    const big = { mimeType: "application/pdf", size: 4 * MB, name: "doc.pdf" };
    expect(capReason([big, big, big])).toBe("attachments exceed the 10 MB request limit");
  });
});

// Minimal single-page PDF (Helvetica text object) with a correctly offset xref
// table — enough for pdfjs/unpdf to parse and extract the text.
function buildPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("extractDocumentText", () => {
  it("decodes markdown and plain text directly", async () => {
    expect(await extractDocumentText(new TextEncoder().encode("# Title\n\nbody"), "text/markdown"))
      .toBe("# Title\n\nbody");
    expect(await extractDocumentText(new TextEncoder().encode("just words"), "text/plain"))
      .toBe("just words");
  });

  it("extracts text from a PDF via unpdf", async () => {
    const text = await extractDocumentText(buildPdf("Hello PDF world"), "application/pdf");
    expect(text).toContain("Hello PDF world");
  });

  it("returns null on unreadable bytes and unsupported types", async () => {
    expect(await extractDocumentText(new TextEncoder().encode("not a pdf"), "application/pdf")).toBeNull();
    expect(await extractDocumentText(new Uint8Array([0xff, 0xfe, 0x00]), "text/markdown")).toBeNull();
    expect(await extractDocumentText(new TextEncoder().encode("x"), "image/png")).toBeNull();
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
    const text = await extractDocumentText(new TextEncoder().encode("b".repeat(DOCUMENT_TEXT_MAX_CHARS + 3)), "text/markdown");
    expect(text).not.toBeNull();
    expect(text!.endsWith("…[truncated: 3 chars omitted]")).toBe(true);
  });
});
