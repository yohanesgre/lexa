import { describe, expect, it } from "vitest";
import {
  convertLegacyMessages,
  convertStoredMessages,
  legacyFromUIMessages,
  type LegacyStoredMessage,
} from "./legacy-convert";

describe("convertLegacyMessages", () => {
  it("maps a plain transcript and array content text parts, preserving order and carrying sent attachments", () => {
    const legacy: LegacyStoredMessage[] = [
      { role: "user", content: "hello", ts: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "hi there", ts: "2026-01-01T00:00:01.000Z" },
      {
        role: "user",
        content: [
          { type: "text", content: "look at this" },
          { type: "image-ref", storageKey: "blob-1", mimeType: "image/png" },
          { type: "text", content: "and this" },
        ],
        ts: "2026-01-01T00:00:02.000Z",
      },
    ];

    expect(convertLegacyMessages(legacy)).toEqual([
      {
        id: "legacy-0",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        metadata: { ts: "2026-01-01T00:00:00.000Z" },
      },
      {
        id: "legacy-1",
        role: "assistant",
        parts: [{ type: "text", text: "hi there" }],
        metadata: { ts: "2026-01-01T00:00:01.000Z" },
      },
      {
        id: "legacy-2",
        role: "user",
        parts: [
          { type: "text", text: "look at this" },
          { type: "text", text: "and this" },
          { type: "data-attachment", data: { storageKey: "blob-1", mimeType: "image/png", name: "" } },
        ],
        metadata: { ts: "2026-01-01T00:00:02.000Z" },
      },
    ]);
  });

  // The report this fixes: the API read dropped sent documents, so the user's
  // bubble showed the text with no file chip while the model had read the PDF.
  it("keeps a sent document as an attachment part", () => {
    const legacy: LegacyStoredMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", content: "insert overview from pdf" },
          { type: "document-ref", storageKey: "blob-pdf", mimeType: "application/pdf", name: "GDD.pdf" },
        ],
      },
    ];
    expect(convertLegacyMessages(legacy)[0]?.parts).toEqual([
      { type: "text", text: "insert overview from pdf" },
      { type: "data-attachment", data: { storageKey: "blob-pdf", mimeType: "application/pdf", name: "GDD.pdf" } },
    ]);
  });

  it("maps error and stopped markers onto metadata", () => {
    const legacy: LegacyStoredMessage[] = [
      { role: "assistant", content: "partial", error: { code: "PROVIDER_UNREACHABLE", message: "upstream down" } },
      { role: "assistant", content: "cut short", stopped: true },
      { role: "assistant", content: "no code", error: { message: "boom" } },
    ];

    expect(convertLegacyMessages(legacy).map((m) => m.metadata)).toEqual([
      { error: { code: "PROVIDER_UNREACHABLE", message: "upstream down" } },
      { stopped: true },
      { error: { code: "ASSISTANT_GENERATION_FAILED", message: "boom" } },
    ]);
  });

  it("maps a legacy pendingBatch marker — object or bare string — to the data-assistant-approval carrier", () => {
    const diff = { type: "task_create", title: "New task", fields: {} };
    const objectCarrier = convertLegacyMessages([
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: { batchId: "b7", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task", diff }] },
      },
    ]);
    expect(objectCarrier[0]?.parts).toEqual([
      { type: "text", text: "proposed" },
      { type: "data-assistant-approval", data: { batchId: "b7", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task", diff }] } },
    ]);

    const stringCarrier = convertLegacyMessages([{ role: "assistant", content: "waiting", pendingBatch: "b-legacy" }]);
    expect(stringCarrier[0]?.parts).toEqual([
      { type: "text", text: "waiting" },
      { type: "data-assistant-approval", data: { batchId: "b-legacy", approvals: [] } },
    ]);
  });
});

describe("convertStoredMessages (mixed D1 mirror rows)", () => {
  it("passes parts-shaped rows through verbatim (attachment parts preserved) and the inverse sweep rebuilds pendingBatch", () => {
    const partsShaped = {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "see file" },
        { type: "data-attachment", data: { storageKey: "blob-1", mimeType: "image/png", name: "shot.png" } },
      ],
    };

    const out = convertStoredMessages([partsShaped]);
    expect(out).toEqual([partsShaped]);
    // identity, not a copy — the attachment part must survive untouched
    expect(out[0]).toBe(partsShaped);

    // legacyFromUIMessages (the inverse sweep) reconstructs pendingBatch from
    // the data-assistant-approval carrier.
    const inverse = legacyFromUIMessages([
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "proposed" },
          { type: "data-assistant-approval", data: { batchId: "b9", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task" }] } },
        ],
        metadata: { ts: "2026-10-10T00:00:00.000Z" },
      },
    ]);
    expect(inverse).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "proposed",
        ts: "2026-10-10T00:00:00.000Z",
        pendingBatch: { batchId: "b9", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task" }] },
      },
    ]);
  });

  it("is length-preserving so a tool row before the target keeps every later position", () => {
    const out = convertStoredMessages([
      { role: "user", content: "q0" },
      { role: "tool", content: "raw wire" },
      { role: "user", content: "q1" },
    ]) as Array<{ role?: string; parts?: unknown[] }>;
    expect(out).toHaveLength(3);
    expect(out[1]!.role).toBe("tool");
    expect(out[1]!.parts).toEqual([]);
    // The client resolves its resend index against this array; the trailing
    // user turn must stay at the same index the server will truncate at.
    expect(out[2]).toEqual({ id: "legacy-2", role: "user", parts: [{ type: "text", text: "q1" }] });
  });
});

// A transcript-loaded turn must show the tools it ran (the persisted `toolLog`
// carries them; before this mapping the read dropped it and every reloaded turn
// rendered as pure thinking).
describe("convertLegacyMessages tool log", () => {
  it("rebuilds each persisted call as an input-available tool part, in log order", () => {
    const converted = convertLegacyMessages([
      { role: "assistant", content: "done", toolLog: [{ name: "search_wiki", detail: 'Searching wiki for "x"' }, { name: "read_wiki_page" }] },
    ]);
    expect(converted[0]?.parts).toEqual([
      { type: "text", text: "done" },
      { type: "tool-search_wiki", toolCallId: "legacy-0-tool-0", state: "input-available", input: { detail: 'Searching wiki for "x"' } },
      { type: "tool-read_wiki_page", toolCallId: "legacy-0-tool-1", state: "input-available", input: {} },
    ]);
  });

  it("reads the older `toolCalls` spelling and keeps the inverse sweep lossless", () => {
    const converted = convertLegacyMessages([{ role: "assistant", content: "", toolCalls: [{ name: "edit_wiki_page", detail: "Editing page" }] }]);
    expect(legacyFromUIMessages(converted)).toEqual([
      { role: "assistant", content: "", toolLog: [{ name: "edit_wiki_page", detail: "Editing page" }] },
    ]);
  });
});
