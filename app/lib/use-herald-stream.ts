import { useState, useSyncExternalStore } from "react";
import type { StreamFrame } from "../../shared/herald";

// Fetch-based SSE reader for Herald's POST stream endpoints (S5). Sessions
// live in a module-level store keyed by taskId/chatId so a closed popover or
// route does NOT tear down the run ("Closing the popover does NOT stop the
// run" — herald-popover.html): reopening resubscribes to the live state.

export interface HeraldToolChip {
  key: string;
  // Raw tool name from the frame (e.g. `wiki_search`) — rendered as the
  // bracketed `[name]` prefix of the verbose transcript line.
  name: string;
  // Humanized fallback copy when the frame carries no detail.
  label: string;
  phase: "call" | "result";
  // Verbose process sentence from the call frame's `detail` (e.g.
  // `Searching wiki for "setup"`) — kept intact through the call→result flip.
  detail?: string;
  // Detail from the RESULT frame, if any — rendered as the compact
  // `↳ …` line beneath the completed call line.
  resultDetail?: string;
}

export type HeraldStreamStatus = "idle" | "connecting" | "streaming" | "done" | "error" | "aborted";

// Chronological reply timeline (herald-chat.html): one entry per content
// element in FRAME ARRIVAL ORDER — reasoning bursts, tool calls and text
// deltas interleave exactly as the model emitted them. Consecutive delta
// frames merge into the current text item; a tool result replaces its
// chip in place.
export type HeraldTimelineItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; chip: HeraldToolChip }
  | { kind: "reasoning"; text: string; ms: number | null };

export interface HeraldStreamSnapshot {
  status: HeraldStreamStatus;
  frames: StreamFrame[];
  text: string;
  tools: HeraldToolChip[];
  // Ordered timeline for the streaming bubble renderer. Session-memory
  // only, like the rest of the ephemeral state.
  items: HeraldTimelineItem[];
  // Ephemeral reasoning buffer from `reasoning` SSE frames — lives only in
  // this session's memory, never persisted; fetched transcripts have none.
  reasoningText: string;
  // True while the latest frame was a reasoning delta (drives the
  // auto-expanded Thinking row); any other frame closes the burst.
  reasoningActive: boolean;
  // Accumulated wall time of completed reasoning bursts (null while none
  // has closed yet) — feeds the "Thought for Ns" label.
  reasoningMs: number | null;
  error: { code: string; message: string } | null;
  usage: { in: number; out: number } | null;
}

const IDLE: HeraldStreamSnapshot = Object.freeze({
  status: "idle",
  frames: [],
  text: "",
  tools: [],
  items: [],
  reasoningText: "",
  reasoningActive: false,
  reasoningMs: null,
  error: null,
  usage: null,
});

// Tool frame names → wireframe chip copy (herald-chat.html annotations).
function toolLabel(name: string): string {
  switch (name) {
    case "web_search":
      return "Searching web…";
    case "fetch_url":
    case "read_s3_file":
      return "Reading file…";
    default:
      return name;
  }
}

// `detail` rides on tool frames per the backend contract but isn't on the
// shared StreamFrame union yet — read it defensively at the SSE boundary.
function frameDetail(frame: StreamFrame): string | undefined {
  const detail = (frame as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim().length > 0 ? detail : undefined;
}

class HeraldStreamSession {
  private snapshot: HeraldStreamSnapshot = { ...IDLE, frames: [], tools: [] };
  private listeners = new Set<() => void>();
  readonly controller = new AbortController();

  constructor(
    readonly key: string,
    private readonly url: string,
    private readonly body: unknown
  ) {}

  getSnapshot = (): HeraldStreamSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(patch: Partial<HeraldStreamSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  abort() {
    if (this.snapshot.status === "connecting" || this.snapshot.status === "streaming") {
      this.controller.abort();
      // Server discards the partial message; keep accumulated preview until
      // the caller resets, matching the popover's Stop semantics.
      this.emit({ status: "aborted" });
    }
  }

  reset() {
    this.controller.abort();
    this.emit({ ...IDLE, frames: [], tools: [] });
  }

  start(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    this.emit({ status: "connecting", error: null });
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.body),
        signal: this.controller.signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      this.emit({ status: "error", error: { code: "HERALD_GENERATION_FAILED", message: "Could not reach the server." } });
      return;
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      this.emit({
        status: "error",
        error: { code: payload.error?.code ?? `HTTP ${res.status}`, message: payload.error?.message ?? `Request failed (${res.status}).` },
      });
      return;
    }
    if (!res.body) {
      this.emit({ status: "error", error: { code: "HERALD_GENERATION_FAILED", message: "Empty stream." } });
      return;
    }

    this.emit({ status: "streaming" });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: StreamFrame[] = [];
    let tools = [...this.snapshot.tools];
    let items: HeraldTimelineItem[] = [...this.snapshot.items];
    let text = "";
    let toolSeq = tools.length;
    let reasoningText = this.snapshot.reasoningText;
    let reasoningActive = false;
    let reasoningMs = this.snapshot.reasoningMs;
    let burstStart = 0;

    // Bank the open burst: aggregate ms for the summary label + per-item ms
    // for the row's own "Thought for Ns" label.
    const closeBurst = (): Partial<HeraldStreamSnapshot> => {
      reasoningActive = false;
      const elapsed = Math.max(1, Math.round(performance.now() - burstStart));
      reasoningMs = (reasoningMs ?? 0) + elapsed;
      const last = items[items.length - 1];
      if (last?.kind === "reasoning" && last.ms === null) {
        items = [...items.slice(0, -1), { ...last, ms: elapsed }];
      }
      return { reasoningActive: false, reasoningMs, items: [...items] };
    };

    const handleFrame = (frame: StreamFrame) => {
      frames.push(frame);
      // Ephemeral reasoning buffer — appended live, never persisted.
      if (frame.type === "reasoning") {
        if (frame.delta.length > 0) {
          const last = items[items.length - 1];
          if (!reasoningActive) {
            reasoningActive = true;
            burstStart = performance.now();
            items = [...items, { kind: "reasoning", text: frame.delta, ms: null }];
          } else if (last?.kind === "reasoning") {
            items = [...items.slice(0, -1), { ...last, text: last.text + frame.delta }];
          } else {
            items = [...items, { kind: "reasoning", text: frame.delta, ms: null }];
          }
          reasoningText += frame.delta;
          this.emit({ frames: [...frames], items: [...items], reasoningText, reasoningActive: true });
        }
        return;
      }
      // Any non-reasoning frame closes the current burst and banks its time.
      let burstPatch: Partial<HeraldStreamSnapshot> = {};
      if (reasoningActive) {
        burstPatch = closeBurst();
      }
      switch (frame.type) {
        case "delta": {
          text += frame.text;
          const last = items[items.length - 1];
          if (last?.kind === "text") {
            items = [...items.slice(0, -1), { kind: "text", text: last.text + frame.text }];
          } else {
            items = [...items, { kind: "text", text: frame.text }];
          }
          this.emit({ frames: [...frames], ...burstPatch, text, items: [...items] });
          break;
        }
        case "tool": {
          const detail = frameDetail(frame);
          if (frame.phase === "call") {
            const chip: HeraldToolChip = { key: `${frame.name}-${toolSeq++}`, name: frame.name, label: toolLabel(frame.name), phase: "call", detail };
            tools = [...tools, chip];
            items = [...items, { kind: "tool", chip }];
          } else {
            // Flip the most recent unresolved chip of the same tool to result;
            // the result frame's detail rides separately so the call line
            // keeps its process sentence.
            const index = tools.findLastIndex((t) => t.name === frame.name && t.phase === "call");
            if (index >= 0) {
              const chip = { ...tools[index], phase: "result" as const, resultDetail: detail };
              tools = tools.map((t, i) => (i === index ? chip : t));
              const itemIndex = items.findLastIndex((it) => it.kind === "tool" && it.chip.key === chip.key);
              if (itemIndex >= 0) items = items.map((it, i) => (i === itemIndex ? { kind: "tool" as const, chip } : it));
            }
          }
          this.emit({ frames: [...frames], ...burstPatch, tools: [...tools], items: [...items] });
          break;
        }
        case "error":
          this.emit({ frames: [...frames], status: "error", error: { code: frame.code, message: frame.message }, ...burstPatch });
          break;
        case "done":
          text = frame.text;
          this.emit({ frames: [...frames], text, status: "done", usage: frame.usage, ...burstPatch });
          break;
        case "start":
          this.emit({ frames: [...frames], ...burstPatch });
          break;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith(":")) continue; // heartbeat comment
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          try {
            const payload = JSON.parse(dataLines.join("\n")) as StreamFrame;
            handleFrame({ ...(payload as { type?: string }), type: payload.type ?? eventName } as StreamFrame);
          } catch {
            // Malformed chunk — skip, never kill the stream.
          }
          if (this.snapshot.status === "error" || this.snapshot.status === "done") return;
        }
      }
      // Stream closed without a terminal frame.
      if (this.snapshot.status === "streaming") {
        this.emit({ status: "error", error: { code: "HERALD_GENERATION_FAILED", message: "The provider closed the stream unexpectedly. No partial text was kept." } });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      this.emit({ status: "error", error: { code: "HERALD_GENERATION_FAILED", message: "The stream failed unexpectedly." } });
    }
  }
}

const sessions = new Map<string, HeraldStreamSession>();

function getSession(key: string): HeraldStreamSession | null {
  return sessions.get(key) ?? null;
}

export interface HeraldStream extends HeraldStreamSnapshot {
  send: (url: string, body: unknown) => void;
  abort: () => void;
  // Clear the terminal state back to idle (Dismiss affordances).
  reset: () => void;
  // Raw store surface — external observers (tests, devtools) can record
  // every emitted snapshot without relying on React render batching.
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HeraldStreamSnapshot;
}

// Subscribe to the session for `key`. A fresh key renders idle; send() boots
// the POST stream and every delta re-renders subscribers.
export function useHeraldStream(key: string | null): HeraldStream {
  const [, setSessionEpoch] = useState(0);
  const session = key ? getSession(key) : null;
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? (() => IDLE)
  );
  return {
    ...snapshot,
    subscribe: (listener: () => void) => (session ? session.subscribe(listener) : noopSubscribe(listener)),
    getSnapshot: () => session?.getSnapshot() ?? IDLE,
    send: (url: string, body: unknown) => {
      if (!key) return;
      const existing = sessions.get(key);
      if (existing && (existing.getSnapshot().status === "connecting" || existing.getSnapshot().status === "streaming")) return;
      const next = new HeraldStreamSession(key, url, body);
      sessions.set(key, next);
      setSessionEpoch((e) => e + 1);
      next.start();
    },
    abort: () => {
      if (key) sessions.get(key)?.abort();
    },
    reset: () => {
      if (key) sessions.get(key)?.reset();
    },
  };
}

function noopSubscribe(listener: () => void): () => void {
  void listener;
  return () => {};
}
