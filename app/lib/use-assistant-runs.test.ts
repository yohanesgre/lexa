// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseAgentToolEvent, recordLiveFloor } from "./use-assistant-runs";

describe("parseAgentToolEvent", () => {
  it("extracts runId + replay from a raw agent-tool-event frame", () => {
    const frame = JSON.stringify({
      type: "agent-tool-event",
      sequence: 4,
      replay: true,
      event: { kind: "chunk", runId: "r1", body: "{}" },
    });
    expect(parseAgentToolEvent(frame)).toEqual({ runId: "r1", replay: true });
  });

  it("treats a missing replay flag as a live frame", () => {
    const frame = JSON.stringify({ type: "agent-tool-event", sequence: 1, event: { kind: "started", runId: "r2" } });
    expect(parseAgentToolEvent(frame)).toEqual({ runId: "r2", replay: false });
  });

  it("ignores other frame types, missing runIds, and non-string data", () => {
    expect(parseAgentToolEvent(JSON.stringify({ type: "cf_agent_state", state: {} }))).toBeNull();
    expect(parseAgentToolEvent(JSON.stringify({ type: "agent-tool-event", event: { kind: "started" } }))).toBeNull();
    expect(parseAgentToolEvent("not json")).toBeNull();
    expect(parseAgentToolEvent(new ArrayBuffer(0))).toBeNull();
  });
});

describe("recordLiveFloor", () => {
  it("pins the replayed-prefix length the first time a run goes live", () => {
    const next = recordLiveFloor({}, "r1", 3);
    expect(next).toEqual({ r1: 3 });
  });

  it("keeps the existing floor on later live frames (no re-pin after reconnect)", () => {
    const prev = { r1: 3 };
    expect(recordLiveFloor(prev, "r1", 7)).toBe(prev);
  });

  it("records each run independently", () => {
    const prev = { r1: 3 };
    expect(recordLiveFloor(prev, "r2", 0)).toEqual({ r1: 3, r2: 0 });
  });
});
