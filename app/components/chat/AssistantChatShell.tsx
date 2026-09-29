import type { ReactNode } from "react";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import type { ApprovalChip } from "./AssistantApprovals";
import { ChatJumpButton, StreamingBubble, UserTurnBubble } from "./AssistantChatTurns";
import { AssistantBubble } from "./AssistantBubble";
import { AssistantChatComposer } from "./AssistantChatComposer";
import { EffortPicker } from "./EffortPicker";
import { DeckRailSummary, SkillSelect } from "./SkillSelect";
import type { ActivityView, ChatTurn } from "./assistant-chat-utils";
import type { QueuedMessage } from "./useChatQueue";
import type { LexaSkill } from "../../../shared/types";
import type { AssistantReasoningEffort } from "../../../shared/assistant";

type Stream = ReturnType<typeof useAssistantStream>;

// Chat page shell pieces (assistant-chat.html): header bar, transcript scroll
// area, composer area with skill panel + warning banners. Pure render —
// state and stream orchestration stay in AssistantChatPage.

export function ChatHeader({ sub }: { sub: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px 0" }}>
      <div className="flex items-center gap-3">
        <h1 className="font-display text-xl font-semibold text-lx-text-primary">Assistant Chat</h1>
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
  onRejectAll,
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
  onRejectAll: (chips: ApprovalChip[]) => void;
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
  const lastAssistantPos = turns.findLastIndex((turn) => turn.role === "assistant");
  return (
    <div className="chat-transcript">
      <div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
        <div className="chat-column" role="log" aria-live="polite">
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
              <AssistantBubble
                key={pos}
                turn={turn}
                skillName={skillName}
                projectId={projectId}
                streaming={streaming}
                renderText={renderText}
                activity={turn.activity ?? (streamActivity && pos === turns.length - 1 ? streamActivity : undefined)}
                usage={stream.status === "done" && pos === lastAssistantPos ? stream.usage : undefined}
                batchBusy={batchBusy}
                onDecide={onDecide}
                onApproveAll={onApproveAll}
                onRejectAll={onRejectAll}
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

export function ChatComposerArea({
  skills,
  skillId,
  onSkillChange,
  busy409,
  slug,
  streaming,
  suspendedLock,
  suspendCount,
  attachDisabled,
  isMobileComposer,
  effort,
  projectEffort,
  onEffortChange,
  onSend,
  onAbort,
  landing,
  queued,
  onQueue,
  onUnqueue,
  seed,
}: {
  skills: LexaSkill[];
  skillId: string;
  onSkillChange: (id: string) => void;
  busy409: boolean;
  slug: string;
  streaming: boolean;
  suspendedLock: boolean;
  suspendCount: number;
  attachDisabled: boolean;
  isMobileComposer: boolean;
  effort: AssistantReasoningEffort | "";
  projectEffort: AssistantReasoningEffort | null | undefined;
  onEffortChange: (e: AssistantReasoningEffort | "") => void;
  onSend: (message: string, imageCount: number) => boolean;
  onAbort: () => void;
  landing?: boolean | undefined;
  queued?: QueuedMessage | null | undefined;
  onQueue?: ((text: string) => void) | undefined;
  onUnqueue?: (() => void) | undefined;
  seed?: { text: string; nonce: number } | null | undefined;
}) {
  const railDisabled = streaming || busy409 || suspendedLock;
  // The docked Deck sits at the bottom of a 100vh layout, so its rail menus
  // must open UPWARD; the landing centers the Deck and keeps them below.
  const menuAlign: "up" | "down" = landing ? "down" : "up";
  return (
    <div className={landing ? "chat-composer is-landing" : "chat-composer"}>
      <div className="chat-composer-inner">
        <AssistantChatComposer
          slug={slug}
          streaming={streaming}
          busy409={busy409}
          suspendedLock={suspendedLock}
          suspendCount={suspendCount}
          attachDisabled={attachDisabled}
          onSend={onSend}
          onAbort={onAbort}
          queued={queued}
          onQueue={onQueue}
          onUnqueue={onUnqueue}
          seed={seed}
          rail={
            isMobileComposer ? (
              <>
                <DeckRailSummary
                  skills={skills}
                  skillId={skillId}
                  effort={effort}
                  projectEffort={projectEffort ?? null}
                  onSkillChange={onSkillChange}
                  onEffortChange={onEffortChange}
                  disabled={railDisabled}
                />
                <span className="deck-rail-spacer" />
              </>
            ) : (
              <>
                <span className="deck-label">Skill</span>
                <SkillSelect skills={skills} skillId={skillId} onSkillChange={onSkillChange} align={menuAlign} disabled={railDisabled} />
                <span className="deck-rail-spacer" />
                <span className="deck-label">Effort</span>
                <EffortPicker effort={effort} projectEffort={projectEffort ?? null} disabled={railDisabled} align={menuAlign} onChange={onEffortChange} />
              </>
            )
          }
        />
      </div>
    </div>
  );
}
