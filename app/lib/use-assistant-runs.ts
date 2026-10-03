import { useEffect, useMemo, useState } from "react";
import { useAgent, useAgentToolEvents } from "agents/react";
import type { AgentToolRunState } from "agents";
import { threadKeyOf } from "./use-assistant-agent";

// Live delegated-run state for the run card (ADR-0004; herald-chat-upgrades.html
// § delegated-run replay). `useAgentToolEvents` reconstructs run state + message
// parts from the child's streamed chunks; the raw `agent-tool-event` frames are
// tapped separately to tell a LIVE frame (this tab) from a REPLAYED one (the DO
// re-sends history on reconnect). Only a run with at least one live frame may
// render its event log — a replayed run shows persisted columns only.

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

export interface AssistantRunsLive {
  runsById: Record<string, AgentToolRunState>;
  /** Runs with at least one non-replay frame in THIS tab. */
  liveRunIds: ReadonlySet<string>;
  /** Runs observed only as replayed frames (reload / another tab). */
  replayedRunIds: ReadonlySet<string>;
  resetLocalState(): void;
}

export function useAssistantRuns(key: string | null): AssistantRunsLive {
  const threadKey = threadKeyOf(key);
  const basePath = threadKey ? `/api/assistant/agent/${threadKey}` : `/api/assistant/agent/__idle__`;

  const agent = useAgent({
    agent: "LexaAssistantAgent",
    name: threadKey ?? "idle",
    basePath,
    enabled: threadKey !== null,
  });
  const toolEvents = useAgentToolEvents({ agent });

  const [liveRunIds, setLiveRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [replayedRunIds, setReplayedRunIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (threadKey === null) return;
    // A new thread is a fresh socket: drop the prior thread's liveness marks.
    setLiveRunIds(new Set());
    setReplayedRunIds(new Set());
    const handler = (event: MessageEvent) => {
      const frame = parseAgentToolEvent(event.data);
      if (!frame) return;
      if (frame.replay) {
        setReplayedRunIds((prev) => (prev.has(frame.runId) ? prev : new Set(prev).add(frame.runId)));
      } else {
        setLiveRunIds((prev) => (prev.has(frame.runId) ? prev : new Set(prev).add(frame.runId)));
      }
    };
    agent.addEventListener("message", handler);
    return () => agent.removeEventListener("message", handler);
  }, [agent, threadKey]);

  return useMemo<AssistantRunsLive>(
    () => ({
      runsById: toolEvents.runsById,
      liveRunIds,
      replayedRunIds,
      resetLocalState: toolEvents.resetLocalState,
    }),
    [toolEvents.runsById, toolEvents.resetLocalState, liveRunIds, replayedRunIds]
  );
}
