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
    expect(m.linkAdded("subtask_of", "Auto-save on zone transition")).toBe("Linked subtask: Auto-save on zone transition");
    expect(m.linkRemoved("blocked_by", "Boss arena trigger zones")).toBe("Removed blocked-by: Boss arena trigger zones");
    expect(m.linkAdded("unknown_rel", "X")).toBe("Linked unknown_rel: X");
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

  it("formatActivityMessage covers every ActivityType", () => {
    const types: ActivityType[] = [
      "created", "moved", "field_changed", "archived", "restored", "deleted",
      "link_added", "link_removed", "source_added", "source_removed",
      "github_linked", "github_unlinked", "github_synced",
      "forge_completed", "forge_failed", "forge_cancelled",
      "commented", "comment_deleted",
    ];
    for (const t of types) {
      const msg = m.formatActivityMessage(t, {});
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
