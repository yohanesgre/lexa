import { useTaskActivity, useProjectMembers, useUpdateComment, useDeleteComment } from "../../lib/queries";
import { clientLxkUser } from "../../lib/api";
import { ActivityTimeline, type CurrentUser } from "./ActivityTimeline";
import { CommentComposer } from "./CommentComposer";

// The Activity tab: step-rail timeline + composer, per wireframes/src/task-detail.html.
// Identity: the Cloudflare Access user meta (email/name) resolved against the
// project members list to get the acting user's id + role — comment actions
// key off it (author → edit+delete, admin → delete on others, agents none).

function useCurrentUser(slug: string | undefined): CurrentUser {
  const members = useProjectMembers(slug ?? "");
  const lxk = clientLxkUser();
  const member = members.data?.find((m) => m.email === lxk?.email) ?? null;
  return {
    id: member?.id ?? null,
    email: lxk?.email ?? null,
    name: member?.name ?? lxk?.name ?? null,
    role: member?.role ?? null,
  };
}

interface ActivityTabProps {
  slug: string | undefined;
  taskId: string;
  isArchived: boolean;
}

export function ActivityTab({ slug, taskId, isArchived }: ActivityTabProps) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useTaskActivity(slug ?? "", taskId);
  const members = useProjectMembers(slug ?? "");
  const currentUser = useCurrentUser(slug);

  const updateComment = useUpdateComment(slug ?? "", taskId);
  const deleteComment = useDeleteComment(slug ?? "", taskId);

  // Server pages are newest-chunk-first, each page ascending (Task 14: the
  // repo returns ascending slices; page 0 holds the newest chunk). The
  // wireframe renders oldest → newest with the newest at the bottom next to
  // the composer — reverse the PAGE order (items stay ascending). New
  // activity is appended to page 1's end by the mutation hooks, so it lands
  // at the bottom of the display.
  const items = (data?.pages ?? []).slice().reverse().flatMap((p) => p.data);
  const memberList = (members.data ?? []).map((m) => ({ id: m.id, name: m.name }));

  return (
    <div className="activity-panel">
      {!isLoading && hasNextPage && (
        <button type="button" className="load-older" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
          {isFetchingNextPage ? "Loading…" : "Load older"}
        </button>
      )}
      {!isLoading && items.length === 0 ? (
        <div className="empty-box" style={{ padding: 24 }}>
          <div className="text-sm font-medium text-lx-text-primary">No activity yet — be the first to comment</div>
        </div>
      ) : (
        <ActivityTimeline
          items={items}
          members={memberList}
          currentUser={currentUser}
          onDeleteComment={(commentId) => deleteComment.mutate(commentId)}
          onUpdateComment={(commentId, body) => updateComment.mutate({ commentId, body })}
        />
      )}
      {isArchived ? (
        <div
          className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]"
          style={{ marginTop: 12, padding: "8px 12px", border: "1px solid var(--lx-border-default)", borderRadius: 6, background: "var(--lx-surface-elevated)" }}
        >
          Comments are disabled on archived tasks
        </div>
      ) : (
        <CommentComposer slug={slug ?? ""} taskId={taskId} />
      )}
    </div>
  );
}
