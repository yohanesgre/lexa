import type { ActivityType } from "../shared/types";

// Message strings are frozen at write time (append-only audit trail).
// Column/lane names are captured as passed — never re-rendered later.
export function created(actor: string) { return `${actor} created this task`; }
export function moved(actor: string, fromCol: string | null, toCol: string, fromLane: string | null, toLane: string | null) {
  if (fromCol !== null && fromCol !== toCol) {
    return toLane !== null && toLane !== fromLane
      ? `${actor} moved from ${fromCol} to ${toCol} in ${toLane}`
      : `${actor} moved from ${fromCol} to ${toCol}`;
  }
  return toLane !== null && toLane !== fromLane ? `${actor} moved to ${toLane} in ${toCol}` : `${actor} moved`;
}
export function titleChanged(actor: string) { return `${actor} changed the title`; }
export function descriptionUpdated(actor: string) { return `${actor} updated the description`; }
export function priorityChanged(from: string, to: string) { return `Priority changed: ${from} → ${to}`; }
export function typeChanged(from: string, to: string) { return `Type changed: ${from} → ${to}`; }
export function assigneesUpdated(actor: string) { return `${actor} updated assignees`; }
export function archived(actor: string) { return `${actor} archived this task`; }
export function restored(actor: string) { return `${actor} restored this task`; }
export function deletedTask(actor: string) { return `${actor} deleted this task`; }
const RELATION_LABEL: Record<string, string> = { subtask_of: "subtask", blocked_by: "blocked-by", related_to: "related" };
export function linkAdded(relation: string, title: string) { return `Linked ${RELATION_LABEL[relation] ?? relation}: ${title}`; }
export function linkRemoved(relation: string, title: string) { return `Removed ${RELATION_LABEL[relation] ?? relation}: ${title}`; }
export function sourceAdded(label: string, kind: "wiki" | "url") { return `Added source: ${label}${kind === "wiki" ? " (wiki)" : ""}`; }
export function sourceRemoved(label: string) { return `Removed source: ${label}`; }
export function githubLinked(repo: string, number: number) { return `Linked GitHub issue ${repo} #${number}`; }
export function githubUnlinked(repo: string, number: number) { return `Unlinked GitHub issue ${repo} #${number}`; }
export function githubSynced(number: number, state: "open" | "closed", toCol: string) {
  return `Issue #${number} ${state} on GitHub — task moved to ${toCol}`;
}
export function forgeCompleted(agent: string) { return `Forge: ${agent} completed — result ready`; }
export function forgeFailed() { return "Forge run failed"; }
export function forgeCancelled() { return "Forge run cancelled"; }
export function commented(actor: string) { return `${actor} commented`; }
export function commentDeleted(actor: string) { return `${actor} deleted a comment`; }

// Dispatcher for emission points (Task 6+): one call per ActivityType.
// payload is shaped per type (fields match the per-type functions above);
// cast at the boundary — no runtime validation.
export type ActivityMessagePayload = Record<string, unknown>;

export function formatActivityMessage(type: ActivityType, payload: ActivityMessagePayload): string {
  switch (type) {
    case "created": return created((payload as { actor: string }).actor);
    case "moved": {
      const p = payload as { actor: string; fromCol: string | null; toCol: string; fromLane: string | null; toLane: string | null };
      return moved(p.actor, p.fromCol, p.toCol, p.fromLane, p.toLane);
    }
    case "field_changed": {
      const p = payload as { variant: "title" | "description" | "assignees" | "priority" | "type"; actor?: string; from?: string; to?: string };
      switch (p.variant) {
        case "title": return titleChanged(p.actor ?? "");
        case "description": return descriptionUpdated(p.actor ?? "");
        case "assignees": return assigneesUpdated(p.actor ?? "");
        case "priority": return priorityChanged(p.from ?? "", p.to ?? "");
        case "type": return typeChanged(p.from ?? "", p.to ?? "");
      }
    }
    case "archived": return archived((payload as { actor: string }).actor);
    case "restored": return restored((payload as { actor: string }).actor);
    case "deleted": return deletedTask((payload as { actor: string }).actor);
    case "link_added": {
      const p = payload as { relation: string; title: string };
      return linkAdded(p.relation, p.title);
    }
    case "link_removed": {
      const p = payload as { relation: string; title: string };
      return linkRemoved(p.relation, p.title);
    }
    case "source_added": {
      const p = payload as { label: string; kind: "wiki" | "url" };
      return sourceAdded(p.label, p.kind);
    }
    case "source_removed": return sourceRemoved((payload as { label: string }).label);
    case "github_linked": {
      const p = payload as { repo: string; number: number };
      return githubLinked(p.repo, p.number);
    }
    case "github_unlinked": {
      const p = payload as { repo: string; number: number };
      return githubUnlinked(p.repo, p.number);
    }
    case "github_synced": {
      const p = payload as { number: number; state: "open" | "closed"; toCol: string };
      return githubSynced(p.number, p.state, p.toCol);
    }
    case "forge_completed": return forgeCompleted((payload as { agent: string }).agent);
    case "forge_failed": return forgeFailed();
    case "forge_cancelled": return forgeCancelled();
    case "commented": return commented((payload as { actor: string }).actor);
    case "comment_deleted": return commentDeleted((payload as { actor: string }).actor);
  }
}
