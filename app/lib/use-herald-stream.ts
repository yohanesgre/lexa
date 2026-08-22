import { useState, useSyncExternalStore } from "react";
import type { StreamFrame } from "../../shared/herald";

// Fetch-based SSE reader for Herald's POST stream endpoints (S5). Sessions
// live in a module-level store keyed by taskId/chatId so a closed popover or
// route does NOT tear down the run ("Closing the popover does NOT stop the
// run" — herald-popover.html): reopening resubscribes to the live state.

export interface HeraldToolChip {
  key: string;
  label: string;
  phase: "call" | "result";
}

export type HeraldStreamStatus = "idle" | "connecting" | "streaming" | "done" | "error" | "aborted";

export interface HeraldStreamSnapshot {
  status: HeraldStreamStatus;
  frames: StreamFrame[];
  text: string;
  tools: HeraldToolChip[];
  error: { code: string; message: string } | null;
  usage: { in: number; out: number } | null;
}

const IDLE: HeraldStreamSnapshot = Object.freeze({
  status: "idle",
  frames: [],
  text: "",
  tools: [],
  error: null,
  usage: null,
});

// Tool frame names → wireframe chip copy (herald-popover.html annotations).
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
    let text = "";
    let toolSeq = tools.length;

    const handleFrame = (frame: StreamFrame) => {
      frames.push(frame);
      switch (frame.type) {
        case "delta":
          text += frame.text;
          this.emit({ frames: [...frames], text });
          break;
        case "tool": {
          if (frame.phase === "call") {
            tools = [...tools, { key: `${frame.name}-${toolSeq++}`, label: toolLabel(frame.name), phase: "call" }];
          } else {
            // Flip the most recent unresolved chip of the same tool to result.
            const index = tools.findLastIndex((t) => t.label === toolLabel(frame.name) && t.phase === "call");
            if (index >= 0) tools = tools.map((t, i) => (i === index ? { ...t, phase: "result" } : t));
          }
          this.emit({ frames: [...frames], tools: [...tools] });
          break;
        }
        case "error":
          this.emit({ frames: [...frames], status: "error", error: { code: frame.code, message: frame.message } });
          break;
        case "done":
          text = frame.text;
          this.emit({ frames: [...frames], text, status: "done", usage: frame.usage });
          break;
        case "start":
          this.emit({ frames: [...frames] });
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
