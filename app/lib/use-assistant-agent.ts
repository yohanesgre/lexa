import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { AssistantRunAgent } from "./use-assistant-runs";
import { resumeOutcome, type AssistantStream, type AssistantStreamSnapshot, type ResumeResult } from "./use-assistant-stream";

// The resume outcome helpers now live with the SSE store (the primary
// transport); re-exported so this dormant module and its tests keep working.
export { resumeOutcome, shouldPersistResume, type ResumeResult } from "./use-assistant-stream";
import { isTerminalStreamStatus } from "../components/chat/assistant-chat-logic";
import {
  agentSendMetadata,
  agentSendParts,
  emptyAgentSegment,
  lastAssistantMessage,
  segmentFromMessages,
  snapshotFromSegment,
  usageFromMessage,
  type AgentSendBody,
  type KnownApprovalDecisions,
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

// `:id` path segment for the WS route. Wiki slugs are unvalidated user strings,
// so an id carrying `?`, `#`, or `/` must be percent-encoded: raw, `wiki:a?b`
// subscribes to `wiki:a` (query split) and a `/` 404s the gate. The surface
// prefix is a fixed literal and stays raw.
function encodeThreadKeyPath(key: string): string {
  const sep = key.indexOf(":");
  if (sep < 0) return encodeURIComponent(key);
  return `${key.slice(0, sep)}:${encodeURIComponent(key.slice(sep + 1))}`;
}

// Cross-render bridge for a just-minted thread: `useChatStartStream` mints the
// id in the same tick and cannot send through the hook bound to the previous
// (empty) key. The pending bodies are flushed in FIFO order once the new
// thread's socket is identified. Mirrors the SSE `assistantSendForKey` surface.
// Per-key queue (not a single slot): the settle gate can hold several sends for
// one target, and a later send must never replace an earlier accepted one.
const pendingSends = new Map<string, AgentSendBody[]>();

export function assistantSendForKey(key: string, body: unknown): void {
  if (!key) return;
  const payload = (body ?? {}) as AgentSendBody;
  const queue = pendingSends.get(key);
  if (queue) queue.push(payload);
  else pendingSends.set(key, [payload]);
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
  // Client-known approval decisions overlaid onto the raw carrier projection,
  // so a batch decided in this session settles locally without a reload.
  decisions?: KnownApprovalDecisions | undefined;
}

// A no-op `subscribe` surface keeps the hook structurally compatible with the
// SSE `AssistantStream`; the chat page only reads the snapshot fields.
const noopSubscribe = (): (() => void) => () => {};

// The agent object returned by `useAgent` IS the thread's PartySocket. On a key
// change the SDK issues a stream-resume probe through this socket in the commit
// that swaps the transport, while it still points at the previous socket —
// which partysocket has already `close()`d on a discarded address. The probe is
// a dead end whenever the socket will be replaced (`shouldReconnect === false`),
// regardless of its `readyState` — that frame can never be delivered, so
// `send()` warns "send() was called after close()" and buffers a frame that is
// dropped on the next socket replacement. Drop exactly that probe, and only on a
// socket that will not reconnect. A socket that WILL reconnect keeps the SDK's
// buffered retry path intact, and every other payload passes through untouched.
// The dropped probe is otherwise answered by the server's proactive
// `cf_agent_stream_resuming` on the replacement socket, or times out
// harmlessly.
export function guardResumeProbe<T extends object>(agent: T): T {
  return new Proxy(agent, {
    get(target, prop) {
      if (prop === "send") {
        return (data: unknown): boolean => {
          const socket = target as { shouldReconnect?: boolean };
          if (
            typeof data === "string" &&
            data.includes("cf_agent_stream_resume_request") &&
            socket.shouldReconnect === false
          ) {
            return false;
          }
          const real = Reflect.get(target, "send", target) as ((data: unknown) => boolean) | undefined;
          return real ? real.call(target, data) : false;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// The agent-backed stream adds the transport-only reconnect signals the chat
// surface renders (herald-chat.html "Connection lost → auto-resume").
export interface AssistantAgentStream extends AssistantStream {
  reconnecting: boolean;
  resumed: boolean;
  // The resume POST is non-idempotent, so its caller can be told the route's
  // discriminated outcome (persist a success, retry a failure). Non-resume
  // sends ignore it.
  send: (url: string, body: unknown, onResult?: (result: ResumeResult) => void) => void;
  // The thread's single PartySocket. Exposed so the delegated-run hook taps the
  // SAME connection instead of opening a second one. Typed structurally to the
  // `useAgentToolEvents` agent view (`useAgent`'s overloads don't survive
  // `ReturnType`, so the minimal event surface is the honest type here).
  agent: AssistantRunAgent;
}

// A PartySocket reports `readyState === 0` while CONNECTING. partysocket closes
// the outgoing socket on any memo-key change, and closing a CONNECTING socket is
// exactly what the browser warns about ("WebSocket is closed before the
// connection is established"). An OPEN/CLOSED/errored socket closes cleanly, so
// an identity change is safe once the socket has settled. `connectionError` is
// belt-and-braces: at runtime the SDK sets it only on a final close, by which
// point `readyState` has already left CONNECTING (CLOSING/CLOSED), so this
// branch is unreachable with `readyState === 0` — it exists only so a dead
// socket can never pin a pending change. `readyState` is absent on test doubles
// → settled.
export function socketSettled(agent: unknown): boolean {
  const socket = agent as { readyState?: number; connectionError?: unknown } | null | undefined;
  if (!socket) return true;
  if (socket.connectionError) return true;
  return typeof socket.readyState !== "number" || socket.readyState !== 0;
}

export function useAssistantAgent(key: string | null, options?: AssistantAgentOptions): AssistantAgentStream {
  const projectId = options?.projectId;

  // The identity currently handed to `useAgent` — (surface key, projectId) → the
  // name/basePath/query/enabled set. It is held back while the outgoing socket
  // is still CONNECTING (`socketSettled`), so no identity change — stale-restore
  // / orphan-deep-link eviction, fast thread switch, or project switch — can
  // close a dial that has not finished handshaking. The first dial for a thread
  // identity is then final for that identity.
  const [committed, setCommitted] = useState<{ key: string | null; projectId: string | undefined }>(() => ({
    key,
    projectId,
  }));
  const committedKey = committed.key;

  const threadKey = threadKeyOf(committedKey);
  // No leading slash: PartySocket builds `${protocol}://${host}/${basePath}...`,
  // so a leading slash yields a double-slash path that workers.dev does not
  // normalize (the SPA fallback swallows the upgrade). Keep it slash-free.
  const basePath = threadKey ? `api/assistant/agent/${encodeThreadKeyPath(threadKey)}` : `api/assistant/agent/__idle__`;

  // `?projectId=` rides the WS handshake for a fresh chat thread. Keep the
  // object referentially stable across renders: PartySocket memoizes its socket
  // on JSON.stringify(query), but a fresh literal would still churn the option
  // memo upstream. `null` (not undefined) so the memo dep stays a single value.
  const query = useMemo(() => (committed.projectId ? { projectId: committed.projectId } : null), [committed.projectId]);

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
    // Each chat/task/wiki thread is its own DO instance, so switching threads
    // legitimately changes the identity; acknowledge it via the documented
    // callback instead of the SDK advisory.
    onIdentityChange: () => {},
    // Identity swap enqueues the SDK's stream-resume probe on the outgoing
    // socket — transferring it delivers the probe to its own (new) DO instead
    // of discarding; user payloads never buffer here (assistantSendForKey
    // defers to the identified socket).
    transferEnqueuedMessages: true,
    // A cold DO's first dial regularly exceeds partysocket's 4s default; the
    // abort closes a CONNECTING socket (browser warning) and delays the
    // deferred first send by a whole retry cycle (~5s).
    connectionTimeout: 15000,
  });

  // Advance the committed identity only once the outgoing socket has settled.
  // `readyState` mutates in place without a React state update, so while a
  // change is pending poll for the transition (every socket leaves CONNECTING
  // through open, close, or a terminal connection error).
  const target = useMemo(() => ({ key, projectId }), [key, projectId]);
  useEffect(() => {
    if (committed.key === target.key && committed.projectId === target.projectId) return;
    if (socketSettled(agent)) {
      setCommitted(target);
      return;
    }
    const timer = window.setInterval(() => {
      if (socketSettled(agent)) setCommitted(target);
    }, 25);
    return () => window.clearInterval(timer);
  }, [committed, target, agent]);

  // Bounded retention (drop-on-abandon): the gate only ever commits the LATEST
  // target, so a target replaced before it commits never dials and its queued
  // sends could never drain. Drop exactly this hook's previously-targeted
  // surface queue when the target moves on — scoped by the surface prefix so
  // another surface's keys (task / wiki) are never touched.
  const prevTargetKeyRef = useRef<string | null>(key);
  useEffect(() => {
    const prev = prevTargetKeyRef.current;
    if (prev === target.key) return;
    prevTargetKeyRef.current = target.key;
    const surface = prev?.slice(0, prev.indexOf(":"));
    if (!surface) return;
    for (const pendingKey of pendingSends.keys()) {
      if (pendingKey !== target.key && pendingKey.slice(0, pendingKey.indexOf(":")) === surface) {
        pendingSends.delete(pendingKey);
      }
    }
  }, [target.key]);

  const bodyRef = useRef<Record<string, unknown>>({});
  // `useAgentChat` owns the transport, so it must talk to the guarded socket;
  // the raw `agent` stays what the returned stream exposes for
  // `useAssistantRunEvents` (the delegated-run hook taps the real connection).
  const guardedAgent = useMemo(() => guardResumeProbe(agent), [agent]);
  const chat = useAgentChat({
    agent: guardedAgent,
    // The DO is canonical and the REST transcript is the settled read; the
    // client message list is a projection, never synced back.
    getInitialMessages: null,
    syncMessagesToServer: false,
    // Without a thread there is no stream to resume: the idle landing socket is
    // closed (`enabled: false`) and probing it produces the
    // "send() was called after close()" warning + a buffered frame that is
    // discarded on the next socket replacement.
    resume: threadKey !== null,
    throttle: options?.throttle ?? 50,
    body: () => bodyRef.current,
  });

  const messages = chat.messages;
  const lastAssistant = useMemo(() => lastAssistantMessage(messages), [messages]);
  const decisions = options?.decisions;
  const segment = useMemo(() => {
    if (!threadKey) return emptyAgentSegment();
    // LX-120: suspension rides the merged carrier set across the trailing turn,
    // not just the last assistant message. The known-decisions overlay settles
    // a batch decided in this session (or already terminal in the view).
    return segmentFromMessages(messages, decisions);
  }, [threadKey, messages, decisions]);

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
    // recovering tick paper over it with a "connecting" status. `done` in
    // particular would otherwise oscillate done→connecting→done and re-fire
    // the terminal-refetch effects on every tick.
    if (chat.isRecovering && !isTerminalStreamStatus(next.status)) next.status = "connecting";
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
  if (agent.identified && committedKey) identifiedKeyRef.current = committedKey;
  const reconnecting = !!committedKey && identifiedKeyRef.current === committedKey && !agent.identified && !agent.connectionError;

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
  }, [committedKey]);

  // Flush a pending send for a just-minted thread once its socket is up.
  useEffect(() => {
    if (!committedKey || !agent.identified) return;
    // The replacement socket is created one commit after the identity commit, so
    // `agent` can still be addressed to the previous identity for a render: never
    // flush a deferred send through the wrong thread's socket.
    const socketBasePath = (agent as { partySocketOptions?: { basePath?: string } }).partySocketOptions?.basePath;
    if (socketBasePath !== undefined && socketBasePath !== basePath) return;
    const queue = pendingSends.get(committedKey);
    if (!queue || queue.length === 0) return;
    // Drain the whole FIFO in order, then drop the key — no slot to overwrite.
    pendingSends.delete(committedKey);
    for (const pending of queue) {
      bodyRef.current = agentSendMetadata(pending);
      const parts = agentSendParts(pending);
      if (parts.length > 0) chat.sendMessage({ parts });
    }
    // chat.sendMessage identity is stable for the connection; keyed on the
    // identified flip so a fresh thread flushes exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedKey, agent.identified, basePath]);

  const send = useCallback(
    (url: string, body: unknown, onResult?: (result: ResumeResult) => void) => {
      const payload = (body ?? {}) as AgentSendBody;
      // Approval resume stays a plain REST POST (docs/API.md B.4 kept path);
      // the resumed frames then arrive over this socket. The client names the
      // exact batch it is resuming; the route forwards it to the DO. The
      // optional outcome callback lets the caller persist a successful resume
      // while leaving a failed attempt eligible for retry.
      if (/\/resume$/.test(url)) {
        void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
          .then((r) => resumeOutcome(r))
          .then((result) => onResult?.(result))
          .catch(() => onResult?.({ ok: false }));
        return;
      }
      // The page can send while the settle gate is still holding the identity
      // swap (select A → select B → send before A settles). The live socket is
      // still addressed to A, so `chat.sendMessage` would write to A's DO.
      // Defer the payload on the surface key instead; the basePath-guarded flush
      // delivers it once B's socket has committed and identified.
      if (committed.key !== key || committed.projectId !== projectId) {
        if (key) assistantSendForKey(key, payload);
        return;
      }
      bodyRef.current = agentSendMetadata(payload);
      const parts = agentSendParts(payload);
      if (parts.length > 0) void chat.sendMessage({ parts });
    },
    [chat, committed, key, projectId]
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
