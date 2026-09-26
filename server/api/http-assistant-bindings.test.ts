import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "b".repeat(43);
const MEMBER_KEY = "lxk_" + "c".repeat(43);
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

const authed = (path: string, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { headers: { authorization: `Bearer ${key}` } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-bindings-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin'), ('u2','m@lexa.test','M','member');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1'), ('k2','mem','${memberHash}','u2');
    INSERT INTO projects (id, name, slug) VALUES ('p1','Alpha','alpha'), ('p2','Beta','beta'), ('p3','Gamma','gamma');
    INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1','Opencode Go','https://x','sk');
    INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('mdl1','pr1','gpt-5.1','openai_compatible',0,1);
    INSERT INTO assistant_settings (project_id, provider_id, primary_model_id, fallback_model_ids, write_tools, search_api_key, reasoning_effort)
      VALUES ('p1','pr1','mdl1','["mdl2","mdl3"]','create_task,update_task','exa-key','high');
    INSERT INTO assistant_settings (project_id) VALUES ('p3');
    INSERT INTO project_memory (id, project_id, content, source) VALUES ('m1','p1','note one','assistant'), ('m2','p1','note two','assistant');
  `);
  handler = createApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

describe("GET /api/admin/assistant/bindings", () => {
  it("returns one row per project with labels and counts, including unconfigured", async () => {
    const res = await handler(authed("/api/admin/assistant/bindings"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.map((r) => r.projectId)).toEqual(["p1", "p2", "p3"]);

    const configured = body.data[0]!;
    expect(configured.projectName).toBe("Alpha");
    expect(configured.projectSlug).toBe("alpha");
    expect(configured.providerId).toBe("pr1");
    expect(configured.providerLabel).toBe("Opencode Go");
    expect(configured.modelId).toBe("mdl1");
    expect(configured.modelLabel).toBe("gpt-5.1");
    expect(configured.fallbackCount).toBe(2);
    expect(configured.writeToolsCount).toBe(2);
    expect(configured.memoryCount).toBe(2);
    expect(configured.hasSearchKey).toBe(true);
    expect(configured.reasoningEffort).toBe("high");
    expect(configured.updatedAt).not.toBeNull();

    const unconfigured = body.data[1]!;
    expect(unconfigured.providerId).toBeNull();
    expect(unconfigured.providerLabel).toBeNull();
    expect(unconfigured.modelId).toBeNull();
    expect(unconfigured.modelLabel).toBeNull();
    expect(unconfigured.fallbackCount).toBe(0);
    expect(unconfigured.writeToolsCount).toBe(0);
    expect(unconfigured.memoryCount).toBe(0);
    expect(unconfigured.hasSearchKey).toBe(false);
    expect(unconfigured.reasoningEffort).toBeNull();
    expect(unconfigured.updatedAt).toBeNull();

    const empty = body.data[2]!;
    expect(empty.projectId).toBe("p3");
    expect(empty.providerId).toBeNull();
    expect(empty.fallbackCount).toBe(0);
    expect(empty.writeToolsCount).toBe(0);
    expect(empty.hasSearchKey).toBe(false);
    expect(empty.updatedAt).not.toBeNull();
  });

  it("member → 403", async () => {
    const res = await handler(authed("/api/admin/assistant/bindings", MEMBER_KEY));
    expect(res.status).toBe(403);
  });
});
