import { describe, expect, it } from "vitest";
import {
  convertLegacyMessage,
  convertLegacyMessages,
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
    expect(converted[3]).toEqual({ id: "legacy-4", role: "assistant", parts: [{ type: "text", text: "done" }] });
  });

  it("returns an empty array for empty or non-array input", () => {
    expect(convertLegacyMessages([])).toEqual([]);
    expect(
      convertLegacyMessages([{ role: "tool", content: "x" }, { role: "narrator", content: "y" } as LegacyStoredMessage])
    ).toEqual([]);
  });
});
