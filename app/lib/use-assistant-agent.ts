import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { AssistantRunAgent } from "./use-assistant-runs";
import type { AssistantStream, AssistantStreamSnapshot } from "./use-assistant-stream";
import {
  agentSendMetadata,
  agentSendParts,
  emptyAgentSegment,
  lastAssistantMessage,
  segmentFromAssistantMessage,
  snapshotFromSegment,
  usageFromMessage,
  type AgentSendBody,
} from "./assistant-agent-adapter";

// ADR-0003 P4b (WS1): the assistant chat transport, replacing the SSE session
// store in use-assistant-stream.ts for the chat surface. One WebSocket per
// thread (`GET /api/assistant/agent/chat:<chatId>`), `useAgentChat` owning the
// message stream + auto-resume, and the pure adapter projecting UIMessages back
// onto the legacy `AssistantStreamSnapshot` the transcript renderers consume.
//
// The SSE session store stays for the document panel until WS3 (it keys the
// same snapshot shape); both are transport implementations of one contract.

// Surface key (`assistant-chat:<id>` / `assistant-task:<id>`) → canonical DO
// thread key (`chat:<id>` / `task:<id>`). An already-canonical key passes
// through so callers can address the WS thread directly.
const SURFACE_THREAD_TYPES: Record<string, string> = {
  "assistant-chat": "chat",
  "assistant-task": "task",
  "assistant-wiki": "wiki",
};

export function threadKeyOf(key: string | null): string | null {
  if (!key) return null;
  const sep = key.indexOf(":");
  if (sep < 0) return null;
  const prefix = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (!id) return null;
  const surface = SURFACE_THREAD_TYPES[prefix];
  if (surface) return `${surface}:${id}`;
  if (prefix === "chat" || prefix === "task" || prefix === "wiki") return key;
  return null;
}

// Cross-render bridge for a just-minted thread: `useChatStartStream` mints the
// id in the same tick and cannot send through the hook bound to the previous
// (empty) key. The pending body is flushed once the new thread's socket is
// identified. Mirrors the SSE `assistantSendForKey` surface.
const pendingSends = new Map<string, AgentSendBody>();

export function assistantSendForKey(key: string, body: unknown): void {
  if (!key) return;
  pendingSends.set(key, (body ?? {}) as AgentSendBody);
}

export interface AssistantAgentOptions {
  // Streaming snapshot coalescing window (ms). Mirrors the SSE hook's rAF
  // batching: markdown re-parse must not run per chunk.
  throttle?: number | undefined;
  // Chat thread with no server row yet: the WS gate requires `?projectId=` to
  // upsert the `assistant_threads` row on connect (ADR-0003 §B.2), else the
  // upgrade 404s and the first send is dropped. Omitted for task/wiki threads
  // and the document panel, which always have a server-created row.
  projectId?: string | undefined;
}

// A no-op `subscribe` surface keeps the hook structurally compatible with the
// SSE `AssistantStream`; the chat page only reads the snapshot fields.
const noopSubscribe = (): (() => void) => () => {};

// The agent-backed stream adds the transport-only reconnect signals the chat
// surface renders (herald-chat.html "Connection lost → auto-resume").
export interface AssistantAgentStream extends AssistantStream {
  reconnecting: boolean;
  resumed: boolean;
  // The thread's single PartySocket. Exposed so the delegated-run hook taps the
  // SAME connection instead of opening a second one. Typed structurally to the
  // `useAgentToolEvents` agent view (`useAgent`'s overloads don't survive
  // `ReturnType`, so the minimal event surface is the honest type here).
  agent: AssistantRunAgent;
}

export function useAssistantAgent(key: string | null, options?: AssistantAgentOptions): AssistantAgentStream {
  const threadKey = threadKeyOf(key);
  // No leading slash: PartySocket builds `${protocol}://${host}/${basePath}...`,
  // so a leading slash yields a double-slash path that workers.dev does not
  // normalize (the SPA fallback swallows the upgrade). Keep it slash-free.
  const basePath = threadKey ? `api/assistant/agent/${threadKey}` : `api/assistant/agent/__idle__`;

  // `?projectId=` rides the WS handshake for a fresh chat thread. Keep the
  // object referentially stable across renders: PartySocket memoizes its socket
  // on JSON.stringify(query), but a fresh literal would still churn the option
  // memo upstream. `null` (not undefined) so the memo dep stays a single value.
  const projectId = options?.projectId;
  const query = useMemo(() => (projectId ? { projectId } : null), [projectId]);

  const agent = useAgent({
    agent: "LexaAssistantAgent",
    name: threadKey ?? "idle",
    basePath,
    // Omitted (never an explicit `undefined`) when there is no projectId:
    // exactOptionalPropertyTypes rejects undefined on UseAgentOptions["query"].
    ...(query ? { query } : {}),
    // No thread yet (fresh landing): keep the socket closed instead of
    // connecting to a bogus key the gate would 404.
    enabled: threadKey !== null,
  });

  const bodyRef = useRef<Record<string, unknown>>({});
  const chat = useAgentChat({
    agent,
    // The DO is canonical and the REST transcript is the settled read; the
    // client message list is a projection, never synced back.
    getInitialMessages: null,
    syncMessagesToServer: false,
    resume: true,
    throttle: options?.throttle ?? 50,
    body: () => bodyRef.current,
  });

  const messages = chat.messages;
  const lastAssistant = useMemo(() => lastAssistantMessage(messages), [messages]);
  const segment = useMemo(() => {
    if (!threadKey) return emptyAgentSegment();
    return segmentFromAssistantMessage(lastAssistant);
  }, [threadKey, lastAssistant]);

  const snapshot = useMemo<AssistantStreamSnapshot>(() => {
    const next = snapshotFromSegment(segment, {
      status: chat.status,
      error: chat.error,
      connectionError: chat.connectionError,
      usage: usageFromMessage(lastAssistant),
    });
    if (segment.items[segment.items.length - 1]?.kind === "reasoning" && (chat.status === "streaming" || chat.isStreaming)) {
      next.reasoningActive = true;
    }
    // A terminal socket close is authoritative: do not let a transient
    // recovering tick paper over it with a "connecting" status.
    if (chat.isRecovering && next.status !== "error") next.status = "connecting";
    return next;
  }, [segment, lastAssistant, chat.status, chat.error, chat.connectionError, chat.isStreaming, chat.isRecovering]);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Transport reconnect (herald-chat.html "Connection lost → auto-resume"):
  // PartySocket reconnects with capped backoff, so a dropped socket flips
  // `identified` to false until the handshake completes. Surface it only once
  // THIS thread's socket has identified at least once — the first mount
  // handshake is not a reconnect. `resumed` is the transient (~2s) marker the
  // wireframe shows after a drop is recovered.
  const identifiedKeyRef = useRef<string | null>(null);
  if (agent.identified && key) identifiedKeyRef.current = key;
  const reconnecting = !!key && identifiedKeyRef.current === key && !agent.identified && !agent.connectionError;

  const [resumed, setResumed] = useState(false);
  const prevReconnectingRef = useRef(false);
  useEffect(() => {
    const was = prevReconnectingRef.current;
    prevReconnectingRef.current = reconnecting;
    if (!was || reconnecting) return;
    setResumed(true);
    const timer = window.setTimeout(() => setResumed(false), 2000);
    return () => window.clearTimeout(timer);
  }, [reconnecting]);

  // Switching threads is a fresh socket, not a reconnect: drop the transient
  // "resumed" marker and the prior thread's identification so the new thread's
  // first handshake is never misread as a recovery.
  useEffect(() => {
    setResumed(false);
    prevReconnectingRef.current = false;
    identifiedKeyRef.current = null;
  }, [key]);

  // Flush a pending send for a just-minted thread once its socket is up.
  useEffect(() => {
    if (!key || !agent.identified) return;
    const pending = pendingSends.get(key);
    if (!pending) return;
    pendingSends.delete(key);
    bodyRef.current = agentSendMetadata(pending);
    const parts = agentSendParts(pending);
    if (parts.length > 0) chat.sendMessage({ parts });
    // chat.sendMessage identity is stable for the connection; keyed on the
    // identified flip so a fresh thread flushes exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, agent.identified]);

  const send = useCallback(
    (url: string, body: unknown) => {
      const payload = (body ?? {}) as AgentSendBody;
      // Approval resume stays a plain REST POST (docs/API.md B.4 kept path);
      // the resumed frames then arrive over this socket.
      if (/\/resume$/.test(url)) {
        void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
        return;
      }
      bodyRef.current = agentSendMetadata(payload);
      const parts = agentSendParts(payload);
      if (parts.length > 0) void chat.sendMessage({ parts });
    },
    [chat]
  );

  const abort = useCallback(() => {
    chat.stop();
  }, [chat]);

  const reset = useCallback(() => {
    chat.setMessages([]);
    chat.clearError();
  }, [chat]);

  return useMemo<AssistantAgentStream>(
    () => ({
      ...snapshot,
      subscribe: noopSubscribe,
      getSnapshot: () => snapshotRef.current,
      send,
      abort,
      reset,
      reconnecting,
      resumed,
      agent,
    }),
    [snapshot, send, abort, reset, reconnecting, resumed, agent]
  );
}
