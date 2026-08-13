import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createMcpHandler } from "./server";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER_KEY = "lxk_" + "b".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

async function call(method: string, params: unknown, key: string | null = ADMIN_KEY) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const res = await handler(new Request("http://lexa.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: method, arguments: params } }),
  }));
  return (await res.json()) as any;
}

function toolResult(body: any): any {
  const text = body.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : null;
}


beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-milestones-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES
  ('s1', 'p1', 'Sprint 1', 0, 'sprint'),
  ('s-backlog', 'p1', 'Backlog', 1, 'backlog');
INSERT INTO milestones (id, project_id, name, position) VALUES ('ms1', 'p1', 'v1', 0);
INSERT INTO users (id, email, name, role) VALUES ('u1', 'member@lexa.test', 'Member', 'member');
INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u1', 'member', 'p1');
INSERT INTO api_keys (id, name, key_hash) VALUES ('k-admin', 'admin', '${adminHash}');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k-member', 'member', '${memberHash}', 'u1');
`);
  handler = createMcpHandler(dbPath);
});

afterAll(() => {
  try { db?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP milestone tools", () => {
  it("create_milestone then update with empty dueAt clears it", async () => {
    const created = await call("create_milestone", { project: "p1", name: "v2", dueAt: "2026-09-30" });
    expect(created.error).toBeUndefined();
    const m = toolResult(created);
    expect(m.name).toBe("v2");
    const updated = await call("update_milestone", { project: "p1", milestone: "V2", dueAt: "" });
    expect(updated.error).toBeUndefined();
    const u = toolResult(updated);
    expect(u.dueAt).toBeNull();
    expect(u.sprintCount).toBe(0);
  });

  it("create_milestone without admin → FORBIDDEN", async () => {
    const res = await call("create_milestone", { project: "p1", name: "x" }, MEMBER_KEY);
    expect(res.result.isError).toBe(true);
    expect(toolResult(res).code).toBe("FORBIDDEN");
  });

  it("archive_milestone cascades a linked sprint with a live task; restore brings milestone back only", async () => {
    const created = await call("create_milestone", { project: "p1", name: "v3" });
    const m = toolResult(created);
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id) VALUES ('sp3','p1','Sprint 3',2,'sprint',?)").run(m.id);
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type, created_at) VALUES ('t3','p1','c1','sp3','T3','a0','pr-1','tp-1','2026-01-01 10:00:00')").run();
    const archived = await call("archive_milestone", { project: "p1", milestone: "v3" });
    expect(toolResult(archived).message).toBe('Archived milestone "v3" (1 tasks archived)');
    const t3 = await call("get_task", { taskId: "t3" });
    expect(toolResult(t3).archivedAt).not.toBeNull();
    const restored = await call("restore_milestone", { project: "p1", milestone: "v3" });
    expect(toolResult(restored).message).toBe('Restored milestone "v3"');
    const t3again = await call("get_task", { taskId: "t3" });
    expect(toolResult(t3again).archivedAt).not.toBeNull(); // milestone only — sprints restore individually
  });

  it("delete_milestone with sprints → HAS_CHILDREN; empty → success", async () => {
    // Link a sprint to the seeded milestone via the tool itself (handler-owned
    // writes are always visible to the handler connection).
    const linked = await call("create_swimlane", { project: "p1", name: "Sprint v1", milestone: "v1" });
    expect(linked.error).toBeUndefined();
    const blocked = await call("delete_milestone", { project: "p1", milestone: "v1" });
    expect(blocked.result.isError).toBe(true);
    expect(toolResult(blocked).code).toBe("HAS_CHILDREN");
    const created = await call("create_milestone", { project: "p1", name: "empty" });
    const ok = await call("delete_milestone", { project: "p1", milestone: "empty" });
    expect(ok.result.isError).toBeUndefined();
    expect(toolResult(ok).message).toBe('Deleted milestone "empty"');
  });

  it("unknown milestone → MILESTONE_NOT_FOUND + availableMilestones", async () => {
    const res = await call("update_milestone", { project: "p1", milestone: "Ghost" });
    expect(res.result.isError).toBe(true);
    const err = toolResult(res);
    expect(err.code).toBe("MILESTONE_NOT_FOUND");
    expect(err.details.availableMilestones).toContain("v1");
  });
});

describe("MCP swimlane milestone/startAt args", () => {
  it("create_swimlane with milestone + startAt persists both", async () => {
    const res = await call("create_swimlane", { project: "p1", name: "Sprint Linked", milestone: "v1", startAt: "2026-08-10" });
    expect(res.error).toBeUndefined();
    expect(toolResult(res).id).toBeTruthy();
    const row = db.prepare("SELECT milestone_id, start_at FROM swimlanes WHERE name = 'Sprint Linked'").get() as { milestone_id: string | null; start_at: string | null };
    expect(row.milestone_id).toBe("ms1");
    expect(row.start_at).toBe("2026-08-10");
  });

  it("update_swimlane with empty milestone detaches the lane", async () => {
    const res = await call("update_swimlane", { project: "p1", swimlane: "Sprint Linked", milestone: "" });
    expect(res.error).toBeUndefined();
    const row = db.prepare("SELECT milestone_id FROM swimlanes WHERE name = 'Sprint Linked'").get() as { milestone_id: string | null };
    expect(row.milestone_id).toBeNull();
  });

  it("create_swimlane with unknown milestone → MILESTONE_NOT_FOUND", async () => {
    const res = await call("create_swimlane", { project: "p1", name: "Bad", milestone: "Ghost" });
    expect(res.result.isError).toBe(true);
    expect(toolResult(res).code).toBe("MILESTONE_NOT_FOUND");
  });
});
