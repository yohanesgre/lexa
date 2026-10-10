import { describe, expect, it } from "vitest";
import {
  convertLegacyMessage,
  convertLegacyMessages,
  convertStoredMessages,
  legacyFromUIMessages,
  type LegacyStoredMessage,
} from "./legacy-convert";

describe("convertLegacyMessages", () => {
  it("maps a plain user/assistant transcript and preserves order", () => {
    const legacy: LegacyStoredMessage[] = [
      { role: "user", content: "hello", ts: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "hi there", ts: "2026-01-01T00:00:01.000Z" },
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
    ]);
  });

  it("maps array content text parts and drops unmappable parts (image refs)", () => {
    const legacy: LegacyStoredMessage[] = [
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
        parts: [
          { type: "text", text: "look at this" },
          { type: "text", text: "and this" },
        ],
        metadata: { ts: "2026-01-01T00:00:02.000Z" },
      },
    ]);
  });

  it("maps citations onto metadata, sanitizing malformed entries", () => {
    const legacy: LegacyStoredMessage[] = [
      {
        role: "assistant",
        content: "see sources",
        ts: "2026-01-01T00:00:03.000Z",
        citations: [
          { title: "Docs", url: "https://example.com/docs" },
          { title: 42, url: "https://example.com/bad-title" },
          { url: "" },
          { title: "no url" },
        ],
      },
    ];

    expect(convertLegacyMessages(legacy)[0]?.metadata).toEqual({
      ts: "2026-01-01T00:00:03.000Z",
      citations: [
        { title: "Docs", url: "https://example.com/docs" },
        { title: null, url: "https://example.com/bad-title" },
      ],
    });
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

  it("maps a killed turn's `partial` marker onto metadata.stopped (M5b)", () => {
    const converted = convertLegacyMessage({ role: "assistant", content: "half", partial: true }, 3);
    expect(converted).toEqual({
      id: "legacy-3",
      role: "assistant",
      parts: [{ type: "text", text: "half" }],
      metadata: { stopped: true },
    });
  });

  it("keeps a part-less assistant message alive with an empty text part", () => {
    const converted = convertLegacyMessage(
      { role: "assistant", content: "", stopped: true },
      7
    );
    expect(converted).toEqual({
      id: "legacy-7",
      role: "assistant",
      parts: [{ type: "text", text: "" }],
      metadata: { stopped: true },
    });
  });

  it("drops tool/unknown roles and unmappable tool detail", () => {
    const legacy: LegacyStoredMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool output" },
      { role: "assistant", content: "ok" },
      { role: "system", content: "never stored", irrelevant: true },
      { role: "assistant", content: "done", toolLog: [{ name: "search" }], pendingBatch: { batchId: "b1" } },
    ];

    const converted = convertLegacyMessages(legacy);
    expect(converted.map((m) => m.role)).toEqual(["user", "assistant", "system", "assistant"]);
    expect(converted.map((m) => m.id)).toEqual(["legacy-0", "legacy-2", "legacy-3", "legacy-4"]);
    expect(converted[3]).toEqual({
      id: "legacy-4",
      role: "assistant",
      parts: [
        { type: "text", text: "done" },
        { type: "data-assistant-approval", data: { batchId: "b1", approvals: [] } },
      ],
    });
  });

  it("maps a legacy pendingBatch marker to the data-assistant-approval carrier", () => {
    const diff = { type: "task_create", title: "New task", fields: {} };
    const converted = convertLegacyMessages([
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: { batchId: "b7", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task", diff }] },
      },
    ]);
    expect(converted[0]?.parts).toEqual([
      { type: "text", text: "proposed" },
      { type: "data-assistant-approval", data: { batchId: "b7", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task", diff }] } },
    ]);
  });

  it("turns a legacy string pendingBatch into a marker-only carrier", () => {
    const converted = convertLegacyMessages([{ role: "assistant", content: "waiting", pendingBatch: "b-legacy" }]);
    expect(converted[0]?.parts).toEqual([
      { type: "text", text: "waiting" },
      { type: "data-assistant-approval", data: { batchId: "b-legacy", approvals: [] } },
    ]);
  });

  it("restores persisted reasoning as a reasoning part + metadata.reasoningMs", () => {
    const converted = convertLegacyMessages([
      { role: "assistant", content: "answer", reasoning: "thought hard", reasoningMs: 4200 },
    ]);
    expect(converted[0]).toEqual({
      id: "legacy-0",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thought hard" },
        { type: "text", text: "answer" },
      ],
      metadata: { reasoningMs: 4200 },
    });
  });

  it("returns an empty array for empty or non-array input", () => {
    expect(convertLegacyMessages([])).toEqual([]);
    expect(
      convertLegacyMessages([{ role: "tool", content: "x" }, { role: "narrator", content: "y" } as LegacyStoredMessage])
    ).toEqual([]);
  });
});

describe("convertStoredMessages (mixed D1 mirror rows)", () => {
  it("passes parts-shaped rows through verbatim, preserving attachment parts", () => {
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
  });

  it("converts legacy rows and keeps parts-shaped rows in one pass", () => {
    const partsShaped = {
      id: "m2",
      role: "assistant",
      parts: [{ type: "data-assistant-approval", data: { batchId: "b1", approvals: [] } }],
    };
    const out = convertStoredMessages([{ role: "user", content: "legacy" }, partsShaped]);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "legacy-0",
      role: "user",
      parts: [{ type: "text", text: "legacy" }],
    });
    expect(out[1]).toBe(partsShaped);
  });

  it("keeps unmappable legacy rows as inert placeholders and malformed parts-shaped rows verbatim", () => {
    const out = convertStoredMessages([
      { role: "tool", content: "dropped" },
      { role: "assistant", content: "kept" },
      { role: "assistant", parts: [] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: "legacy-0", role: "tool", parts: [] });
    expect(out[1]).toEqual({ id: "legacy-1", role: "assistant", parts: [{ type: "text", text: "kept" }] });
    expect(out[2]).toEqual({ role: "assistant", parts: [] });
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

describe("legacyFromUIMessages (inverse)", () => {
  it("reconstructs pendingBatch from the data-assistant-approval carrier (sweep)", () => {
    const out = legacyFromUIMessages([
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
    expect(out).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "proposed",
        ts: "2026-10-10T00:00:00.000Z",
        pendingBatch: { batchId: "b9", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task" }] },
      },
    ]);
  });

  it("omits pendingBatch when no carrier is present", () => {
    const out = legacyFromUIMessages([{ role: "assistant", parts: [{ type: "text", text: "plain" }] }]);
    expect(out).toEqual([{ role: "assistant", content: "plain" }]);
  });
});
