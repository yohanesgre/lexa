import type { HeraldWriteDiff } from "../../../shared/herald";

// Pure helpers for Herald approval diff rendering.

export const DIFF_CAP = 2000;

export function chars(n: number): string {
  return `${n.toLocaleString("en-US")} / ${DIFF_CAP.toLocaleString("en-US")} chars`;
}

export function cap(text: string): string {
  return text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}…` : text;
}

export function targetFor(diff: HeraldWriteDiff): string {
  switch (diff.type) {
    case "task_create":
      return "new";
    case "task_update":
    case "task_move":
    case "task_archive":
    case "task_restore":
    case "task_delete":
    case "comment":
      return diff.taskRef;
    case "wiki_create":
    case "wiki_edit":
    case "wiki_delete":
      return diff.slug;
    case "milestone_create":
    case "milestone_update":
    case "milestone_archive":
    case "milestone_delete":
    case "sprint_create":
    case "sprint_update":
    case "sprint_archive":
    case "sprint_delete":
      return diff.name;
    case "swimlane_move":
      return diff.swimlaneName;
  }
}
