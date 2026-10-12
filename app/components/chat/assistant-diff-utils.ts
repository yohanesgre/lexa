import type { AssistantWriteDiff } from "../../../shared/assistant";

// Pure helpers for Assistant approval diff rendering.

// The approval card renders the whole change — text blocks scroll rather than
// truncate — so this is a plain count of what is shown, never a "used / limit"
// meter (the old `N / 2,000 chars` read like a limit being hit).
export function chars(n: number): string {
  return `${n.toLocaleString("en-US")} characters`;
}

// A one-line stand-in for a long body (a description, a page draft) so an
// approval chip names what it will write without inlining the whole text. The
// full body is what the write itself shows once applied.
export function bodySummary(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const head = lines[0] ?? "";
  const shown = head.length > 110 ? `${head.slice(0, 110)}…` : head;
  if (lines.length <= 1) return shown;
  return `${shown} · +${lines.length - 1} more ${lines.length - 1 === 1 ? "line" : "lines"}`;
}

export function targetFor(diff: AssistantWriteDiff): string {
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
