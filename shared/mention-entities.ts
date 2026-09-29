import { skillToken } from "./skill-tokens";
import type { Column, Milestone, Swimlane } from "./types";

// milestones / swimlanes / columns carry no `slug` column (docs/SCHEMA.md), so
// their mention token is derived from the name. Reuse the one normalizer
// already in the tree — shared/skill-tokens.ts#skillToken (lowercase;
// non-alphanumerics → "-"; dash-trimmed), the same rule as the private
// slugify() copies in project/wiki/teams services. No second implementation.
export const mentionSlug = (name: string): string => skillToken(name);

export function milestoneMentionSublabel(m: Pick<Milestone, "dueAt" | "archivedAt" | "sprintCount">): string {
  const parts: string[] = [];
  if (m.archivedAt !== null) parts.push("archived");
  parts.push(m.dueAt !== null ? `due ${m.dueAt}` : "no due date");
  if (m.sprintCount > 0) parts.push(m.sprintCount === 1 ? "1 sprint" : `${m.sprintCount} sprints`);
  return parts.join(" · ");
}

export function swimlaneMentionSublabel(
  l: Pick<Swimlane, "kind" | "dueAt" | "archivedAt">,
  milestoneName: string | null
): string {
  const parts: string[] = [l.kind];
  if (milestoneName !== null) parts.push(`milestone ${milestoneName}`);
  if (l.dueAt !== null) parts.push(`due ${l.dueAt}`);
  if (l.archivedAt !== null) parts.push("archived");
  return parts.join(" · ");
}

export function columnMentionSublabel(c: Pick<Column, "position" | "isDone" | "githubState">): string {
  const parts: string[] = [`position ${c.position + 1}`];
  if (c.isDone) parts.push("done");
  else if (c.githubState !== null) parts.push(`github ${c.githubState}`);
  return parts.join(" · ");
}
