// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseAgentToolEvent } from "./use-assistant-runs";

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
