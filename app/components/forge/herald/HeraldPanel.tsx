import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Link } from "@tanstack/react-router";
import { Check, RefreshCw, Square, Zap } from "lucide-react";
import { markdownToDoc, docToMarkdown } from "../../../../shared/markdown";
import type { Attachment, TipTapDoc } from "../../../../shared/types";
import type { HeraldSettingsMasked } from "../../../../shared/herald";
import {
  useProjects,
  useAgents,
  useSkills,
  useHeraldSettings,
  useCreateHeraldTask,
  useCancelHeraldTask,
  useTaskAttachments,
  useWikiAttachments,
} from "../../../lib/queries";
import { useHeraldStream } from "../../../lib/use-herald-stream";
import { AgentSkillPicker } from "./AgentSkillPicker";
import { HeraldModePicker } from "./HeraldModePicker";
import { HeraldToolChips } from "./HeraldToolChips";
import type { ForgeMode } from "./HeraldModePicker";

// Herald tier panel inside the Forge popover — transcribed from
// wireframes/src/herald-popover.html (States 1–7). Streaming sessions live
// in the module-level stream store: closing the popover does NOT stop the
// run; reopening reattaches to the live/final state.

// Embedded /api/attachments/<uuid> image nodes in the open document are the
// only image source for a Herald run (herald-popover.html State 1/5) — same
// exact-shape uuid rule as shared/markdown.ts safeImageSrc.
const ATTACHMENT_SRC_RE = /^\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function docAttachmentIds(editor: Editor): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; attrs?: Record<string, unknown> | null; content?: unknown };
    if (n.type === "image" && typeof n.attrs?.src === "string") {
      const m = ATTACHMENT_SRC_RE.exec(n.attrs.src.trim());
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(editor.state.doc.toJSON());
  return ids;
}

export function HeraldPanel({ editor, slug, documentType, documentId, onModeChange, onClose }: {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  onModeChange: (mode: ForgeMode) => void;
  onClose: () => void;
}) {
  const { data: projects = [] } = useProjects();
  const projectId = projects.find((p) => p.slug === slug)?.id;
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  // null after load = PROVIDER_NOT_CONFIGURED → empty state + disabled Generate.
  const { data: settings, isLoading: settingsLoading } = useHeraldSettings(projectId);

  const [selection, setSelection] = useState({ agentId: "", skillId: "" });
  const [prompt, setPrompt] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const createTask = useCreateHeraldTask();
  const cancelTask = useCancelHeraldTask();

  // Images ride from the document, never manual attach: ids embedded in the
  // open doc mapped to attachment rows (taskId / wiki pageSlug per type).
  const { data: taskAttachmentRows } = useTaskAttachments(slug, documentType === "task" ? documentId : "");
  const { data: wikiAttachmentRows } = useWikiAttachments(slug, documentType === "wiki" ? documentId : "");
  const attachmentRows = documentType === "task" ? taskAttachmentRows : wikiAttachmentRows;
  const docImages = useMemo(() => {
    const byId = new Map((attachmentRows ?? []).map((a) => [a.id, a]));
    return docAttachmentIds(editor)
      .map((id) => byId.get(id))
      .filter((a): a is Attachment => a !== undefined);
  }, [editor, attachmentRows]);

  const effectiveAgentId = selection.agentId !== "" ? selection.agentId : (agents.find((a) => a.id === "lexa")?.id ?? agents[0]?.id ?? "");
  const agentSkillIds = new Set(agents.find((a) => a.id === effectiveAgentId)?.skillIds ?? []);
  const effectiveSkillId = agentSkillIds.has(selection.skillId)
    ? selection.skillId
    : skills.find((s) => agentSkillIds.has(s.id))?.id ?? "";

  const streamKey = taskId ? `herald-task:${taskId}` : null;
  const stream = useHeraldStream(streamKey);

  // Enqueue → open the SSE stream exactly once per task id.
  const streamedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    if (taskId && streamedTaskRef.current !== taskId) {
      streamedTaskRef.current = taskId;
      stream.send(`/api/herald/tasks/${taskId}/stream`, {});
    }
  }, [taskId]);

  const running = stream.status === "connecting" || stream.status === "streaming";
  const done = stream.status === "done";
  const failed = stream.status === "error";

  const selectionText = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
  const selectionMarkdown = selectionText ? selectionToMarkdown(editor) : "";

  const handleGenerate = () => {
    if (!effectiveAgentId || !effectiveSkillId) return;
    createTask.mutate(
      {
        slug,
        documentType,
        documentId,
        prompt: prompt.trim(),
        agentId: effectiveAgentId,
        skillId: effectiveSkillId,
        ...(selectionMarkdown ? { selection: selectionMarkdown } : {}),
        // Attachment rows expose sha256 but not storage_key; Lexa/Storage
        // keys are deterministic (storageKeyFor → blobs/<sha256>) so the ref
        // is rebuilt here until the API exposes storage_key directly.
        ...(docImages.length
          ? {
              attachments: docImages.map((a) => ({
                storageKey: `blobs/${a.sha256}`,
                mimeType: a.mimeType,
                name: a.filename,
              })),
            }
          : {}),
      },
      { onSuccess: (task) => setTaskId(task.id) }
    );
  };

  const handleStop = () => {
    if (!taskId) return;
    stream.abort();
    cancelTask.mutate(taskId);
  };

  const handleDismiss = () => setTaskId(null);

  const handleInsert = () => {
    if (!stream.text) return;
    const doc = markdownToDoc(stream.text);
    editor.chain().focus().insertContent(doc.content ?? []).run();
    onClose();
  };

  const providerMissing = !settingsLoading && settings === null;

  const headerRight = running ? (
    <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">● Generating…</span>
  ) : done ? (
    <span className="font-micro text-2xs text-lx-text-success uppercase tracking-[0.04em]">Ready</span>
  ) : failed ? (
    <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">Failed</span>
  ) : (
    <HeraldModePicker mode="herald" onChange={onModeChange} />
  );

  return (
    <>
      <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="text-sm font-medium text-lx-text-primary font-body">Forge</span>
        {headerRight}
      </div>

      {providerMissing && (
        <>
          <div className="empty-state" style={{ padding: "32px 20px" }}>
            <div className="empty-state-icon">
              <Zap size={24} strokeWidth={1.5} />
            </div>
            <div className="text-sm font-medium text-lx-text-primary">No AI provider configured</div>
            <p className="text-xs text-lx-text-secondary mt-1" style={{ maxWidth: 240 }}>
              Herald runs against a per-project provider endpoint. Set one up in Project Settings → Herald provider.
            </p>
            {projectId && (
              <Link
                to="/settings/project/$projectId"
                params={{ projectId }}
                className="btn btn-primary btn-sm mt-3"
                style={{ textDecoration: "none" }}
              >
                Open Settings
              </Link>
            )}
          </div>
          <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
            <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">PROVIDER_NOT_CONFIGURED · 409</span>
            <button type="button" className="btn btn-primary btn-sm" disabled style={{ opacity: 0.45 }}>Generate</button>
          </div>
        </>
      )}

      {!providerMissing && running && (
        <>
          <div style={{ padding: "10px 12px 0" }}>
            <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Tools</span>
            <HeraldToolChips tools={stream.tools} />
          </div>
          <StreamingPreview text={stream.text} />
          <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{providerLine(settings)}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ borderColor: "rgba(255,68,68,0.45)", color: "var(--lx-text-danger)" }}
              onClick={handleStop}
            >
              <Square size={12} strokeWidth={1.5} fill="currentColor" />
              Stop
            </button>
          </div>
        </>
      )}

      {!providerMissing && done && (
        <>
          <div style={{ padding: "10px 12px" }}>
            <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
              Result <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>raw markdown</span>
            </span>
            <div style={monoBox(200)}>{stream.text}</div>
          </div>
          <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
              ↑ {(stream.usage?.in ?? 0).toLocaleString()} · ↓ {(stream.usage?.out ?? 0).toLocaleString()} tokens
            </span>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={handleDismiss}>Discard</button>
              <button type="button" className="btn btn-primary" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={handleInsert}>
                <Check size={12} strokeWidth={2.5} />
                Insert
              </button>
            </div>
          </div>
        </>
      )}

      {!providerMissing && failed && (
        <div style={{ padding: 12 }}>
          <div className="notice notice-danger" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <div className="flex items-center gap-2">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              <span className="font-mono text-xs font-medium">{stream.error?.code}</span>
            </div>
            <span className="text-xs" style={{ lineHeight: "16px" }}>{stream.error?.message}</span>
          </div>
          {/* Retry re-enqueues with the same prompt/agent/skill and returns
              the panel to streaming; Dismiss clears back to idle — the
              thread keeps prior turns. */}
          <div className="flex items-center justify-end gap-2 mt-3">
            <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={handleDismiss}>Dismiss</button>
            <button type="button" className="btn btn-primary" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={handleGenerate}>
              <RefreshCw size={12} strokeWidth={1.5} />
              Retry
            </button>
          </div>
        </div>
      )}

      {!providerMissing && !running && !done && !failed && (
        <>
          <AgentSkillPicker
            agents={agents}
            skills={skills}
            selection={{ agentId: effectiveAgentId, skillId: effectiveSkillId }}
            onChange={(next) => setSelection({ agentId: next.agentId, skillId: next.skillId })}
          />
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
            <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
              Additional prompt <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>Optional</span>
            </span>
            <textarea
              className="prop-input w-full"
              rows={3}
              aria-label="Additional prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should Herald write?"
              style={{ fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
            />
            {docImages.length > 0 ? (
              <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
                {docImages.map((a) => (
                  <div
                    key={a.id}
                    title={a.filename}
                    style={{
                      width: 28,
                      height: 28,
                      border: "1px solid var(--lx-border-default)",
                      borderRadius: 4,
                      background: "var(--lx-surface-card-hover)",
                      overflow: "hidden",
                      flexShrink: 0,
                    }}
                  >
                    <img src={`/api/attachments/${a.id}`} alt={a.filename} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </div>
                ))}
                <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                  From document · {docImages.length} image{docImages.length === 1 ? "" : "s"}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
                <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">No images in document</span>
              </div>
            )}
          </div>
          <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
              {selectionText ? `Selection: ${selectionText.length} chars` : "No selection"}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleGenerate}
              disabled={createTask.isPending || !settings || !effectiveAgentId || !effectiveSkillId}
            >
              <Zap size={12} strokeWidth={1.5} />
              {createTask.isPending ? "Starting…" : "Generate"}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function monoBox(maxHeight: number): React.CSSProperties {
  return {
    background: "var(--lx-surface-input)",
    border: "1px solid var(--lx-border-default)",
    borderRadius: 6,
    padding: "10px 12px",
    fontFamily: "var(--lx-font-mono)",
    fontSize: 11,
    lineHeight: "18px",
    color: "var(--lx-text-secondary)",
    maxHeight,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  };
}

function providerLine(settings: HeraldSettingsMasked | null | undefined): string {
  let host = "";
  try {
    if (settings?.baseUrl) host = `${new URL(settings.baseUrl).host} · `;
  } catch {
    host = "";
  }
  return `${host}herald · ${settings?.kind ?? ""}`;
}

// Live preview: raw markdown deltas appended verbatim into the mono box —
// never rendered rich mid-stream. Auto-scroll pins to the newest line while
// the user hasn't scrolled up; any manual scroll-up pauses follow until
// scrolled back to the bottom.
function StreamingPreview({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div style={{ padding: "10px 12px" }}>
      <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
        Preview <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>raw markdown</span>
      </span>
      <div
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
        style={monoBox(180)}
      >
        {text}
        <span style={{ animation: "lx-wip-pulse 1.2s ease-in-out infinite", color: "var(--lx-border-focus)" }}>▍</span>
      </div>
    </div>
  );
}

// The selection rides along as Markdown so Herald can preserve and mirror
// the document's formatting (same contract as the Blacksmith popover).
function selectionToMarkdown(editor: Editor): string {
  try {
    const slice = editor.state.doc.slice(editor.state.selection.from, editor.state.selection.to);
    return docToMarkdown({ type: "doc", content: slice.content.toJSON() } as TipTapDoc);
  } catch {
    return "";
  }
}
