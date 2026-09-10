import type { ReactNode } from "react";
import type { useHeraldStream } from "../../lib/use-herald-stream";
import { HeraldApprovalBatch } from "./HeraldApprovals";
import type { ApprovalChip } from "./HeraldApprovals";
import { HeraldActivity } from "./HeraldActivity";
import { ChatJumpButton, ChatSkillsPanel, StreamingBubble, UserTurnBubble } from "./HeraldChatTurns";
import { HeraldAssistantBubble } from "./HeraldAssistantBubble";
import { HeraldChatComposer } from "./HeraldChatComposer";
import type { ActivityView, ChatTurn } from "./herald-chat-utils";
import type { LexaSkill } from "../../../shared/types";
import type { HeraldReasoningEffort } from "../../../shared/herald";

type Stream = ReturnType<typeof useHeraldStream>;

// Chat page shell pieces (herald-chat.html): header bar, transcript scroll
// area, composer area with skill panel + warning banners. Pure render —
// state and stream orchestration stay in HeraldChatPage.

export function ChatHeader({ sub }: { sub: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px 0" }}>
      <div className="flex items-center gap-3">
        <h1 className="font-display text-xl font-semibold text-lx-text-primary">Herald Chat</h1>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{sub}</span>
      </div>
    </div>
  );
}

export function ChatTranscriptArea({
  turns,
  slug,
  streaming,
  renderText,
  skillName,
  projectId,
  streamActivity,
  batchBusy,
  onDecide,
  onApproveAll,
  onRetryTurn,
  scrollRef,
  onScroll,
  editingPos,
  editDraft,
  onEditDraftChange,
  onBeginEdit,
  onCancelEdit,
  onCommitEdit,
  lastUserPos,
  onRegenerate,
  stream,
  atBottom,
  onJump,
}: {
  turns: ChatTurn[];
  slug: string;
  streaming: boolean;
  renderText: (text: string) => ReactNode;
  skillName?: string | undefined;
  projectId?: string | undefined;
  streamActivity: ActivityView | undefined;
  batchBusy: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: (chips: ApprovalChip[]) => void;
  onRetryTurn: (turn: ChatTurn) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  editingPos: number | null;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onBeginEdit: (pos: number) => void;
  onCancelEdit: () => void;
  onCommitEdit: (pos: number) => void;
  lastUserPos: number;
  onRegenerate: (turn: ChatTurn) => void;
  stream: Stream;
  atBottom: boolean;
  onJump: () => void;
}) {
  return (
    <div className="chat-transcript">
      <div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
        <div className="chat-column">
          {turns.map((turn, pos) =>
            turn.role === "user" ? (
              <UserTurnBubble
                key={pos}
                turn={turn}
                pos={pos}
                slug={slug}
                editing={editingPos === pos}
                editDraft={editDraft}
                onEditDraftChange={onEditDraftChange}
                onBeginEdit={() => onBeginEdit(pos)}
                onCancelEdit={onCancelEdit}
                onCommitEdit={() => onCommitEdit(pos)}
                lastUser={pos === lastUserPos}
                streaming={streaming}
                onRegenerate={() => onRegenerate(turn)}
              />
            ) : (
              <HeraldAssistantBubble
                key={pos}
                turn={turn}
                skillName={skillName}
                projectId={projectId}
                streaming={streaming}
                renderText={renderText}
                activity={turn.activity ?? (streamActivity && pos === turns.length - 1 ? streamActivity : undefined)}
                batchBusy={batchBusy}
                onDecide={onDecide}
                onApproveAll={onApproveAll}
                onRetry={() => onRetryTurn(turn)}
              />
            )
          )}

          {streaming && <StreamingBubble stream={stream} skillName={skillName} renderText={renderText} />}
        </div>
      </div>
      <ChatJumpButton atBottom={atBottom} onClick={onJump} />
    </div>
  );
}

function WarnBanner({ code, message }: { code: string; message: string }) {
  return (
    <div className="banner-warning mb-2">
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
      <span><span className="font-mono font-medium">{code}</span> — {message}</span>
    </div>
  );
}

export function ChatComposerArea({
  skillsPanelOpen,
  onToggleSkills,
  skillName,
  skills,
  skillId,
  onSkillChange,
  engineGate,
  busy409,
  slug,
  streaming,
  suspendedLock,
  suspendTally,
  attachDisabled,
  isMobileComposer,
  effort,
  projectEffort,
  onEffortChange,
  onSend,
  onAbort,
}: {
  skillsPanelOpen: boolean;
  onToggleSkills: () => void;
  skillName?: string | undefined;
  skills: LexaSkill[];
  skillId: string;
  onSkillChange: (id: string) => void;
  engineGate: boolean;
  busy409: boolean;
  slug: string;
  streaming: boolean;
  suspendedLock: boolean;
  suspendTally: string;
  attachDisabled: boolean;
  isMobileComposer: boolean;
  effort: HeraldReasoningEffort | "";
  projectEffort: HeraldReasoningEffort | null | undefined;
  onEffortChange: (e: HeraldReasoningEffort | "") => void;
  onSend: (message: string, imageCount: number) => void;
  onAbort: () => void;
}) {
  return (
    <div className="chat-composer">
      <div className="chat-composer-inner">
        {/* Skill picker — collapsed by default to a one-line summary
            (skill name + chevron). Tapping expands the chip row. */}
        <ChatSkillsPanel
          open={skillsPanelOpen}
          skillName={skillName}
          skills={skills}
          skillId={skillId}
          effort={effort}
          projectEffort={projectEffort}
          onEffortChange={onEffortChange}
          disabled={streaming}
          isMobileComposer={isMobileComposer}
          onToggle={onToggleSkills}
          onSkillChange={onSkillChange}
        />

        {engineGate && (
          <WarnBanner
            code="ENGINE_NOT_SUPPORTED_FOR_CHAT"
            message="this project's default engine is Blacksmith. Freeform chat needs the Herald engine; ask an admin to switch it in Project Settings → Herald."
          />
        )}
        {busy409 && (
          <WarnBanner
            code="HERALD_TASK_ACTIVE"
            message="Herald is already responding in this thread. Stop the current reply to send something new."
          />
        )}

        <HeraldChatComposer
          slug={slug}
          streaming={streaming}
          busy409={busy409}
          suspendedLock={suspendedLock}
          suspendTally={suspendTally}
          attachDisabled={attachDisabled}
          onSend={onSend}
          onAbort={onAbort}
        />
      </div>
    </div>
  );
}
