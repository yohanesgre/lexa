import { describe, expect, it } from "vitest";
import {
  needsSummary,
  summaryWindow,
  SUMMARY_THRESHOLD_BYTES,
  SUMMARY_THRESHOLD_MESSAGES,
  SUMMARY_WINDOW,
} from "./summarize";

function msg(i: number): { id: string; role: "user" | "assistant"; parts: Array<{ type: "text"; text: string }> } {
  return {
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `message ${i}` }],
  };
}

function many(count: number): ReturnType<typeof msg>[] {
  return Array.from({ length: count }, (_, i) => msg(i));
}

describe("needsSummary", () => {
  it("is false under both thresholds and true past the message threshold", () => {
    expect(needsSummary(many(SUMMARY_THRESHOLD_MESSAGES))).toBe(false);
    expect(needsSummary(many(SUMMARY_THRESHOLD_MESSAGES + 1))).toBe(true);
  });

  it("triggers on the byte threshold for a small-but-large transcript", () => {
    const big = [{ id: "m", role: "user", parts: [{ type: "text", text: "x".repeat(SUMMARY_THRESHOLD_BYTES + 1) }] }];
    expect(needsSummary(big)).toBe(true);
  });

  it("measures UTF-8 bytes, not UTF-16 code units, for the byte threshold", () => {
    // 16_384 four-byte emoji = 65_536 UTF-8 bytes but only 32_768 code units,
    // so a `JSON.stringify(...).length` check would miss it.
    const text = "😀".repeat(16_384);
    const msg = [{ id: "m", role: "user", parts: [{ type: "text", text }] }];
    expect(JSON.stringify(msg).length).toBeLessThanOrEqual(SUMMARY_THRESHOLD_BYTES);
    expect(needsSummary(msg)).toBe(true);
  });
});

describe("summaryWindow", () => {
  it("returns null under threshold or when the window is already summarized", () => {
    expect(summaryWindow(many(10), 0)).toBeNull();
    expect(summaryWindow(many(41), 33)).toBeNull();
    expect(summaryWindow(many(41), 40)).toBeNull();
  });

  it("slides only the not-yet-summarized prefix and reports the new total", () => {
    const window = summaryWindow(many(41), 0);
    expect(window?.older).toHaveLength(41 - SUMMARY_WINDOW);
    expect(window?.summarizedCount).toBe(41 - SUMMARY_WINDOW);
    const incremental = summaryWindow(many(42), 33);
    expect(incremental?.older).toHaveLength(1);
    expect(incremental?.summarizedCount).toBe(34);
  });

  it("is idempotent: a repeat of the same transcript yields no window", () => {
    const window = summaryWindow(many(41), 0);
    expect(window).not.toBeNull();
    expect(summaryWindow(many(41), window!.summarizedCount)).toBeNull();
  });
});
