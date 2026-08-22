import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Zap, Send, Square } from "lucide-react";
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
import { useToast } from "../ui/Toast";
import { useHeraldStream } from "../../lib/use-herald-stream";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { resendIndex } from "../../lib/resendIndex";
import { copyToClipboard } from "../../lib/clipboard";
import { useMentionTokens } from "../../lib/useMentionTokens";
import { renderTokenized } from "../../lib/tokenizeTranscript";
import { ChatHistoryDropdown } from "./ChatHistoryDropdown";
import { AgentSkillPicker } from "../forge/herald/AgentSkillPicker";
import { HeraldToolChips } from "../forge/herald/HeraldToolChips";
import { HeraldImageAttach, acceptImageFiles } from "../forge/herald/HeraldImageAttach";
import type { HeraldImage } from "../forge/herald/HeraldImageAttach";

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
  ts?: string;
  citations?: CitationView[];
  error?: { code: string; message: string };
  stopped?: boolean;
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
// render as a mono block with their own copy button (frontend-only).
export function splitFences(text: string): { fenced: boolean; body: string }[] {
  const parts = text.split("```");
  return parts
    .map((body, i) => ({ fenced: i % 2 === 1, body: i % 2 === 1 ? body.replace(/^[a-zA-Z0-9_-]*\n/, "") : body }))
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
  const { data: project } = useQuery({
    queryKey: ["project", slug],
    queryFn: () => api.getProject(slug),
    enabled: !projectFromList,
  });
  const resolved = projectFromList ?? project;
  const projectId = resolved?.id;

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
    if (transcript.data) {
      setTurns(renderTranscript(transcript.data.messages));
    }
    if (transcript.error) {
      setTurns([]);
    }
  }, [transcript.data, transcript.error]);

  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const [selection, setSelection] = useState({ agentId: "", skillId: "" });
  const effectiveAgentId = selection.agentId !== "" ? selection.agentId : (agents.find((a) => a.id === "lexa")?.id ?? agents[0]?.id ?? "");
  const agentSkillIds = new Set(agents.find((a) => a.id === effectiveAgentId)?.skillIds ?? []);
  const effectiveSkillId = agentSkillIds.has(selection.skillId) ? selection.skillId : "";

  const streamKey = projectId ? `herald-chat:${chatId}` : null;
  const stream = useHeraldStream(streamKey);
  const streaming = stream.status === "connecting" || stream.status === "streaming";

  const [input, setInput] = useState("");
  const [images, setImages] = useState<HeraldImage[]>([]);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // "@" mentions over the plain composer textarea (mentions-autocomplete.html).
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionTokens({ slug, value: input, onChange: setInput });

  const busy409 = stream.status === "error" && stream.error?.code === "HERALD_TASK_ACTIVE";
  const failed = stream.status === "error" && stream.error?.code !== "HERALD_TASK_ACTIVE";
  const providerMissing = !settingsLoading && settings === null;

  const agentName = agents.find((a) => a.id === effectiveAgentId)?.name;
  const skillName = skills.find((s) => s.id === effectiveSkillId)?.name;

  // Terminal stream states refetch the transcript so persisted partials,
  // errors and citations appear without a reload.
  useEffect(() => {
    if (!chatId) return;
    if (stream.status === "done" || stream.status === "error" || stream.status === "aborted") {
      void qc.invalidateQueries({ queryKey: ["herald-chat", chatId] });
    }
  }, [stream.status, chatId, qc]);

  const rawMessages = useMemo(() => transcript.data?.messages ?? [], [transcript.data]);

  const startStream = useCallback(
    (message: string, fromIndex?: number) => {
      stream.send("/api/herald/chat/stream", {
        projectId,
        chatId,
        message,
        agentId: effectiveAgentId || undefined,
        skillId: effectiveSkillId || undefined,
        // Backend contract gap (reported): chat attachments need a storageKey
        // minted by an upload endpoint that doesn't exist yet — images stay
        // local previews until that lands.
        attachments: [],
        ...(fromIndex !== undefined ? { fromIndex } : {}),
      });
    },
    [stream, projectId, chatId, effectiveAgentId, effectiveSkillId]
  );

  const send = (message: string) => {
    if (!projectId || !message || streaming) return;
    setLastMessage(message);
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
    setLastMessage(message);
    truncateFrom(target, message);
    startStream(message, idx);
  };

  // Regenerate exists ONLY on the last user turn: resends that message and
  // replaces the trailing assistant reply.
  const handleRegenerate = (target: ChatTurn) => {
    if (streaming) return;
    const idx = resendIndex(rawMessages, "regenerate") ?? target.rawIndex;
    setLastMessage(target.text);
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
      if (arr[i].role === "user") {
        trigger = arr[i];
        break;
      }
    }
    if (!trigger) return;
    const idx = resendIndex(rawMessages, "edit", trigger.rawIndex) ?? trigger.rawIndex;
    setLastMessage(trigger.text);
    truncateFrom(trigger);
    startStream(trigger.text, idx);
  };

  const pasteIntoComposer = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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

  const handleExport = useCallback(
    (id: string) => {
      void api.exportHeraldChat(id).catch((err: Error & { code?: string }) => {
        toast.push("error", "Export failed", err.code ?? err.message);
      });
    },
    [toast]
  );

  const handleResetConfirm = async () => {
    if (!projectId || !chatId) return;
    try {
      await deleteChat.mutateAsync({ chatId });
      setTurns([]);
      const fresh = crypto.randomUUID();
      applyChatId(fresh);
      void navigate({ search: { thread: fresh }, replace: true });
      setResetOpen(false);
      setResetError(null);
    } catch (err) {
      setResetError((err as { code?: string }).code ?? (err as Error).message);
    }
  };

  const headerSub = `${resolved?.name ?? ""} · thread with Herald — not tied to any document`;

  // Last user turn index in display space — regenerate renders only there.
  const lastUserPos = useMemo(() => {
    const arr = turns ?? [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].role === "user") return i;
    return -1;
  }, [turns]);

  const [editingPos, setEditingPos] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Banner-retry optimistic truncation: the failed attempt's trigger is the
  // last user turn in display space — drop everything after it so the resent
  // turn doesn't duplicate.
  const truncateAfterLastUser = () => {
    setTurns((prev) => {
      const arr = prev ?? [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].role === "user") return arr.slice(0, i + 1);
      }
      return arr;
    });
  };

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
    <main className="chat-shell">
      {/* Thread header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px 0" }}>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold text-lx-text-primary">Herald Chat</h1>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{headerSub}</span>
        </div>
        <div className="flex items-center gap-2">
          <ChatHistoryDropdown
            threads={listQuery.data ?? []}
            activeChatId={chatId}
            search={chatSearch}
            onSearchChange={setChatSearch}
            onSelect={selectThread}
            onNewChat={startNewChat}
            onPinToggle={(id, pinned) => void metaChat.mutateAsync({ chatId: id, pinned })}
            onExport={handleExport}
            onRename={(id, title) => renameChat.mutateAsync({ chatId: id, title })}
            onDelete={(id) => deleteChat.mutateAsync({ chatId: id })}
          />
          <button type="button" className="btn btn-danger btn-sm" onClick={() => { setResetOpen(true); setResetError(null); }}>
            Delete chat
          </button>
        </div>
      </div>

      {providerMissing ? (
        <div className="chat-scroll">
          <div className="card-panel" style={{ maxWidth: 760, margin: "0 auto" }}>
            <div className="empty-state" style={{ padding: "32px 20px" }}>
              <div className="empty-state-icon">
                <Zap size={24} strokeWidth={1.5} />
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
          <div className="chat-scroll">
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
                          <button type="button" className="btn btn-ghost btn-icon-sm" title="Cancel edit (Esc)" aria-label="Cancel edit" onClick={cancelEdit}>
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
                  <AssistantBubble
                    key={pos}
                    turn={turn}
                    slug={slug}
                    agentName={agentName}
                    skillName={skillName}
                    projectId={projectId}
                    streaming={streaming}
                    onRetry={() => handleRetryTurn(turn)}
                  />
                )
              )}

              {streaming && (
                <div className="bubble-ai">
                  <div className="bubble-meta">Herald{agentName ? ` · ${agentName}` : ""}{skillName ? ` · ${skillName}` : ""}</div>
                  {stream.tools.length > 0 && (
                    <div className="flex items-center gap-2 mb-2" style={{ flexWrap: "wrap" }}>
                      <HeraldToolChips tools={stream.tools} />
                    </div>
                  )}
                  <div className="text-sm text-lx-text-secondary font-mono" style={{ lineHeight: "20px", fontSize: 12, whiteSpace: "pre-wrap" }}>
                    {stream.text}
                    <span style={{ color: "var(--lx-border-focus)" }}>▍</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Composer */}
          <div className="chat-composer">
            <div className="chat-composer-inner">
              <AgentSkillPicker
                agents={agents}
                skills={skills}
                selection={{ agentId: effectiveAgentId, skillId: effectiveSkillId }}
                onChange={(next) => setSelection({ agentId: next.agentId, skillId: next.skillId })}
                layout="inline"
                allowNoSkill
              />

              {busy409 && (
                <div className="banner-warning mb-2">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
                    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                  </svg>
                  <span><span className="font-mono font-medium">HERALD_TASK_ACTIVE</span> — Herald is already responding in this thread. Stop the current reply to send something new.</span>
                </div>
              )}
              {failed && (
                <div className="notice notice-danger mb-2" style={{ alignItems: "center" }}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4" />
                    <path d="M12 16h.01" />
                  </svg>
                  <div className="flex-1">
                    <span className="font-mono text-xs font-medium">{stream.error?.code}</span>
                    <span className="text-xs" style={{ marginLeft: 8 }}>{stream.error?.message}</span>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, color: "var(--lx-text-primary)" }} onClick={() => stream.reset()}>Dismiss</button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    style={{ flexShrink: 0 }}
                    onClick={() => {
                      if (!lastMessage) return;
                      const idx = resendIndex(rawMessages, "retry");
                      truncateAfterLastUser();
                      startStream(lastMessage, idx ?? undefined);
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}

              <div className="composer" style={{ ...(busy409 ? { opacity: 0.55 } : {}), position: "relative" }}>
                {mention.open && (
                  <div className="dropdown-menu mention-popup" role="listbox" style={mention.popupStyle ?? undefined}>
                    {mention.items.length === 0 ? (
                      <div className="dropdown-item" style={{ cursor: "default", color: "var(--lx-text-muted)" }}>No matches</div>
                    ) : (
                      <>
                        {mention.items.some((it) => it.refType === "task") && <div className="dropdown-label">Tasks</div>}
                        {mention.items.map((it, idx) =>
                          idx > 0 && mention.items[idx - 1].refType !== it.refType && (
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
                  placeholder={streaming ? "Herald is responding…" : "Ask Herald anything about this project…"}
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
                  disabled={streaming || busy409}
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
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <HeraldImageAttach images={images} onChange={setImages} caps={CHAT_CAPS} hint="" compact />
                        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">≤3 images · ≤1.5MB total</span>
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" disabled={!input.trim() || busy409} onClick={() => send(input.trim())}>
                        Send
                        <Send size={12} strokeWidth={1.5} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Delete confirm (current thread) */}
      {resetOpen && (
        <>
          <button type="button" className="slideover-overlay" onClick={() => setResetOpen(false)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Delete this chat?">
              <div className="flex items-center justify-between mb-2">
                <span className="font-display text-base font-semibold text-lx-text-primary">Delete this chat?</span>
                <button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => setResetOpen(false)} aria-label="Cancel delete">✕</button>
              </div>
              <p className="text-xs text-lx-text-secondary" style={{ lineHeight: "18px" }}>
                This deletes the current transcript for you in {resolved?.name ?? "this project"} — both turns and attachments. The view lands on a fresh empty chat. This cannot be undone.
              </p>
              {resetError && (
                <div className="notice notice-danger mt-3">
                  <span className="font-mono text-xs font-medium">{resetError}</span>
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mt-4">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResetOpen(false)}>Cancel</button>
                <button type="button" className="btn btn-danger-solid btn-sm" onClick={handleResetConfirm}>Delete chat</button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </main>
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
  agentName,
  skillName,
  projectId,
  streaming,
  onRetry,
}: {
  turn: ChatTurn;
  slug: string;
  agentName?: string;
  skillName?: string;
  projectId?: string;
  streaming: boolean;
  onRetry: () => void;
}) {
  const time = hhmm(turn.ts);
  const meta = `Herald${agentName ? ` · ${agentName}` : ""}${skillName ? ` · ${skillName}` : ""}${turn.stopped ? " · stopped" : ""}`;
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
              <button type="button" className="btn btn-ghost-accent btn-sm" disabled={streaming} onClick={onRetry}>
                <RegenerateIcon />
                Retry
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {segments.map((seg, i) =>
            seg.fenced ? (
              <div
                key={i}
                style={{
                  position: "relative",
                  background: "var(--lx-surface-input)",
                  border: "1px solid var(--lx-border-default)",
                  borderRadius: 6,
                  padding: "8px 28px 8px 10px",
                  marginTop: i === 0 ? 0 : 8,
                  fontFamily: "var(--lx-font-mono)",
                  fontSize: 12,
                  lineHeight: "20px",
                  whiteSpace: "pre-wrap",
                  color: "var(--lx-text-secondary)",
                }}
              >
                <span style={{ position: "absolute", top: 4, right: 4 }}><CopyButton text={seg.body} label="Copy code" /></span>
                {seg.body}
              </div>
            ) : (
              <div key={i} className="text-sm text-lx-text-primary" style={{ lineHeight: "22px", whiteSpace: "pre-wrap" }}>
                {renderTokenized(seg.body, slug)}
              </div>
            )
          )}
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
              <button type="button" className="btn btn-ghost-accent btn-sm" disabled={streaming} onClick={onRetry}>
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
      role?: string;
      content?: unknown;
      ts?: unknown;
      citations?: unknown;
      error?: unknown;
      stopped?: unknown;
    };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    let text = "";
    let imageCount = 0;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: string; content?: unknown; text?: unknown }>) {
        if (part.type === "image-ref") imageCount++;
        else text += String(part.content ?? part.text ?? "");
      }
    }
    if (!text && !imageCount && !msg.error && !msg.stopped) continue;
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
