import { describe, expect, it } from "vitest";
import * as m from "./activity-messages";
import type { ActivityType } from "../shared/types";

describe("activity messages", () => {
  it("formats per type", () => {
    expect(m.created("Maria")).toBe("Maria created this task");
    expect(m.moved("Maria", "Backlog", "In Progress", null, null)).toBe("Maria moved from Backlog to In Progress");
    expect(m.moved("Maria", "Backlog", "Done", null, "Sprint 6")).toBe("Maria moved from Backlog to Done in Sprint 6");
    expect(m.moved("Maria", "Backlog", "Backlog", null, "Sprint 6")).toBe("Maria moved to Sprint 6 in Backlog");
    expect(m.moved("Maria", "Backlog", "Backlog", "Sprint 6", "Sprint 6")).toBe("Maria moved");
    expect(m.priorityChanged("Medium", "High")).toBe("Priority changed: Medium → High");
    expect(m.linkAdded("subtask_of", "EMB-15", "Auto-save on zone transition")).toBe("Linked subtask: EMB-15 · Auto-save on zone transition");
    expect(m.linkRemoved("blocked_by", "EMB-22", "Boss arena trigger zones")).toBe("Removed blocked-by: EMB-22 · Boss arena trigger zones");
    expect(m.linkAdded("unknown_rel", "X", "Y")).toBe("Linked unknown_rel: X · Y");
    expect(m.githubSynced(107, "closed", "Done")).toBe("Issue #107 closed on GitHub — task moved to Done");
    expect(m.forgeCompleted("opencode")).toBe("Forge: opencode completed — result ready");
    expect(m.commentDeleted("Maria")).toBe("Maria deleted a comment");
  });

  it("formatActivityMessage dispatches per type", () => {
    expect(m.formatActivityMessage("created", { actor: "Maria" })).toBe("Maria created this task");
    expect(m.formatActivityMessage("moved", { actor: "Maria", fromCol: "Backlog", toCol: "Done", fromLane: null, toLane: "Sprint 6" })).toBe("Maria moved from Backlog to Done in Sprint 6");
    expect(m.formatActivityMessage("field_changed", { variant: "priority", from: "Medium", to: "High" })).toBe("Priority changed: Medium → High");
    expect(m.formatActivityMessage("field_changed", { variant: "title", actor: "Maria" })).toBe("Maria changed the title");
    expect(m.formatActivityMessage("field_changed", { variant: "description", actor: "Maria" })).toBe("Maria updated the description");
    expect(m.formatActivityMessage("field_changed", { variant: "type", from: "Bug", to: "Feature" })).toBe("Type changed: Bug → Feature");
    expect(m.formatActivityMessage("field_changed", { variant: "assignees", actor: "Maria" })).toBe("Maria updated assignees");
    expect(m.formatActivityMessage("github_synced", { number: 107, state: "closed", toCol: "Done" })).toBe("Issue #107 closed on GitHub — task moved to Done");
    expect(m.formatActivityMessage("forge_completed", { agent: "opencode" })).toBe("Forge: opencode completed — result ready");
    expect(m.formatActivityMessage("forge_failed", {})).toBe("Forge run failed");
  });

  it("formatActivityMessage covers every ActivityType with valid payloads", () => {
    const cases: [ActivityType, m.ActivityMessagePayload, string][] = [
      ["created", { actor: "Maria" }, "Maria created this task"],
      ["moved", { actor: "Maria", fromCol: "Backlog", toCol: "Done", fromLane: null, toLane: null }, "Maria moved from Backlog to Done"],
      ["field_changed", { variant: "title", actor: "Maria" }, "Maria changed the title"],
      ["field_changed", { variant: "description", actor: "Maria" }, "Maria updated the description"],
      ["field_changed", { variant: "assignees", actor: "Maria" }, "Maria updated assignees"],
      ["field_changed", { variant: "priority", from: "Medium", to: "High" }, "Priority changed: Medium → High"],
      ["field_changed", { variant: "type", from: "Bug", to: "Feature" }, "Type changed: Bug → Feature"],
      ["archived", { actor: "Maria" }, "Maria archived this task"],
      ["restored", { actor: "Maria" }, "Maria restored this task"],
      ["deleted", { actor: "Maria" }, "Maria deleted this task"],
      ["link_added", { relation: "subtask_of", key: "EMB-1", title: "X" }, "Linked subtask: EMB-1 · X"],
      ["link_removed", { relation: "blocked_by", key: "EMB-2", title: "X" }, "Removed blocked-by: EMB-2 · X"],
      ["source_added", { label: "Home", kind: "wiki" }, "Added source: Home (wiki)"],
      ["source_removed", { label: "Home" }, "Removed source: Home"],
      ["github_linked", { repo: "owner/repo", number: 1 }, "Linked GitHub issue owner/repo #1"],
      ["github_unlinked", { repo: "owner/repo", number: 1 }, "Unlinked GitHub issue owner/repo #1"],
      ["github_synced", { number: 107, state: "closed", toCol: "Done" }, "Issue #107 closed on GitHub — task moved to Done"],
      ["forge_completed", { agent: "opencode" }, "Forge: opencode completed — result ready"],
      ["forge_failed", {}, "Forge run failed"],
      ["forge_cancelled", {}, "Forge run cancelled"],
      ["commented", { actor: "Maria" }, "Maria commented"],
      ["comment_deleted", { actor: "Maria" }, "Maria deleted a comment"],
      ["attachment_added", { actor: "Maria", filename: "spec.pdf" }, "Maria attached spec.pdf"],
      ["attachment_removed", { actor: "Maria", filename: "spec.pdf" }, "Maria removed attachment spec.pdf"],
    ];
    for (const [t, payload, expected] of cases) {
      expect(m.formatActivityMessage(t, payload), `type=${t}`).toBe(expected);
    }
  });

  it("field_changed with a missing or unknown variant falls back instead of emitting garbage", () => {
    expect(m.formatActivityMessage("field_changed", {})).toBe("Task updated");
    expect(m.formatActivityMessage("field_changed", { variant: "typo", actor: "Maria" })).toBe("Task updated");
  });
});
