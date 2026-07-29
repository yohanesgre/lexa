import { describe, it, expect } from "vitest";
import { rowToProject, rowToColumn, rowToSwimlane, rowToWikiPage, rowToWikiPageMeta, rowToWikiPageRevision, rowToWikiPageRevisionSummary, rowToTask } from "./db";
import type { ProjectRow, ColumnRow, SwimlaneRow, WikiPageRow, WikiPageRevisionRow, TaskRow } from "./db";

const NOW = "2026-07-29T12:00:00Z";

describe("rowToProject", () => {
  it("maps snake_case to camelCase", () => {
    const row: ProjectRow = { id: "p1", name: "Test", slug: "test", description: "desc", github_repo: "owner/repo", created_at: NOW, updated_at: NOW };
    const p = rowToProject(row);
    expect(p).toEqual({ id: "p1", name: "Test", slug: "test", description: "desc", githubRepo: "owner/repo", createdAt: NOW, updatedAt: NOW });
  });

  it("handles null github_repo", () => {
    const row: ProjectRow = { id: "p1", name: "T", slug: "t", description: "", github_repo: null, created_at: NOW, updated_at: NOW };
    expect(rowToProject(row).githubRepo).toBeNull();
  });
});

describe("rowToColumn", () => {
  it("maps snake_case + parses required_fields JSON", () => {
    const row: ColumnRow = { id: "c1", project_id: "p1", name: "Todo", position: 0, color: "#fff", wip_limit: 5, required_fields: '["title"]', github_state: null };
    const c = rowToColumn(row);
    expect(c).toEqual({ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#fff", wipLimit: 5, requiredFields: ["title"], githubState: null });
  });

  it("handles null wip_limit", () => {
    const row: ColumnRow = { id: "c1", project_id: "p1", name: "X", position: 0, color: "#000", wip_limit: null, required_fields: "[]", github_state: "open" };
    expect(rowToColumn(row).wipLimit).toBeNull();
    expect(rowToColumn(row).githubState).toBe("open");
  });
});

describe("rowToSwimlane", () => {
  it("maps fields", () => {
    const row: SwimlaneRow = { id: "s1", project_id: "p1", name: "Backend", description: "server work", position: 1 };
    expect(rowToSwimlane(row)).toEqual({ id: "s1", projectId: "p1", name: "Backend", description: "server work", position: 1 });
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
  const row: TaskRow = { id: "t1", project_id: "p1", column_id: "c1", swimlane_id: null, title: "Fix bug", description: '{"type":"doc","content":[]}', priority: "high", type: "bug", assignee: "alice", position: "a0", github_issue_id: null, github_issue_number: null, github_repo: null, github_synced_state: null, created_at: NOW, updated_at: NOW };

  it("maps all fields", () => {
    const t = rowToTask(row);
    expect(t.id).toBe("t1");
    expect(t.projectId).toBe("p1");
    expect(t.priority).toBe("high");
    expect(t.type).toBe("bug");
    expect(t.assignee).toBe("alice");
    expect(t.github).toBeNull();
  });

  it("builds github object when linked", () => {
    const linked: TaskRow = { ...row, github_issue_id: "ghi1", github_issue_number: 42, github_repo: "owner/repo", github_synced_state: "open" };
    const t = rowToTask(linked);
    expect(t.github).toEqual({ issueId: "ghi1", issueNumber: 42, repo: "owner/repo", url: "https://github.com/owner/repo/issues/42", syncedState: "open", outOfSync: false });
  });

  it("detects outOfSync when column githubState differs", () => {
    const linked: TaskRow = { ...row, github_issue_id: "ghi1", github_issue_number: 1, github_repo: "r", github_synced_state: "open" };
    const t = rowToTask(linked, "closed");
    expect(t.github!.outOfSync).toBe(true);
  });

  it("uses column_github_state from row when arg not provided", () => {
    const linked: TaskRow = { ...row, github_issue_id: "ghi1", github_issue_number: 1, github_repo: "r", github_synced_state: "closed", column_github_state: "open" };
    const t = rowToTask(linked);
    expect(t.github!.outOfSync).toBe(true);
  });
});
