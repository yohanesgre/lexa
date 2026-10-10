import { describe, expect, it } from "vitest";
import { sweepDoTranscripts, threadKeyFor, type SweepDeps, type SweepTranscript } from "../../scripts/sweep-do-transcripts";

// ADR-0005 W4b: the pre-cutover DO sweep imports DO-only tails into D1,
// idempotently, and keeps going on a per-thread failure.

function deps(overrides: Partial<SweepDeps>): { deps: SweepDeps; writes: unknown[]; warns: string[] } {
  const writes: unknown[] = [];
  const warns: string[] = [];
  const base: SweepDeps = {
    listThreads: async () => [],
    getTranscript: async () => null,
    writeTranscript: async (input) => {
      writes.push(input);
    },
    log: (level, message) => {
      if (level === "WARN") warns.push(message);
    },
  };
  return { deps: { ...base, ...overrides }, writes, warns };
}

const parts = (n: number): SweepTranscript => ({
  messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", parts: [{ type: "text", text: `m${i}` }] })),
  summary: null,
  summarizedCount: null,
  permissionMode: "ask",
});

describe("sweepDoTranscripts", () => {
  it("imports only threads whose DO transcript is longer than D1, skipping the rest", async () => {
    const { deps: d, writes } = deps({
      listThreads: async () => [
        { documentType: "chat", documentId: "tail", projectId: "p1", messages: JSON.stringify([{ role: "user", content: "one" }]) },
        { documentType: "chat", documentId: "drained", projectId: "p1", messages: JSON.stringify([1, 2, 3]) },
      ],
      getTranscript: async (key) => (key === threadKeyFor("chat", "tail") ? parts(3) : parts(3)),
    });
    const report = await sweepDoTranscripts(d);
    expect(report).toEqual({ scanned: 2, imported: 1, skipped: 1, failed: 0 });
    expect(writes).toHaveLength(1);
    expect((writes[0] as { documentId: string; messages: unknown[] }).documentId).toBe("tail");
    expect((writes[0] as { messages: unknown[] }).messages).toHaveLength(3);
  });

  it("is idempotent: a second run over the same state imports nothing", async () => {
    const rows = [{ documentType: "chat", documentId: "tail", projectId: "p1", messages: JSON.stringify([{ role: "user", content: "one" }]) }];
    const { deps: d, writes } = deps({ listThreads: async () => rows, getTranscript: async () => parts(3) });
    const first = await sweepDoTranscripts(d);
    expect(first.imported).toBe(1);
    // After the write, D1 holds the DO tail; model that by returning the written rows.
    const written = (writes[0] as { messages: unknown[] }).messages;
    const { deps: d2, writes: writes2 } = deps({
      listThreads: async () => [{ ...rows[0]!, messages: JSON.stringify(written) }],
      getTranscript: async () => parts(3),
    });
    const second = await sweepDoTranscripts(d2);
    expect(second).toEqual({ scanned: 1, imported: 0, skipped: 1, failed: 0 });
    expect(writes2).toHaveLength(0);
  });

  it("logs and continues on a per-thread failure; null transcript is a skip", async () => {
    const { deps: d, writes, warns } = deps({
      listThreads: async () => [
        { documentType: "chat", documentId: "boom", projectId: "p1", messages: "[]" },
        { documentType: "task", documentId: "never-ran", projectId: "p1", messages: "[]" },
        { documentType: "chat", documentId: "tail", projectId: "p1", messages: "[]" },
      ],
      getTranscript: async (key) => {
        if (key === threadKeyFor("chat", "boom")) throw new Error("DO unreachable");
        if (key === threadKeyFor("task", "never-ran")) return null;
        return parts(2);
      },
    });
    const report = await sweepDoTranscripts(d);
    expect(report).toEqual({ scanned: 3, imported: 1, skipped: 1, failed: 1 });
    expect(warns).toEqual(["do-sweep thread failed"]);
    expect(writes).toHaveLength(1);
  });
});
