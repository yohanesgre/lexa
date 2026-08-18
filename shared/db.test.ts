import { describe, it, expect } from "vitest";
import { rowToProject, rowToColumn, rowToSwimlane, rowToWikiPage, rowToWikiPageMeta, rowToWikiPageRevision, rowToWikiPageRevisionSummary, rowToTask, rowToActivityEvent, rowToComment } from "./db";
import type { ProjectRow, ColumnRow, SwimlaneRow, WikiPageRow, WikiPageRevisionRow, TaskRow, ActivityRow, CommentRow } from "./db";

const NOW = "2026-07-29T12:00:00Z";

describe("rowToProject", () => {
  it("maps snake_case to camelCase", () => {
    const row: ProjectRow = { id: "p1", name: "Test", slug: "test", key: "EG", description: "desc", created_at: NOW, updated_at: NOW, team_id: null };
    const p = rowToProject(row);
    expect(p).toEqual({ id: "p1", name: "Test", slug: "test", key: "EG", description: "desc", createdAt: NOW, updatedAt: NOW, teamId: null });
  });

  it("maps team_id", () => {
    const p = rowToProject({ id: "p1", name: "Test", slug: "test", key: "EG", description: "desc", created_at: NOW, updated_at: NOW, team_id: "team-1" });
    expect(p.teamId).toBe("team-1");
  });
});

describe("rowToColumn", () => {
  it("maps snake_case + parses required_fields JSON", () => {
    const row: ColumnRow = { id: "c1", project_id: "p1", name: "Todo", position: 0, color: "#fff", wip_limit: 5, required_fields: '["title"]', github_state: null };
    const c = rowToColumn(row);
    expect(c).toEqual({ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#fff", wipLimit: 5, requiredFields: ["title"], githubState: null, isDone: false });
    const done = rowToColumn({ ...row, is_done: 1 });
    expect(done.isDone).toBe(true);
  });

  it("handles null wip_limit", () => {
    const row: ColumnRow = { id: "c1", project_id: "p1", name: "X", position: 0, color: "#000", wip_limit: null, required_fields: "[]", github_state: "open" };
    expect(rowToColumn(row).wipLimit).toBeNull();
    expect(rowToColumn(row).githubState).toBe("open");
  });
});

describe("rowToSwimlane", () => {
  it("maps fields", () => {
    const row: SwimlaneRow = { id: "s1", project_id: "p1", name: "Backend", description: "server work", position: 1, due_at: null, archived_at: null, start_at: null, milestone_id: null };
    expect(rowToSwimlane(row)).toEqual({ id: "s1", projectId: "p1", name: "Backend", description: "server work", position: 1, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: null });
  });

  it("defaults kind to sprint and maps due fields", () => {
    const row: SwimlaneRow = { id: "s1", project_id: "p1", name: "Backlog", description: "", position: 0, due_at: "2026-08-14", archived_at: "2026-08-01T00:00:00Z", kind: "backlog", start_at: null, milestone_id: null };
    expect(rowToSwimlane(row)).toEqual({ id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: "2026-08-14", archivedAt: "2026-08-01T00:00:00Z", startAt: null, kind: "backlog", milestoneId: null });
  });

  it("maps start_at and milestone_id", () => {
    const row: SwimlaneRow = { id: "s1", project_id: "p1", name: "Sprint 7", description: "", position: 0, due_at: "2026-08-30", archived_at: null, start_at: "2026-08-10", kind: "sprint", milestone_id: "ms1" };
    expect(rowToSwimlane(row)).toMatchObject({ startAt: "2026-08-10", kind: "sprint", milestoneId: "ms1" });
  });
});

describe("rowToWikiPage / rowToWikiPageMeta", () => {
  const row: WikiPageRow = { id: "w1", project_id: "p1", title: "Home", slug: "home", content: '{"type":"doc","content":[]}', content_text: "hello", parent_id: null, position: 0, created_at: NOW, updated_at: NOW };

  it("rowToWikiPageMeta returns meta fields only", () => {
    expect(rowToWikiPageMeta(row)).toEqual({ id: "w1", projectId: "p1", title: "Home", slug: "home", parentId: null, position: 0, updatedAt: NOW });
  });

  it("rowToWikiPage includes content + createdAt", () => {
    const p = rowToWikiPage(row);
    expect(p.content).toEqual({ type: "doc", content: [] });
    expect(p.createdAt).toBe(NOW);
    expect(p.title).toBe("Home");
  });
});

describe("rowToWikiPageRevision / rowToWikiPageRevisionSummary", () => {
  const row: WikiPageRevisionRow = { id: "r1", page_id: "w1", title: "Home v2", slug: "home", content: '{"type":"doc","content":[]}', content_text: "hi", save_type: "manual", created_at: NOW };

  it("full revision", () => {
    const r = rowToWikiPageRevision(row);
    expect(r).toMatchObject({ id: "r1", pageId: "w1", saveType: "manual", contentText: "hi" });
  });

  it("summary", () => {
    const s = rowToWikiPageRevisionSummary(row);
    expect(s).toEqual({ id: "r1", title: "Home v2", saveType: "manual", createdAt: NOW });
  });
});

describe("rowToTask", () => {
  const row: TaskRow = { id: "t1", key: "EG-1", project_id: "p1", column_id: "c1", swimlane_id: "s1", title: "Fix bug", description: '{"type":"doc","content":[]}', priority: "prio-opt-1", type: "type-opt-1", assignees: "alice", position: "a0", due_at: null, archived_at: null, github_issue_id: null, github_issue_number: null, github_repo: null, github_synced_state: null, created_at: NOW, updated_at: NOW, github_issues_raw: null };

  it("maps all fields", () => {
    const t = rowToTask(row);
    expect(t.id).toBe("t1");
    expect(t.projectId).toBe("p1");
    expect(t.swimlaneId).toBe("s1");
    expect(t.priority).toBe("prio-opt-1");
    expect(t.type).toBe("type-opt-1");
    expect(t.assignees).toEqual(["alice"]);
    expect(t.githubs).toEqual([]);
  });

  it("maps due_at", () => {
    const t = rowToTask({ ...row, due_at: "2026-08-14" });
    expect(t.dueAt).toBe("2026-08-14");
    expect(rowToTask(row).dueAt).toBeNull();
  });

  it("builds githubs array from raw concat string", () => {
    const linked: TaskRow = { ...row, github_issues_raw: "ghi1,42,owner/repo,open,0" };
    const t = rowToTask(linked);
    expect(t.githubs).toEqual([{
      issueId: "ghi1", issueNumber: 42, repo: "owner/repo",
      url: "https://github.com/owner/repo/issues/42",
      syncedState: "open", outOfSync: false, pushFailed: false,
    }]);
  });

  it("builds multiple githubs", () => {
    const linked: TaskRow = { ...row, github_issues_raw: "ghi1,1,r1,open,0||ghi2,2,r2,closed,0" };
    const t = rowToTask(linked);
    expect(t.githubs).toHaveLength(2);
    expect(t.githubs[1]).toMatchObject({ issueId: "ghi2", issueNumber: 2, repo: "r2", syncedState: "closed" });
  });

  it("detects outOfSync when column githubState differs", () => {
    const linked: TaskRow = { ...row, github_issues_raw: "ghi1,1,r,open,0" };
    const t = rowToTask(linked, "closed");
    expect(t.githubs[0].outOfSync).toBe(true);
  });

  it("uses column_github_state from row when arg not provided", () => {
    const linked: TaskRow = { ...row, github_issues_raw: "ghi1,1,r,closed,0", column_github_state: "open" };
    const t = rowToTask(linked);
    expect(t.githubs[0].outOfSync).toBe(true);
  });

  it("maps archivedAt", () => {
    const t = rowToTask({ ...row, archived_at: "2026-08-01 10:00:00" });
    expect(t.archivedAt).toBe("2026-08-01 10:00:00");
    expect(rowToTask(row).archivedAt).toBeNull();
  });
});

describe("rowToActivityEvent", () => {
  it("maps snake_case to camelCase", () => {
    const row: ActivityRow = {
      id: 7, task_id: "t1", actor_kind: "user", actor_label: "Alice",
      actor_user_id: "u1", type: "moved", message: "Moved to Done", created_at: NOW,
    };
    expect(rowToActivityEvent(row)).toEqual({
      id: 7, taskId: "t1", actorKind: "user", actorLabel: "Alice",
      actorUserId: "u1", type: "moved", message: "Moved to Done", createdAt: NOW,
    });
  });

  it("preserves all actor kinds and types", () => {
    const base = { id: 1, task_id: "t1", actor_label: "sys", actor_user_id: null as string | null, message: "m", created_at: NOW };
    expect(rowToActivityEvent({ ...base, actor_kind: "agent", type: "forge_completed" }).actorKind).toBe("agent");
    expect(rowToActivityEvent({ ...base, actor_kind: "system", type: "github_synced" }).type).toBe("github_synced");
  });

  it("handles null actor_user_id", () => {
    const row: ActivityRow = {
      id: 2, task_id: "t1", actor_kind: "system", actor_label: "system",
      actor_user_id: null, type: "created", message: "Task created", created_at: NOW,
    };
    expect(rowToActivityEvent(row).actorUserId).toBeNull();
  });
});

describe("rowToComment", () => {
  const row: CommentRow = {
    id: 3, task_id: "t1", author_id: "u1", author_kind: "user", author_label: "Alice",
    body: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi"}]}]}',
    edited_at: null, deleted_at: null, created_at: NOW,
  };

  it("maps fields and parses body as TipTapDoc", () => {
    const c = rowToComment(row);
    expect(c).toEqual({
      id: 3, taskId: "t1", authorId: "u1", authorKind: "user", authorLabel: "Alice",
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
      editedAt: null, deletedAt: null, createdAt: NOW,
    });
  });

  it("handles null author_id / edited_at / deleted_at", () => {
    const agent: CommentRow = { ...row, author_id: null, author_kind: "agent", author_label: "Hermes", edited_at: NOW, deleted_at: NOW };
    const c = rowToComment(agent);
    expect(c.authorId).toBeNull();
    expect(c.authorKind).toBe("agent");
    expect(c.editedAt).toBe(NOW);
    expect(c.deletedAt).toBe(NOW);
  });

  it("parses empty doc body", () => {
    expect(rowToComment({ ...row, body: '{"type":"doc","content":[]}' }).body).toEqual({ type: "doc", content: [] });
  });
});
