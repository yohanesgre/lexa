import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentToolEvents } from "agents/react";
import type { AgentToolRunState } from "agents";
import { threadKeyOf } from "./use-assistant-agent";

// Live delegated-run state for the run card (ADR-0004; herald-chat-upgrades.html
// § delegated-run replay). `useAgentToolEvents` reconstructs run state + message
// parts from the child's streamed chunks; the raw `agent-tool-event` frames are
// tapped separately to tell a LIVE frame (this tab) from a REPLAYED one (the DO
// re-sends history on reconnect). Only a run with at least one live frame may
// render its event log — a replayed run shows persisted columns only.
//
// SOCKET OWNERSHIP: this hook never constructs its own `useAgent`. It takes the
// thread's single PartySocket from the caller (`useAssistantAgent`), so a thread
// holds exactly one connection and `useAgentToolEvents` taps the same socket the
// chat stream rides.

const AGENT_TOOL_EVENT_TYPE = "agent-tool-event";

export interface ParsedAgentToolEvent {
  runId: string;
  replay: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Parse one raw socket frame into `{ runId, replay }`, or null when it is not an agent-tool-event. */
export function parseAgentToolEvent(data: unknown): ParsedAgentToolEvent | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const frame = asRecord(parsed);
  if (frame?.type !== AGENT_TOOL_EVENT_TYPE) return null;
  const event = asRecord(frame.event);
  const runId = typeof event?.runId === "string" && event.runId.length > 0 ? event.runId : null;
  if (!runId) return null;
  return { runId, replay: frame.replay === true };
}

// The socket the caller already owns. Structurally `useAgentToolEvents`'
// `AgentToolEventAgent` (Pick<PartySocket, "addEventListener" | "removeEventListener">).
export type AssistantRunAgent = Parameters<typeof useAgentToolEvents>[0]["agent"];

/**
 * Record the replay floor for a run the FIRST time a non-replay frame arrives.
 * `replayedParts` is how many parts `useAgentToolEvents` had already rebuilt
 * from replayed history; those leading parts must not render as this tab's live
 * log. A run already marked live (frames seen live before a reconnect) keeps its
 * existing floor.
 */
export function recordLiveFloor(
  prev: Readonly<Record<string, number>>,
  runId: string,
  replayedParts: number
): Record<string, number> {
  if (prev[runId] !== undefined) return prev as Record<string, number>;
  return { ...prev, [runId]: replayedParts };
}

export interface AssistantRunsLive {
  runsById: Record<string, AgentToolRunState>;
  /** Runs with at least one non-replay frame in THIS tab. */
  liveRunIds: ReadonlySet<string>;
  /**
   * Per run, the number of leading reconstructed `parts` that came from
   * REPLAYED frames — sliced off before rendering the live event log, so a
   * two-tab / reconnected run never shows history it did not see live.
   */
  liveFromByRunId: Readonly<Record<string, number>>;
  resetLocalState(): void;
}

export function useAssistantRunEvents(agent: AssistantRunAgent, key: string | null): AssistantRunsLive {
  const threadKey = threadKeyOf(key);
  const toolEvents = useAgentToolEvents({ agent });

  const [liveRunIds, setLiveRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [liveFromByRunId, setLiveFromByRunId] = useState<Readonly<Record<string, number>>>(() => ({}));

  // Latest committed views for the socket handler (which cannot close over
  // fresh state without re-subscribing on every frame).
  const runsByIdRef = useRef(toolEvents.runsById);
  runsByIdRef.current = toolEvents.runsById;
  const liveRunIdsRef = useRef(liveRunIds);
  liveRunIdsRef.current = liveRunIds;

  useEffect(() => {
    // A new thread is a fresh socket: drop the prior thread's liveness marks.
    setLiveRunIds(new Set());
    setLiveFromByRunId({});
    liveRunIdsRef.current = new Set();
    if (threadKey === null) return;
    const handler = (event: MessageEvent) => {
      const frame = parseAgentToolEvent(event.data);
      if (!frame) return;
      if (frame.replay) return;
      if (!liveRunIdsRef.current.has(frame.runId)) {
        // First non-replay frame: everything already reconstructed for this run
        // is replayed history — pin the floor at today's part count.
        const replayedParts = runsByIdRef.current[frame.runId]?.parts.length ?? 0;
        setLiveFromByRunId((prev) => recordLiveFloor(prev, frame.runId, replayedParts));
      }
      setLiveRunIds((prev) => (prev.has(frame.runId) ? prev : new Set(prev).add(frame.runId)));
    };
    agent.addEventListener("message", handler);
    return () => agent.removeEventListener("message", handler);
  }, [agent, threadKey]);

  return useMemo<AssistantRunsLive>(
    () => ({
      runsById: toolEvents.runsById,
      liveRunIds,
      liveFromByRunId,
      resetLocalState: toolEvents.resetLocalState,
    }),
    [toolEvents.runsById, toolEvents.resetLocalState, liveRunIds, liveFromByRunId]
  );
}
