import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Send, Square, ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import * as api from "../../lib/api";
import {
  useProjects,
  useAgents,
  useSkills,
  useHeraldSettings,
  useHeraldChatList,
  useRenameHeraldChat,
  useDeleteHeraldChat,
  useUpdateHeraldChatMeta,
} from "../../lib/queries";
import { ENGINE_AGENT_IDS, hasVisionCapability } from "../../lib/use-hearth-engine";
import { useToast } from "../ui/Toast";
import { useHeraldStream } from "../../lib/use-herald-stream";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { resendIndex } from "../../lib/resendIndex";
import { copyToClipboard } from "../../lib/clipboard";
import { useMentionTokens } from "../../lib/useMentionTokens";
import { renderTokenized } from "../../lib/tokenizeTranscript";
import { MarkdownContent, highlightCode } from "../../lib/markdownToReact";
import { ThreadsSidebar } from "./ThreadsSidebar";
import { SkillPicker } from "../hearth/herald/SkillPicker";
import { HearthFlameIcon } from "../hearth/herald/HeraldPanel";
import { HeraldImageAttach, acceptImageFiles } from "../hearth/herald/HeraldImageAttach";
import type { HeraldImage } from "../hearth/herald/HeraldImageAttach";
import { HeraldActivity } from "./HeraldActivity";
import { EffortPicker } from "./EffortPicker";
import { ApprovalChipRow, HeraldApprovalBatch, SuspendedIndicator, type ApprovalChip } from "./HeraldApprovals";
import type { HeraldTimelineItem, HeraldToolChip } from "../../lib/use-herald-stream";
import type { HeraldReasoningEffort } from "../../../shared/herald";

// Herald Chat — dedicated /$slug/chat route (herald-chat.html +
// herald-chat-upgrades.html). Multi-thread per (project, user): the History
// dropdown lists threads (?thread= deep link), each thread keeps a client
// uuid in document_id; "last visited" persists in localStorage
// lexa-chat-last:<projectId>. No queue row — streams are direct SSE.
// No agent picker: the persona mirrors the project's configured Herald Agent
// (read-only); only the optional skill is picked per message. Transcript
// affordances (hover copy/edit/regenerate, citation chips,
// failed/interrupted treatments) transcribe herald-chat-upgrades.html.

// Herald Chat — dedicated /$slug/chat route (herald-chat.html +
// herald-chat-upgrades.html). Multi-thread per (project, user): the History
// dropdown lists threads (?thread= deep link), each thread keeps a client
// uuid in document_id; "last visited" persists in localStorage
// lexa-chat-last:<projectId>. No queue row — streams are direct SSE.
// Transcript affordances (hover copy/edit/regenerate, citation chips,
// failed/interrupted treatments) transcribe herald-chat-upgrades.html.

const CHAT_CAPS = { maxCount: 3, maxTotalBytes: Math.floor(1.5 * 1024 * 1024) };

export interface CitationView {
  url: string;
  title: string | null;
  hostname: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  imageCount: number;
  // Index into the RAW transcript messages array — resend targets are raw
  // positions (the server truncates its own array).
  rawIndex: number;
  ts?: string | undefined;
  citations?: CitationView[];
  error?: { code: string; message: string };
  stopped?: boolean | undefined;
  // Post-stream activity snapshot frozen at suspend time (session memory).
  activity?: ActivityView;
  // Frozen write-approval batch (herald-write-approvals.html): chips live in
  // session memory from the tool_pending frames; decisions mutate them here.
  batch?: { batchId: string; chips: ApprovalChip[] };
  // Reload mid-suspension: the transcript entry carries the pendingBatch
  // marker but NOT the chip payloads (no batch-read endpoint) — render the
  // waiting indicator only.
  suspendedBatchId?: string | undefined;
}

// Post-stream activity summary shown on the trailing done turn — sourced from
// the live stream session's memory only; transcript-loaded turns never get
// one (reasoning is never persisted).
interface ActivityView {
  items: HeraldTimelineItem[];
  tools: HeraldToolChip[];
  reasoningMs: number | null;
}

// HTTPS-ONLY: http:// sources never render as chips (mixed-content +
// spoofing discipline) — they stay out of the chip row entirely.
export function safeCitations(raw: unknown): CitationView[] {
  if (!Array.isArray(raw)) return [];
  const out: CitationView[] = [];
  for (const entry of raw) {
    const c = entry as { url?: unknown; title?: unknown };
    if (typeof c.url !== "string" || !/^https:\/\//i.test(c.url)) continue;
    let hostname = "";
    try {
      hostname = new URL(c.url).hostname;
    } catch {
      continue;
    }
    out.push({ url: c.url, title: typeof c.title === "string" ? c.title : null, hostname });
  }
  return out;
}

// Code-aware guidance map for persisted error entries
// (herald-chat-upgrades.html FAILED section):
// - PROVIDER_AUTH_FAILED → link chip to Project Settings → Herald
// - HERALD_TOOL_BUDGET_EXCEEDED → informational only
// - PROVIDER_UNREACHABLE / rate-limit family → prominent Retry
export type ErrorGuidance = "settings" | "info" | "retry";

export function guidanceFor(code: string): ErrorGuidance {
  if (code === "PROVIDER_AUTH_FAILED") return "settings";
  if (/RATE|UNREACHABLE/.test(code)) return "retry";
  return "info";
}

const GUIDANCE_BODY: Record<string, string> = {
  PROVIDER_AUTH_FAILED: "The provider rejected the configured API key. Nothing was added to the thread.",
  HERALD_TOOL_BUDGET_EXCEEDED:
    "The reply hit its tool-call budget before finishing. Narrow the ask or raise the budget in project settings to let Herald go further.",
  PROVIDER_UNREACHABLE: "The provider closed the stream unexpectedly (rate limit or outage). Nothing was added to the thread.",
};

// Split stored text on ``` fences → plain / fenced segments. Fenced bodies
// render as a highlighted mono block with a language label + copy button.
export function splitFences(text: string): { fenced: boolean; body: string; lang?: string }[] {
  const parts = text.split("```");
  return parts
    .map((body, i) => {
      if (i % 2 === 0) return { fenced: false, body };
      const m = body.match(/^([a-zA-Z0-9_-]*)\n/);
      const lang = m && m[1] ? m[1] : undefined;
      return { fenced: true, body: m ? body.slice(m[0].length) : body, ...(lang ? { lang } : {}) };
    })
    .filter((seg) => seg.body.length > 0);
}

function hhmm(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--lx-text-muted)", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--lx-text-muted)", flexShrink: 0 }}>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// Brief copied-feedback state per button.
function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const mark = useCallback(() => {
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1200);
  }, []);
  return [copied, mark];
}

export function HeraldChatPage({ slug, thread }: { slug: string; thread?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug/chat" });
  const { data: projects = [] } = useProjects();
  const projectFromList = projects.find((p) => p.slug === slug);
  const { data: project, isError: projectError } = useQuery({
    queryKey: ["project", slug],
    queryFn: () => api.getProject(slug),
    enabled: !projectFromList,
    // Invalid slug must fall back fast — no retry ladder (default is 3
    // attempts ≈7s of dead shell before the redirect).
    retry: false,
  });
  const resolved = projectFromList ?? project;
  const projectId = resolved?.id;

  // Invalid slug (deleted project / stale bookmark): fall back to the first
  // available workspace project instead of rendering a dead shell. Waits for
  // resolution to settle (list miss + detail query error) before redirecting;
  // ?thread= rides along.
  useEffect(() => {
    if (resolved || projects.length === 0) return;
    if (!projectFromList && !projectError && project === undefined) return;
    const fallback = projects[0];
    // @ts-expect-error — strict: exactOptional indexedAccess
    if (fallback.slug === slug!) return;
    void navigate({
      to: "/$slug/chat",
      // @ts-expect-error — strict: exactOptional indexedAccess
      params: { slug: fallback.slug! },
      search: thread ? { thread } : {},
      replace: true,
    });
  }, [resolved, projects, projectFromList, projectError, project, slug, thread, navigate]);

  // chatId resolution order: ?thread= > localStorage lexa-chat-last >
  // history list head > "" (fresh empty state). Every applied selection is
  // written back to localStorage.
  const [chatId, setChatId] = useState("");
  const applyChatId = useCallback(
    (id: string) => {
      setChatId(id);
      if (!projectId) return;
      try {
        window.localStorage.setItem(`lexa-chat-last:${projectId}`, id);
      } catch {
        // non-fatal
      }
    },
    [projectId]
  );

  // History search (?q= filters title + body snippet server-side); the
  // input is debounced so the query key stops thrashing while typing.
  const [chatSearch, setChatSearch] = useState("");
  const debouncedSearch = useDebouncedValue(chatSearch, 250);
  const listQuery = useHeraldChatList(projectId, debouncedSearch);
  // Sidebar visibility — the collapse control lives INSIDE the sidebar
  // (herald-chat.html, mirroring the wiki sidebar): ≥900px it swaps the
  // docked column for a 36px restore rail, <900px the rail button opens the
  // overlay drawer. The collapsed choice persists globally in localStorage
  // lexa-chat-sidebar ("0" = collapsed); hydrated client-side (SSR-safe —
  // no window access during render).
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("lexa-chat-sidebar") === "0") setSidebarOpen(false);
      // On mobile the overlay would obscure the chat — default to closed
      // unless the user explicitly opened it on this device.
      else if (window.matchMedia("(max-width: 899.98px)").matches && window.localStorage.getItem("lexa-chat-sidebar") !== "1") {
        setSidebarOpen(false);
      }
    } catch {
      // non-fatal
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem("lexa-chat-sidebar", next ? "1" : "0");
      } catch {
        // non-fatal
      }
      return next;
    });
  }, []);
  // The top nav's "PanelLeft" button dispatches this event on mobile.
  // We toggle the threads sidebar. Desktop behavior is unchanged (the
  // collapsed rail remains the entry point there).
  useEffect(() => {
    function handleToggle() {
      if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 899.98px)").matches) {
        setSidebarOpen((v) => {
          const next = !v;
          try { window.localStorage.setItem("lexa-chat-sidebar", next ? "1" : "0"); } catch {}
          return next;
        });
      }
    }
    window.addEventListener("lexa:toggle-threads-sidebar", handleToggle);
    return () => window.removeEventListener("lexa:toggle-threads-sidebar", handleToggle);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    if (thread) {
      applyChatId(thread);
      return;
    }
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(`lexa-chat-last:${projectId}`);
    } catch {
      // non-fatal
    }
    if (last) {
      setChatId(last);
      return;
    }
    const head = listQuery.data?.[0]?.chatId;
    if (head) applyChatId(head);
  }, [projectId, thread, listQuery.data, applyChatId]);

  const { data: settings, isLoading: settingsLoading } = useHeraldSettings(projectId);

  // Transcript render on load (GET /api/herald/chat/:chatId). A fresh uuid
  // 404s — that IS the empty-thread state, not an error.
  const transcript = useQuery({
    queryKey: ["herald-chat", chatId],
    queryFn: () => api.getHeraldChat(chatId),
    enabled: !!chatId && !!projectId,
    retry: false,
    staleTime: Infinity,
  });

  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  useEffect(() => {
    if (transcript.error) {
      setTurns([]);
      return;
    }
    if (!transcript.data) return;
    // Server truth replaces the optimistic view — EXCEPT while an approval
    // batch is live in this tab: the frozen chips are session memory the
    // transcript payload cannot reconstruct (it carries no chip payloads),
    // so a late/resumed fetch must not wipe them mid-flow.
    setTurns((prev) => {
      const liveApproval = (prev ?? []).some(
        (t) => t.batch?.chips.some((c) => c.state === "pending") || t.suspendedBatchId
      );
      return liveApproval ? prev : renderTranscript(transcript.data!.messages);
    });
  }, [transcript.data, transcript.error]);

  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  // Skill stays OPTIONAL per message — chat starts with none selected and
  // messages go out without one unless picked here (herald-chat.html
  // composer annotation). Changing skill mid-thread mints a fresh thread
  // server-side.
  const [skillId, setSkillId] = useState("");
  // Skills panel collapsed by default on mobile (saves vertical space) and
  // expanded by default on desktop (chip row is the primary selection UI).
  // The viewport is read on mount; subsequent resizes keep the current
  // state — the user can collapse/expand manually and the choice sticks.
  const [skillsPanelOpen, setSkillsPanelOpen] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return !window.matchMedia("(max-width: 767px)").matches;
  });
  // Mobile composer treatment: collapse skills by default, flip dropdowns
  // upward so they don't run off the bottom of the screen. Desktop keeps
  // the original behavior (chips visible, dropdowns below).
  const isMobileComposer = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
  // Per-turn thinking effort override (herald-chat.html composer): ""
  // follows the project default; an explicit level rides the next stream
  // payload only, then falls back. Resets on thread switch / New chat.
  const [effort, setEffort] = useState<HeraldReasoningEffort | "">("");
  // Chips filter to the Herald Agent junction list — chat ALWAYS runs the
  // herald lane, regardless of the project engine.
  const heraldSkillIds = new Set(agents.find((a) => a.id === ENGINE_AGENT_IDS.herald)?.skillIds ?? []);
  const heraldSkills = skills.filter((s) => heraldSkillIds.has(s.id));
  const effectiveSkillId = heraldSkillIds.has(skillId) ? skillId : "";

  const streamKey = projectId ? `herald-chat:${chatId}` : null;
  const stream = useHeraldStream(streamKey);
  const streaming = stream.status === "connecting" || stream.status === "streaming";

  useEffect(() => {
    setEffort("");
  }, [chatId]);

  const [input, setInput] = useState("");
  const [images, setImages] = useState<HeraldImage[]>([]);

  // "@" mentions over the plain composer textarea (mentions-autocomplete.html).
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionTokens({ slug, value: input, onChange: setInput });

  const busy409 = stream.status === "error" && stream.error?.code === "HERALD_TASK_ACTIVE";
  const providerMissing = !settingsLoading && settings === null;

  // Composer lock while any approval chip is pending (same rule as
  // streaming) — includes the marker-only reload case (no chip payloads).
  const batchChips = (turns ?? []).flatMap((t) => t.batch?.chips ?? []);
  const pendingCount = batchChips.filter((c) => c.state === "pending").length;
  const hasSuspendedMarker = (turns ?? []).some((t) => !!t.suspendedBatchId);
  const suspendedLock = pendingCount > 0 || hasSuspendedMarker || stream.status === "suspended";
  const suspendTally =
    batchChips.length === 0
      ? ""
      : pendingCount === batchChips.length
        ? `${pendingCount} pending`
        : `${pendingCount} of ${batchChips.length} pending`;

  // Engine gate (herald-chat.html): chat ALWAYS runs the herald lane — under
  // a blacksmith project default every stream fails up front, so the banner
  // renders before any attempt.
  const engineGate = settings?.engine === "blacksmith";

  // Vision resolution mirrors task create: primary inline parts or a
  // configured vision model; without either, attach is disabled with a
  // tooltip pointing at Project Settings → Herald vision.
  const visionReady = hasVisionCapability(settings);
  const attachDisabled = !settingsLoading && settings !== null && !visionReady;
  const ATTACH_DISABLED_TITLE = "Images are disabled — configure vision in Project Settings → Herald.";

  const skillName = skills.find((s) => s.id === effectiveSkillId)?.name;

  // Terminal stream states refetch the transcript so persisted partials,
  // errors and citations appear without a reload.
  useEffect(() => {
    if (!chatId) return;
    // Terminal stream states refetch the transcript so persisted partials,
    // errors and citations appear without a reload. The sidebar list
    // refreshes here too — the thread row + derived title are persisted
    // server-side exactly at these boundaries, so this is the earliest
    // moment a fresh thread can appear.
    if (stream.status === "done" || stream.status === "error" || stream.status === "aborted" || stream.status === "suspended") {
      void qc.invalidateQueries({ queryKey: ["herald-chat", chatId] });
      if (projectId) void qc.invalidateQueries({ queryKey: ["herald-chats", projectId] });
    }
  }, [stream.status, chatId, projectId, qc]);

  const rawMessages = useMemo(() => transcript.data?.messages ?? [], [transcript.data]);

  const startStream = useCallback(
    (message: string, fromIndex?: number) => {
      // Fresh chat: mint the thread id here — an empty chatId would collapse
      // every new conversation onto a single server-side row.
      let threadId = chatId;
      if (!threadId) {
        threadId = crypto.randomUUID();
        applyChatId(threadId);
        void navigate({ search: { thread: threadId }, replace: true });
      }
      stream.send("/api/herald/chat/stream", {
        projectId,
        chatId: threadId,
        message,
        // Persona is NOT sent: it resolves server-side from the project's
        // configured Herald Agent (Project Settings → Herald).
        skillId: effectiveSkillId || undefined,
        // Backend contract gap (reported): chat attachments need a storageKey
        // minted by an upload endpoint that doesn't exist yet — images stay
        // local previews until that lands.
        attachments: [],
        // Explicit per-turn override only — omitted = project default.
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(fromIndex !== undefined ? { fromIndex } : {}),
      });
      setEffort("");
    },
    [stream, projectId, chatId, effectiveSkillId, effort, applyChatId, navigate]
  );

  const send = (message: string) => {
    if (!projectId || !message || streaming || suspendedLock) return;
    setTurns((prev) => [...(prev ?? []), { role: "user", text: message, imageCount: images.length, rawIndex: -1 }]);
    setInput("");
    mention.close();
    startStream(message);
    setImages([]);
  };

  // Keep turns up to & including `target` (optionally rewriting its text) —
  // the optimistic view of edit/regenerate/retry until the terminal-state
  // refetch replaces it with server truth.
  const truncateFrom = (target: ChatTurn, replaceText?: string) => {
    setTurns((prev) => {
      const arr = prev ?? [];
      const pos = arr.indexOf(target);
      if (pos < 0) return arr;
      const kept = arr.slice(0, pos + 1);
      return replaceText !== undefined ? kept.map((t, i) => (i === pos ? { ...t, text: replaceText } : t)) : kept;
    });
  };

  // Edit = fork-from-here: truncate the thread at this turn and regenerate.
  const handleEditSave = (target: ChatTurn, draft: string) => {
    const message = draft.trim();
    if (!message || streaming) return;
    const idx = resendIndex(rawMessages, "edit", target.rawIndex) ?? target.rawIndex;
    truncateFrom(target, message);
    startStream(message, idx);
  };

  // Regenerate exists ONLY on the last user turn: resends that message and
  // replaces the trailing assistant reply.
  const handleRegenerate = (target: ChatTurn) => {
    if (streaming) return;
    const idx = resendIndex(rawMessages, "regenerate") ?? target.rawIndex;
    truncateFrom(target);
    startStream(target.text, idx);
  };

  // Retry on a failed/stopped bubble resends ITS triggering user message
  // from that point without duplicating the failed turn.
  const handleRetryTurn = (assistantTurn: ChatTurn) => {
    if (streaming) return;
    const arr = turns ?? [];
    const pos = arr.indexOf(assistantTurn);
    let trigger: ChatTurn | null = null;
    for (let i = pos - 1; i >= 0; i--) {
      if (arr[i]!.role === "user") {
        trigger = arr[i]!;
        break;
      }
    }
    if (!trigger) return;
    const idx = resendIndex(rawMessages, "edit", trigger.rawIndex) ?? trigger.rawIndex;
    truncateFrom(trigger);
    startStream(trigger.text, idx);
  };

  const pasteIntoComposer = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachDisabled) return;
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    const result = acceptImageFiles(files, images, CHAT_CAPS);
    setImages(result.images);
  };

  // Thread switching (History rows / New chat): deep-link via ?thread=.
  // Mid-stream switch aborts the running stream — v1 accepted trade-off.
  const renameChat = useRenameHeraldChat(projectId);
  const deleteChat = useDeleteHeraldChat(projectId);
  const metaChat = useUpdateHeraldChatMeta(projectId);
  const toast = useToast();
  const selectThread = useCallback(
    (id: string) => {
      if (streaming) stream.abort();
      void navigate({ search: { thread: id } });
    },
    [navigate, streaming, stream]
  );
  const startNewChat = useCallback(() => {
    selectThread(crypto.randomUUID());
  }, [selectThread]);

  const headerSub = `${resolved?.name ?? ""} · thread with Herald — not tied to any document`;

  // Stable markdown text-leaf hook (mention chips) — identity must hold
  // across stream deltas or the memoized renderer re-lexes every frame.
  const renderText = useCallback((text: string) => renderTokenized(text, slug), [slug]);

  // Last user turn index in display space — regenerate renders only there.
  const lastUserPos = useMemo(() => {
    const arr = turns ?? [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.role === "user") return i;
    return -1;
  }, [turns]);

  // Post-stream activity summary (done only) — attached to the trailing
  // assistant turn while this tab's session still holds it.
  const streamActivity = useMemo<ActivityView | undefined>(() => {
    if (stream.status !== "done") return undefined;
    if (!stream.reasoningText && stream.tools.length === 0) return undefined;
    return { items: stream.items, tools: stream.tools, reasoningMs: stream.reasoningMs };
  }, [stream.status, stream.items, stream.tools, stream.reasoningText, stream.reasoningMs]);

  // ── Write approvals (herald-write-approvals.html) ──
  // The suspended frame is terminal for the segment: freeze the in-memory
  // bubble (activity + text + chips) into the transcript view as an editable
  // audit trail, then reset the stream session so the resumed turn starts a
  // FRESH assistant entry.
  const frozeBatchRef = useRef<string | null>(null);
  useEffect(() => {
    if (stream.status !== "suspended") return;
    const batchId = stream.suspendedBatchId ?? "";
    if (!batchId || frozeBatchRef.current === batchId) return;
    frozeBatchRef.current = batchId;
    const chips: ApprovalChip[] = stream.pending
      .filter((p) => p.batchId === batchId)
      .map((p) => ({ ...p, state: "pending" as const }));
    const activity: ActivityView | undefined =
      stream.reasoningText || stream.tools.length > 0 || stream.reasoningMs !== null
        ? { items: stream.items, tools: stream.tools, reasoningMs: stream.reasoningMs }
        : undefined;
    setTurns((prev) => [
      ...(prev ?? []),
      {
        role: "assistant",
        text: stream.text,
        imageCount: 0,
        rawIndex: -1,
        ...(activity ? { activity } : {}),
        ...(chips.length > 0 ? { batch: { batchId, chips } } : { suspendedBatchId: batchId }),
      },
    ]);
    stream.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freeze once per suspended batch; snapshot fields are read at flip time
  }, [stream.status]);

  const updateChip = useCallback((approvalId: string, patch: Partial<ApprovalChip> & { state: ApprovalChip["state"] }) => {
    setTurns((prev) =>
      (prev ?? []).map((t) => {
        if (!t.batch || !t.batch.chips.some((c) => c.approvalId === approvalId)) return t;
        return { ...t, batch: { ...t.batch, chips: t.batch.chips.map((c) => (c.approvalId === approvalId ? { ...c, ...patch } : c)) } };
      })
    );
  }, []);

  // One decision = one POST keyed by approvalId; the response's status is
  // authoritative for that chip only — siblings untouched. Server-side 409s
  // flip the chip to their terminal state instead of surfacing as toasts.
  const handleDecide = useCallback(
    async (chip: ApprovalChip, verdict: "approve" | "reject") => {
      try {
        const res = await api.decideHeraldApproval(chip.approvalId, verdict);
        updateChip(chip.approvalId, { state: res.status === "approved" ? "approved" : "rejected" });
      } catch (e) {
        const err = e as Error & { code?: string | undefined; details?: unknown };
        if (err.code === "APPROVAL_EXPIRED") {
          updateChip(chip.approvalId, { state: "expired" });
        } else if (err.code === "APPROVAL_ALREADY_DECIDED") {
          const prev = (err.details as { status?: string } | undefined)?.status;
          updateChip(chip.approvalId, { state: prev === "approved" ? "approved" : prev === "rejected" ? "rejected" : "expired" });
        } else {
          toast.push("error", "Decision failed", err.message);
        }
      }
    },
    [updateChip, toast]
  );

  // "Approve all" loops over still-pending chips only, one decide POST each.
  const [batchBusy, setBatchBusy] = useState(false);
  const handleApproveAll = useCallback(
    (chips: ApprovalChip[]) => {
      const targets = chips.filter((c) => c.state === "pending");
      if (targets.length === 0) return;
      setBatchBusy(true);
      void (async () => {
        try {
          for (const chip of targets) await handleDecide(chip, "approve");
        } finally {
          setBatchBusy(false);
        }
      })();
    },
    [handleDecide]
  );

  // When EVERY chip of a frozen batch reaches a terminal state the client
  // re-opens the stream for that batch — Herald continues with a fresh entry.
  const resumedBatchesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!chatId || streaming) return;
    for (let i = (turns ?? []).length - 1; i >= 0; i--) {
      const b = turns?.[i]!.batch;
      if (!b || resumedBatchesRef.current.has(b.batchId)) continue;
      if (b.chips.some((c) => c.state === "pending")) return;
      resumedBatchesRef.current.add(b.batchId);
      stream.send(`/api/herald/chat/${chatId}/resume`, {});
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send() is stable; guard fires on decision state changes
  }, [turns, chatId, streaming, stream.status]);

  const [editingPos, setEditingPos] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Scroll-to-bottom affordance (herald-chat.html): auto-follow keeps the
  // view pinned to new deltas while at bottom; scrolling up releases the pin
  // until a jump back (button click or manual scroll to bottom).
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const handleTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom(false);
    // stream.items covers tool/reasoning/text item growth — bubble height
    // changes whenever ANY timeline element mounts, not just text deltas.
  }, [turns, stream.text, stream.reasoningText, stream.items, scrollToBottom]);

  const beginEdit = (pos: number) => {
    const arr = turns ?? [];
    setEditingPos(pos);
    setEditDraft(arr[pos]?.text ?? "");
  };
  const cancelEdit = () => {
    setEditingPos(null);
    setEditDraft("");
  };
  const commitEdit = (pos: number) => {
    const arr = turns ?? [];
    const target = arr[pos];
    if (!target) return cancelEdit();
    handleEditSave(target, editDraft);
    setEditingPos(null);
    setEditDraft("");
  };

  return (
    <div className="chat-layout">
      <ThreadsSidebar
        threads={listQuery.data ?? []}
        activeChatId={chatId}
        search={chatSearch}
        onSearchChange={setChatSearch}
        onSelect={selectThread}
        onNewChat={startNewChat}
        onPinToggle={(id, pinned) => void metaChat.mutateAsync({ chatId: id, pinned })}
        onRename={(id, title) => renameChat.mutateAsync({ chatId: id, title })}
        onDelete={(id) =>
          deleteChat.mutateAsync({ chatId: id }).then(() => {
            // Deleting the active thread lands on a fresh chat — the dead
            // uuid would 404 its transcript and linger in localStorage.
            if (id === chatId) startNewChat();
          })
        }
        open={sidebarOpen}
        onToggle={toggleSidebar}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="chat-shell">
      {/* Thread header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px 0" }}>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold text-lx-text-primary">Herald Chat</h1>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{headerSub}</span>
        </div>
      </div>

      {providerMissing ? (
        <div className="chat-scroll">
          <div className="card-panel" style={{ maxWidth: 760, margin: "0 auto" }}>
            <div className="empty-state" style={{ padding: "32px 20px" }}>
              <div className="empty-state-icon">
                <HearthFlameIcon size={24} />
              </div>
              <div className="text-sm font-medium text-lx-text-primary">No AI provider configured</div>
              <p className="text-xs text-lx-text-secondary mt-1" style={{ maxWidth: 260 }}>
                Set up a provider for this project in Project Settings → Herald provider.
              </p>
              {projectId && (
                <Link to="/settings/project/$projectId" params={{ projectId }} className="btn btn-primary btn-sm mt-3" style={{ textDecoration: "none" }}>
                  Open Settings
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Transcript */}
          <div className="chat-transcript">
            <div ref={scrollRef} className="chat-scroll" onScroll={handleTranscriptScroll}>
            <div className="chat-column">
              {(turns ?? []).map((turn, pos) =>
                turn.role === "user" ? (
                  <div key={pos} className="bubble-user">
                    <div className="bubble-meta" style={{ textAlign: "right" }}>You{hhmm(turn.ts) ? ` · ${hhmm(turn.ts)}` : ""}</div>
                    {editingPos === pos ? (
                      <>
                        <textarea
                          autoFocus
                          rows={2}
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              commitEdit(pos);
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              cancelEdit();
                            }
                          }}
                          aria-label="Edit message"
                          style={{ width: "100%", resize: "vertical", background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-focus)", borderRadius: 6, padding: "8px 10px", fontSize: 13, lineHeight: "18px", fontFamily: "var(--lx-font-body)", color: "var(--lx-text-primary)" }}
                        />
                        <div className="flex items-center justify-end gap-2 mt-2">
                          <button type="button" className="btn btn-primary btn-icon-sm" title="Save edit (Enter)" aria-label="Save edit" onClick={() => commitEdit(pos)}>
                            <CheckIcon />
                          </button>
                          <button type="button" className="icon-btn" title="Cancel edit (Esc)" aria-label="Cancel edit" onClick={cancelEdit}>
                            <XIcon />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm text-lx-text-primary" style={{ lineHeight: "20px" }}>{renderTokenized(turn.text, slug)}</div>
                        {turn.imageCount > 0 && (
                          <div className="flex items-center gap-2 mt-2">
                            {Array.from({ length: turn.imageCount }).map((_, j) => (
                              <div key={j} style={{ width: 40, height: 40, border: "1px solid var(--lx-border-default)", borderRadius: 6, background: "var(--lx-surface-card-hover)" }} />
                            ))}
                          </div>
                        )}
                        <div className="bubble-actions">
                          <CopyButton text={turn.text} label="Copy message" />
                          <button type="button" className="icon-btn" title="Edit message" aria-label={`Edit message ${pos + 1}`} onClick={() => beginEdit(pos)}>
                            <EditIcon />
                          </button>
                          {pos === lastUserPos && (
                            <button type="button" className="icon-btn" title="Regenerate from here" aria-label="Regenerate from here" disabled={streaming} onClick={() => handleRegenerate(turn)}>
                              <RegenerateIcon />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                 ) : (
                   // @ts-expect-error — strict: exactOptional indexedAccess
                   <AssistantBubble
                     key={pos}
                     turn={turn}
                     slug={slug}
                     skillName={skillName}
                     projectId={projectId}
                     streaming={streaming}
                     renderText={renderText}
                     activity={turn.activity ?? (streamActivity && pos === (turns?.length ?? 0) - 1 ? streamActivity : undefined)}
                     batchBusy={batchBusy}
                     onDecide={handleDecide}
                     onApproveAll={handleApproveAll}
                     onRetry={() => handleRetryTurn(turn)}
                   />
                  )
              )}

                {streaming && (
                  <div className="bubble-ai">
                    <div className="bubble-meta">Herald · Herald Agent persona{skillName ? ` · ${skillName}` : ""}</div>
                    <HeraldActivity
                      items={stream.items}
                      tools={stream.tools}
                      reasoningActive={stream.reasoningActive}
                      reasoningMs={stream.reasoningMs}
                      renderText={renderText}
                    />
                    {stream.pending.length > 0 && (
                      <HeraldApprovalBatch
                        chips={stream.pending.map((p) => ({ ...p, state: "pending" as const }))}
                        locked
                        onDecide={() => {}}
                        onApproveAll={() => {}}
                      />
                    )}
                  </div>
                )}
             </div>
            </div>
            {!atBottom && (
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm chat-jump-bottom"
                title="Jump to latest"
                aria-label="Jump to latest"
                onClick={() => scrollToBottom(true)}
              >
                <ArrowDown size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>

          {/* Composer */}
          <div className="chat-composer">
            <div className="chat-composer-inner">
              {/* Skill picker — collapsed by default to a one-line summary
                  (skill name + chevron). Tapping expands the chip row. */}
              <div className="skills-panel">
                <button
                  type="button"
                  className="skills-panel-toggle"
                  aria-expanded={skillsPanelOpen}
                  onClick={() => setSkillsPanelOpen((v) => !v)}
                >
                  <span className="prop-label">Skill</span>
                  <span className="skills-panel-current">
                    {skillName ?? "None"}
                  </span>
                  {skillsPanelOpen ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}
                </button>
                {skillsPanelOpen && (
                  <div className="skills-panel-body">
                    <SkillPicker
                      skills={heraldSkills}
                      skillId={effectiveSkillId}
                      onSkillChange={setSkillId}
                      layout="inline"
                      allowNoSkill
                    />
                  </div>
                )}
              </div>

              {engineGate && (
                <div className="banner-warning mb-2">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
                    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                  </svg>
                  <span><span className="font-mono font-medium">ENGINE_NOT_SUPPORTED_FOR_CHAT</span> — this project's default engine is Blacksmith. Freeform chat needs the Herald engine; ask an admin to switch it in Project Settings → Herald.</span>
                </div>
              )}
              {busy409 && (
                <div className="banner-warning mb-2">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
                    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                  </svg>
                  <span><span className="font-mono font-medium">HERALD_TASK_ACTIVE</span> — Herald is already responding in this thread. Stop the current reply to send something new.</span>
                </div>
              )}

              <div className="composer" style={{ ...(busy409 || suspendedLock ? { opacity: 0.55 } : {}), position: "relative" }}>
                {mention.open && (
                  <div className="dropdown-menu mention-popup" role="listbox" style={mention.popupStyle ?? undefined}>
                    {mention.items.length === 0 ? (
                      <div className="dropdown-item" style={{ cursor: "default", color: "var(--lx-text-muted)" }}>No matches</div>
                    ) : (
                      <>
                        {mention.items.some((it) => it.refType === "task") && <div className="dropdown-label">Tasks</div>}
                        {mention.items.map((it, idx) =>
                          // @ts-expect-error — strict: exactOptional indexedAccess
                          idx > 0 && mention.items[idx - 1!].refType !== it.refType && (
                            <div key={`sep-${idx}`} className="dropdown-separator" />
                          )
                        )}
                        {mention.items.map((it, idx) => (
                          <div
                            key={`${it.refType}-${it.refId}`}
                            role="option"
                            aria-selected={idx === mention.focusedIndex}
                            className={idx === mention.focusedIndex ? "dropdown-item focused" : "dropdown-item"}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              mention.handleSelect(composerRef.current);
                            }}
                          >
                            {it.refType === "task" ? (
                              <>
                                <span className="task-key" style={{ fontSize: 13 }}>{it.label}</span>
                                <span className="truncate flex-1 min-w-0">{it.sublabel}</span>
                              </>
                            ) : (
                              <>
                                <span className="truncate flex-1 min-w-0">{it.label}</span>
                                <span className="font-mono text-xs text-lx-text-muted">{it.sublabel}</span>
                              </>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  className="composer-editor w-full"
                  rows={2}
                  placeholder={streaming ? "Herald is responding…" : suspendedLock ? "Decide the pending changes above…" : "Ask Herald anything about this project…"}
                  value={input}
                  onChange={mention.handleChange}
                  onPaste={pasteIntoComposer}
                  onSelect={mention.handleSelectCaret}
                  onKeyDown={(e) => {
                    if (mention.handleKeyDown(e)) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input.trim());
                    }
                  }}
                  disabled={streaming || busy409 || suspendedLock}
                  style={{ border: "none", background: "transparent" }}
                />
                <div className="composer-footer">
                  {streaming ? (
                    <>
                      <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">● Streaming…</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ borderColor: "rgba(255,68,68,0.45)", color: "var(--lx-text-danger)" }}
                        onClick={() => stream.abort()}
                      >
                        <Square size={12} strokeWidth={1.5} fill="currentColor" />
                        Stop
                      </button>
                    </>
                  ) : suspendedLock ? (
                    <>
                      <span className="font-micro text-2xs text-lx-text-warning" style={{ transform: "uppercase", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        ● Turn suspended{suspendTally ? ` — ${suspendTally}` : ""}
                      </span>
                      <button type="button" className="btn btn-primary btn-sm" disabled>
                        Send
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <HeraldImageAttach
                          images={images}
                          onChange={setImages}
                          caps={CHAT_CAPS}
                          hint=""
                          compact
                          disabled={attachDisabled}
                          disabledTitle={ATTACH_DISABLED_TITLE}
                        />
                        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">≤3 images · ≤1.5MB total</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <EffortPicker effort={effort} projectEffort={settings?.reasoningEffort ?? null} disabled={streaming} align={isMobileComposer ? "up" : "down"} onChange={setEffort} />
                        <button type="button" className="btn btn-primary btn-sm" disabled={!input.trim() || busy409} onClick={() => send(input.trim())}>
                          Send
                          <Send size={12} strokeWidth={1.5} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </main>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, mark] = useCopied();
  return (
    <button
      type="button"
      className="icon-btn"
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={() => void copyToClipboard(text).then(mark)}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function AssistantBubble({
  turn,
  slug,
  skillName,
  projectId,
  streaming,
  renderText,
  activity,
  batchBusy,
  onDecide,
  onApproveAll,
  onRetry,
}: {
  turn: ChatTurn;
  slug: string;
  skillName?: string | undefined;
  projectId?: string | undefined;
  streaming: boolean;
  renderText: (text: string) => ReactNode;
  activity?: ActivityView;
  batchBusy: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: (chips: ApprovalChip[]) => void;
  onRetry: () => void;
}) {
  const time = hhmm(turn.ts);
  // Persona label mirrors the project's configured agent (read-only — chat
  // always runs the Herald lane, so it is always the Herald Agent).
  const meta = `Herald · Herald Agent persona${skillName ? ` · ${skillName}` : ""}${turn.stopped ? " · stopped" : ""}`;
  const segments = useMemo(() => splitFences(turn.text), [turn.text]);
  const citations = turn.citations;
  const guidance = turn.error ? guidanceFor(turn.error.code) : null;
  const body = turn.error
    ? turn.error.message?.trim() || GUIDANCE_BODY[turn.error.code] || "The reply failed. Nothing was added to the thread."
    : null;

  return (
    <div className="bubble-ai">
      <div className="bubble-meta">
        {meta}
        {time ? ` · ${time}` : ""}
        <span className="bubble-meta-copy">
          <CopyButton text={turn.text} label="Copy reply" />
        </span>
      </div>

      {turn.error ? (
        <div
          style={{
            background: "var(--lx-bg-danger-subtle)",
            border: "1px solid rgba(220,38,38,0.25)",
            borderRadius: "12px 12px 12px 4px",
            padding: "10px 14px",
          }}
        >
          <div className="font-mono text-xs font-medium" style={{ color: "var(--lx-text-danger)" }}>{turn.error.code}</div>
          <div className="text-xs text-lx-text-secondary mt-1" style={{ lineHeight: "16px" }}>{body}</div>
          {guidance === "settings" && projectId && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-lx-text-secondary">Fix provider settings:</span>
              <Link
                to="/settings/project/$projectId"
                params={{ projectId }}
                className="chip"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px", color: "var(--lx-text-link)", textDecoration: "none" }}
              >
                <GearIcon />
                <span className="font-micro text-2xs">Project Settings → Herald</span>
                <ExternalIcon />
              </Link>
            </div>
          )}
          {guidance === "retry" && (
            <div className="mt-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={streaming} onClick={onRetry}>
                <RegenerateIcon />
                Retry
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {activity && (
            <HeraldActivity
              items={activity.items}
              tools={activity.tools}
              reasoningActive={false}
              reasoningMs={activity.reasoningMs}
              done
            />
          )}
          {segments.map((seg, i) =>
            seg.fenced ? (
              <div key={i} className="herald-codeblock">
                <span className="herald-codeblock-chrome">
                  {seg.lang && <span className="herald-codeblock-lang">{seg.lang}</span>}
                  <CopyButton text={seg.body} label="Copy code" />
                </span>
                <code
                  className="hljs-theme"
                  dangerouslySetInnerHTML={{ __html: highlightCode(seg.body, seg.lang) }}
                />
              </div>
            ) : (
              <div key={i} className="bubble-md">
                <MarkdownContent md={seg.body} renderText={renderText} />
              </div>
            )
          )}
          {turn.batch && turn.batch.chips.length > 0 && (
            <HeraldApprovalBatch
              chips={turn.batch.chips}
              locked={batchBusy}
              onDecide={onDecide}
              onApproveAll={() => onApproveAll(turn.batch!.chips)}
            />
          )}
          {(turn.batch ? turn.batch.chips.some((c) => c.state === "pending") : !!turn.suspendedBatchId) && <SuspendedIndicator />}
          {citations && citations.length > 0 && (
            <div className="flex items-center mt-2" style={{ gap: 6, flexWrap: "wrap" }}>
              {citations.map((c) => (
                <a
                  key={c.url}
                  className="chip"
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 8px", textDecoration: "none" }}
                  title={c.url}
                >
                  <GlobeIcon />
                  <span className="font-micro text-2xs text-lx-text-muted">{c.hostname}</span>
                  <span className="font-micro text-2xs text-lx-text-secondary truncate" style={{ maxWidth: 160 }}>{c.title ?? c.hostname}</span>
                  <ExternalIcon />
                </a>
              ))}
            </div>
          )}
          {turn.stopped && (
            <div className="flex items-center gap-2 mt-2">
              <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>● Stopped</span>
              <span style={{ flex: 1, height: 1, background: "var(--lx-border-subtle)" }} />
              <button type="button" className="btn btn-primary btn-sm" disabled={streaming} onClick={onRetry}>
                <RegenerateIcon />
                Retry
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ModelMessage JSON → display turns. Text parts carry their payload in
// `content` (server wire shape); plain string content is the common case.
// Optional inline meta (ts / citations / error / stopped) is read
// defensively — legacy entries lack all of it. rawIndex preserves the
// position in the RAW messages array for resend targeting.
export function renderTranscript(messages: unknown[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (let rawIndex = 0; rawIndex < messages.length; rawIndex++) {
    const msg = messages[rawIndex] as {
      role?: string | undefined;
      content?: unknown;
      ts?: unknown;
      citations?: unknown;
      error?: unknown;
      stopped?: unknown;
      pendingBatch?: unknown;
    };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    let text = "";
    let imageCount = 0;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: string | undefined; content?: unknown; text?: unknown }>) {
        if (part.type === "image-ref") imageCount++;
        else text += String(part.content ?? part.text ?? "");
      }
    }
    // Suspended-turn marker (legacy string batchId or PendingBatchMarker
    // object) — chip payloads are NOT in the transcript; the waiting
    // indicator renders without them.
    const pendingBatchId =
      typeof msg.pendingBatch === "string"
        ? msg.pendingBatch
        : msg.pendingBatch && typeof msg.pendingBatch === "object" &&
            typeof (msg.pendingBatch as { batchId?: unknown }).batchId === "string"
          ? (msg.pendingBatch as { batchId: string }).batchId
          : null;
    if (!text && !imageCount && !msg.error && !msg.stopped && pendingBatchId === null) continue;
    const citations = msg.role === "assistant" ? safeCitations(msg.citations) : [];
    const err = isErrorMeta(msg.error);
    out.push({
      role: msg.role,
      text,
      imageCount,
      rawIndex,
      ...(typeof msg.ts === "string" ? { ts: msg.ts } : {}),
      ...(citations.length > 0 ? { citations } : {}),
      ...(err ? { error: err } : {}),
      ...(msg.stopped === true ? { stopped: true } : {}),
      ...(pendingBatchId !== null ? { suspendedBatchId: pendingBatchId } : {}),
    });
  }
  return out;
}

function isErrorMeta(raw: unknown): { code: string; message: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as { code?: unknown; message?: unknown };
  if (typeof e.code !== "string" || !e.code) return undefined;
  return { code: e.code, message: typeof e.message === "string" ? e.message : "" };
}