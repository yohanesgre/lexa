import type { CSSProperties } from "react";
import type { ActivityEvent, ActivityItem, TaskComment } from "../../../shared/types";
import { cn } from "../ui/cn";
import { GithubMark } from "../icons";
import { RobotGlyph } from "./RobotGlyph";
import { CommentCard, type CurrentUser } from "./CommentCard";
export type { CurrentUser };

// Timeline steps ride one continuous vertical rail (wireframe "step rail").
// Each step draws its own 2px segment via ::before at the rail column center
// (x = 12px); the first/last step's segment is clipped to its marker center
// via --marker-center, so the line starts at the first marker and ends at the
// last — no tail above/below. Prepending older entries re-derives bounds
// because every step carries its own --marker-center (16px event dot / 24px
// comment avatar).

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function EventRow({ item, ownerName }: { item: ActivityEvent; ownerName: string | null }) {
  const isAgent = item.actorKind === "agent";
  const isWebhook = item.type === "github_synced";
  return (
    <div className="activity-row" style={{ "--marker-center": "16px" } as CSSProperties}>
      <span className={cn("activity-dot", isAgent && "activity-dot-agent")}>
        {isAgent ? <RobotGlyph size={14} /> : isWebhook ? <GithubMark size={14} /> : <span className="activity-dot-core" />}
      </span>
      <div className="activity-body">
        {isAgent && (
          <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
            <span className="agent-tag">
              <RobotGlyph size={10} /> agent
            </span>
            <span className="agent-label">{item.actorLabel}</span>
            {ownerName && <span className="agent-keyhint">({ownerName}'s key)</span>}
          </div>
        )}
        <div style={isAgent ? { marginTop: 2 } : undefined}>
          {isWebhook && <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">github </span>}
          <span className="activity-msg">{item.message}</span>
          <span className="activity-time"> · {formatTime(item.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

interface ActivityTimelineProps {
  items: ActivityItem[];
  members: { id: string; name: string }[];
  currentUser: CurrentUser;
  onDeleteComment: (commentId: number) => void;
  onUpdateComment: (commentId: number, body: TaskComment["body"]) => void;
}

export function ActivityTimeline({ items, members, currentUser, onDeleteComment, onUpdateComment }: ActivityTimelineProps) {
  const memberNames = members.map((m) => m.name);
  const ownerNameById = (id: string | null): string | null => {
    if (!id) return null;
    return members.find((m) => m.id === id)?.name ?? "key owner";
  };
  return (
    <div className="activity-timeline">
      {items.map((item) =>
        item.kind === "event" ? (
          <EventRow key={`e${item.id}`} item={item} ownerName={ownerNameById(item.actorUserId)} />
        ) : (
          <CommentCard
            key={`c${item.id}`}
            comment={item}
            members={memberNames}
            currentUser={currentUser}
            onDelete={onDeleteComment}
            onUpdate={onUpdateComment}
          />
        )
      )}
    </div>
  );
}
