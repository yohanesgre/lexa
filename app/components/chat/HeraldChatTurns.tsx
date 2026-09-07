import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { renderTokenized } from "../../lib/tokenizeTranscript";
import { HeraldFlameIcon } from "../hearth/herald/HeraldFlameIcon";
import { SkillPicker } from "../hearth/herald/SkillPicker";
import { CheckIcon, CopyButton, EditIcon, RegenerateIcon, XIcon } from "./herald-chat-icons";
import { HeraldActivity } from "./HeraldActivity";
import { HeraldApprovalBatch } from "./HeraldApprovals";
import { hhmm } from "./herald-chat-utils";
import type { ChatTurn } from "./herald-chat-utils";
import type { useHeraldStream } from "../../lib/use-herald-stream";
import type { LexaSkill } from "../../../shared/types";

type Stream = ReturnType<typeof useHeraldStream>;

// Render-only pieces of the Herald chat page (herald-chat.html). State and
// stream orchestration stay in HeraldChatPage; these take props only.

export function ChatProviderMissingPanel({ projectId }: { projectId: string | undefined }) {
  return (
    <div className="chat-scroll">
      <div className="card-panel" style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="empty-state" style={{ padding: "32px 20px" }}>
          <div className="empty-state-icon">
            <HeraldFlameIcon size={24} />
          </div>
          <div className="text-sm font-medium text-lx-text-primary">No AI provider configured</div>
          <p className="text-xs text-lx-text-secondary mt-1" style={{ maxWidth: 260 }}>
            Set up a provider for this project in Project Settings → Herald provider.
          </p>
          {projectId && (
            <div className="mt-3">
              <Link to="/settings/project/$projectId" params={{ projectId }} className="btn btn-primary btn-sm" style={{ textDecoration: "none" }}>
                Open Settings
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UserTurnEditor({
  draft,
  onDraftChange,
  onCommit,
  onCancel,
  style,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  style: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Mount focus without the autoFocus attribute (a11y: no programmatic
  // focus steal after page load).
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
      <textarea
        ref={ref}
        rows={2}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder="Enter save, Shift+Enter newline"
        title="Enter save, Shift+Enter newline"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Enter" && e.shiftKey) {
            // allow newline
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        aria-label="Edit message"
        style={style}
      />
      <div className="flex items-center justify-end gap-2 mt-2">
        <button type="button" className="btn btn-primary btn-icon-sm" title="Save edit (Enter)" aria-label="Save edit" onClick={onCommit}>
          <CheckIcon />
        </button>
        <button type="button" className="icon-btn" title="Cancel edit (Esc)" aria-label="Cancel edit" onClick={onCancel}>
          <XIcon />
        </button>
      </div>
    </>
  );
}

export function UserTurnBubble({
  turn,
  pos,
  slug,
  editing,
  editDraft,
  onEditDraftChange,
  onBeginEdit,
  onCancelEdit,
  onCommitEdit,
  lastUser,
  streaming,
  onRegenerate,
}: {
  turn: ChatTurn;
  pos: number;
  slug: string;
  editing: boolean;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onCommitEdit: () => void;
  lastUser: boolean;
  streaming: boolean;
  onRegenerate: () => void;
}) {
  const time = hhmm(turn.ts);
  return (
    <div className="bubble-user">
      <div className="bubble-meta" style={{ textAlign: "right" }}>You{time ? ` · ${time}` : ""}</div>
      {editing ? (
        <UserTurnEditor draft={editDraft} onDraftChange={onEditDraftChange} onCommit={onCommitEdit} onCancel={onCancelEdit} style={{ width: "100%", resize: "vertical", background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-focus)", borderRadius: 6, padding: "8px 10px", fontSize: 13, lineHeight: "18px", fontFamily: "var(--lx-font-body)", color: "var(--lx-text-primary)" }} />
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
            <button type="button" className="icon-btn" title="Edit message" aria-label={`Edit message ${pos + 1}`} onClick={onBeginEdit}>
              <EditIcon />
            </button>
            {lastUser && (
              <button type="button" className="icon-btn" title="Regenerate from here" aria-label="Regenerate from here" disabled={streaming} onClick={onRegenerate}>
                <RegenerateIcon />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function StreamingBubble({
  stream,
  skillName,
  renderText,
}: {
  stream: Stream;
  skillName?: string | undefined;
  renderText: (text: string) => ReactNode;
}) {
  return (
    <div className="bubble-ai">
      <div className="bubble-meta">Herald Agent{skillName ? ` · ${skillName}` : ""}</div>
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
  );
}

export function ChatJumpButton({ atBottom, onClick }: { atBottom: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon-sm chat-jump-bottom"
      title="Jump to latest"
      aria-label="Jump to latest"
      aria-hidden={atBottom ? "true" : "false"}
      style={atBottom ? { opacity: 0, pointerEvents: "none" } : undefined}
      onClick={onClick}
    >
      <ArrowDown size={14} strokeWidth={1.5} />
    </button>
  );
}

export function ChatSkillsPanel({
  open,
  skillName,
  skills,
  skillId,
  onToggle,
  onSkillChange,
}: {
  open: boolean;
  skillName?: string | undefined;
  skills: LexaSkill[];
  skillId: string;
  onToggle: () => void;
  onSkillChange: (id: string) => void;
}) {
  return (
    <div className="skills-panel">
      <button type="button" className="skills-panel-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="prop-label">Skill</span>
        <span className="skills-panel-current">
          {skillName ?? "None"}
        </span>
        {open ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}
      </button>
      {open && (
        <div className="skills-panel-body">
          <SkillPicker skills={skills} skillId={skillId} onSkillChange={onSkillChange} layout="inline" allowNoSkill />
        </div>
      )}
    </div>
  );
}
