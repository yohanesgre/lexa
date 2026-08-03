import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { RuntimeRow, ForgeTaskRow, ForgeTaskLogRow, ForgeAgentRow, ForgeSkillRow, rowToRuntime, rowToForgeTask, rowToForgeTaskLog, rowToForgeAgent, rowToForgeSkill } from "../../shared/db";
import type { Runtime, ForgeTask, ForgeTaskLog, ForgeProvider, ForgeTaskStatus, ForgeAgent, ForgeSkill } from "../../shared/types";

// Hard cap for a task's activity log: a verbose agent run can emit hundreds
// of lines, so trim each task's log to the newest LOG_CAP rows (FIFO).
const LOG_CAP = 400;

// Forge tasks are always read joined with their document's title and the
// agent/skill names so the UI can show names instead of raw ids.
const TASK_SELECT = `
  SELECT ft.*,
         CASE WHEN ft.document_type = 'task' THEN (SELECT title FROM tasks WHERE id = ft.document_id)
              ELSE (SELECT title FROM wiki_pages WHERE slug = ft.document_id) END AS document_title,
         fa.name AS agent_name,
         fs.name AS skill_name
  FROM forge_tasks ft
  LEFT JOIN forge_agents fa ON fa.id = ft.agent_id
  LEFT JOIN forge_skills fs ON fs.id = ft.skill_id
`;

// Comma-joined attached skill ids for an agent row (agents list endpoint).
const AGENT_SELECT = `
  SELECT fa.*,
         (SELECT GROUP_CONCAT(skill_id) FROM forge_agent_skills WHERE agent_id = fa.id) AS skill_ids
  FROM forge_agents fa
`;

export class ForgeRepo extends Effect.Service<ForgeRepo>()("Lexa/ForgeRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      // ── Runtimes ──
      registerRuntime: (input: { id: string; name: string; provider: ForgeProvider; machineId: string; agent: string; model: string; hostname: string }): Effect.Effect<Runtime, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO runtimes (id, name, provider, machine_id, agent, model, status, hostname, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, 'online', ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               provider = excluded.provider,
               machine_id = excluded.machine_id,
               status = 'online',
               hostname = excluded.hostname,
               last_seen = datetime('now')`,
            input.id,
            input.name,
            input.provider,
            input.machineId,
            input.agent,
            input.model,
            input.hostname
          );
          const rows = yield* queryAll<RuntimeRow>(db, `SELECT * FROM runtimes WHERE id = ?`, input.id);
          const row = rows[0];
          if (!row) return yield* Effect.fail(new DbError({ message: "runtime row missing after registration" }));
          return rowToRuntime(row);
        }),

      updateRuntimeHeartbeat: (id: string, mcpConnected: boolean): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `UPDATE runtimes SET status = 'online', mcp_connected = ?, last_seen = datetime('now') WHERE id = ?`, mcpConnected ? 1 : 0, id).pipe(
          Effect.map(() => undefined)
        ),

      markRuntimesOffline: (): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `UPDATE runtimes SET status = 'offline' WHERE last_seen < datetime('now', '-2 minutes')`).pipe(
          Effect.map(() => undefined)
        ),

      findRuntimeById: (id: string): Effect.Effect<Runtime, RowNotFound | DbError> =>
        queryFirst<RuntimeRow>(db, `SELECT * FROM runtimes WHERE id = ?`, id).pipe(Effect.map(rowToRuntime)),

      deleteRuntime: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        run(db, `DELETE FROM runtimes WHERE id = ?`, id).pipe(
          Effect.flatMap((changes) =>
            changes === 0 ? Effect.fail(new RowNotFound({ table: "runtimes" })) : Effect.void
          )
        ),

      updateRuntime: (id: string, patch: { name?: string; provider?: ForgeProvider; agent?: string; model?: string; printLogs?: boolean; logLevel?: string; extraArgs?: string[] }): Effect.Effect<Runtime, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.name !== undefined) {
            sets.push("name = ?");
            params.push(patch.name);
          }
          if (patch.provider !== undefined) {
            sets.push("provider = ?");
            params.push(patch.provider);
          }
          if (patch.agent !== undefined) {
            sets.push("agent = ?");
            params.push(patch.agent);
          }
          if (patch.model !== undefined) {
            sets.push("model = ?");
            params.push(patch.model);
          }
          if (patch.printLogs !== undefined) {
            sets.push("print_logs = ?");
            params.push(patch.printLogs ? 1 : 0);
          }
          if (patch.logLevel !== undefined) {
            sets.push("log_level = ?");
            params.push(patch.logLevel);
          }
          if (patch.extraArgs !== undefined) {
            sets.push("extra_args = ?");
            params.push(JSON.stringify(patch.extraArgs));
          }
          if (sets.length === 0) {
            return yield* queryFirst<RuntimeRow>(db, `SELECT * FROM runtimes WHERE id = ?`, id).pipe(
              Effect.map(rowToRuntime)
            );
          }
          params.push(id);
          yield* run(db, `UPDATE runtimes SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<RuntimeRow>(db, `SELECT * FROM runtimes WHERE id = ?`, id).pipe(
            Effect.map(rowToRuntime)
          );
        }),

      updateRuntimeModels: (id: string, models: { id: string; provider: string; name: string }[]): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `UPDATE runtimes SET models_catalog = ? WHERE id = ?`, JSON.stringify(models), id).pipe(
          Effect.map(() => undefined)
        ),

      updateRuntimeAgents: (id: string, agents: { id: string; name: string }[]): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `UPDATE runtimes SET agents_catalog = ? WHERE id = ?`, JSON.stringify(agents), id).pipe(
          Effect.map(() => undefined)
        ),

      updateRuntimeCatalogs: (input: { id: string; machineId: string; agentCli: ForgeProvider; models: { id: string; provider: string; name: string }[]; agents: { id: string; name: string }[] }): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `UPDATE runtimes SET models_catalog = ?, agents_catalog = ? WHERE id = ? AND machine_id = ? AND provider = ?`,
          JSON.stringify(input.models),
          JSON.stringify(input.agents),
          input.id,
          input.machineId,
          input.agentCli
        ).pipe(Effect.map(() => undefined)),

      listRuntimes: (): Effect.Effect<Runtime[], DbError> =>
        queryAll<RuntimeRow>(db, `SELECT * FROM runtimes ORDER BY created_at`).pipe(
          Effect.map((rows) => rows.map(rowToRuntime))
        ),

      // ── Agents & skills (global rule bundles) ──
      listAgents: (): Effect.Effect<ForgeAgent[], DbError> =>
        queryAll<ForgeAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} ORDER BY fa.is_builtin DESC, fa.created_at`).pipe(
          Effect.map((rows) => rows.map((r) => rowToForgeAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean))))
        ),

      findAgentById: (id: string): Effect.Effect<ForgeAgent, RowNotFound | DbError> =>
        queryFirst<ForgeAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, id).pipe(
          Effect.map((r) => rowToForgeAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean)))
        ),

      createAgent: (input: { id: string; name: string; description: string; instructions: string }): Effect.Effect<ForgeAgent, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO forge_agents (id, name, description, instructions, is_builtin) VALUES (?, ?, ?, ?, 0)`,
            input.id,
            input.name,
            input.description,
            input.instructions
          );
          const row = yield* queryFirst<ForgeAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, input.id).pipe(
            Effect.catchTag("RowNotFound", () => new DbError({ message: "agent row missing after create" }))
          );
          return rowToForgeAgent(row, []);
        }),

      updateAgent: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<ForgeAgent, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
          if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
          if (patch.instructions !== undefined) { sets.push("instructions = ?"); params.push(patch.instructions); }
          if (sets.length === 0) {
            return yield* queryFirst<ForgeAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, id).pipe(
              Effect.map((r) => rowToForgeAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean)))
            );
          }
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE forge_agents SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<ForgeAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, id).pipe(
            Effect.map((r) => rowToForgeAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean)))
          );
        }),

      deleteAgent: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        run(db, `DELETE FROM forge_agents WHERE id = ?`, id).pipe(
          Effect.flatMap((changes) => (changes === 0 ? Effect.fail(new RowNotFound({ table: "forge_agents" })) : Effect.void))
        ),

      replaceAgentSkills: (agentId: string, skillIds: string[]): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(db, `DELETE FROM forge_agent_skills WHERE agent_id = ?`, agentId);
          for (const skillId of skillIds) {
            yield* run(db, `INSERT INTO forge_agent_skills (agent_id, skill_id) VALUES (?, ?)`, agentId, skillId);
          }
        }),

      listSkills: (): Effect.Effect<ForgeSkill[], DbError> =>
        queryAll<ForgeSkillRow>(db, `SELECT * FROM forge_skills ORDER BY is_builtin DESC, created_at`).pipe(
          Effect.map((rows) => rows.map(rowToForgeSkill))
        ),

      findSkillById: (id: string): Effect.Effect<ForgeSkill, RowNotFound | DbError> =>
        queryFirst<ForgeSkillRow>(db, `SELECT * FROM forge_skills WHERE id = ?`, id).pipe(Effect.map(rowToForgeSkill)),

      createSkill: (input: { id: string; name: string; description: string; instructions: string }): Effect.Effect<ForgeSkill, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO forge_skills (id, name, description, instructions, is_builtin) VALUES (?, ?, ?, ?, 0)`,
            input.id,
            input.name,
            input.description,
            input.instructions
          );
          const row = yield* queryFirst<ForgeSkillRow>(db, `SELECT * FROM forge_skills WHERE id = ?`, input.id).pipe(
            Effect.catchTag("RowNotFound", () => new DbError({ message: "skill row missing after create" }))
          );
          return rowToForgeSkill(row);
        }),

      updateSkill: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<ForgeSkill, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
          if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
          if (patch.instructions !== undefined) { sets.push("instructions = ?"); params.push(patch.instructions); }
          if (sets.length === 0) {
            return yield* queryFirst<ForgeSkillRow>(db, `SELECT * FROM forge_skills WHERE id = ?`, id).pipe(Effect.map(rowToForgeSkill));
          }
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE forge_skills SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<ForgeSkillRow>(db, `SELECT * FROM forge_skills WHERE id = ?`, id).pipe(Effect.map(rowToForgeSkill));
        }),

      deleteSkill: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        run(db, `DELETE FROM forge_skills WHERE id = ?`, id).pipe(
          Effect.flatMap((changes) => (changes === 0 ? Effect.fail(new RowNotFound({ table: "forge_skills" })) : Effect.void))
        ),

      // ── Tasks ──
      createTask: (input: {
        id: string;
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        agentId: string;
        skillId: string;
        extraPrompt: string;
        selection: string;
        docContext: string;
        runtimeId?: string;          // preferred runtime (set at claim time if omitted)
      }): Effect.Effect<ForgeTask, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO forge_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, doc_context, status, runtime_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
            input.id,
            input.projectId,
            input.documentType,
            input.documentId,
            input.agentId,
            input.skillId,
            input.extraPrompt,
            input.selection,
            input.docContext,
            input.runtimeId ?? null
          );
          return yield* queryFirst<ForgeTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, input.id).pipe(
            Effect.map(rowToForgeTask)
          );
        }),

      findTaskById: (id: string): Effect.Effect<ForgeTask, RowNotFound | DbError> =>
        queryFirst<ForgeTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, id).pipe(Effect.map(rowToForgeTask)),

      // Claim a queued task for a runtime. A task pinned to a specific runtime
      // (runtime_id set at create) may ONLY be claimed by that runtime.
      // Unpinned tasks (runtime_id null) are claimable by anyone, FIFO.
      claimNextTask: (runtimeId: string): Effect.Effect<ForgeTask | null, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const rows = yield* queryAll<ForgeTaskRow>(
            db,
            `${TASK_SELECT}
             WHERE ft.status = 'queued'
               AND (ft.runtime_id IS NULL OR ft.runtime_id = ?)
             ORDER BY (ft.runtime_id = ?) DESC, ft.created_at
             LIMIT 1`,
            runtimeId,
            runtimeId
          );
          const task = rows[0];
          if (!task) return null;
          yield* run(
            db,
            `UPDATE forge_tasks SET status = 'running', runtime_id = ?, started_at = datetime('now') WHERE id = ? AND status = 'queued'`,
            runtimeId,
            task.id
          );
          const updated = yield* queryFirst<ForgeTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, task.id).pipe(
            Effect.map(rowToForgeTask)
          );
          // If the conditional update lost the race, return null (someone else claimed it).
          return updated.status === "running" && updated.runtimeId === runtimeId ? updated : null;
        }),

      // Terminal status writes. Cancel wins over a late daemon complete/fail:
      // the daemon may still be finishing a run after the user cancelled it,
      // so complete/fail only transition from 'running'. Cancel transitions
      // from 'queued' or 'running'. A no-op (0 rows changed) returns the row
      // unchanged.
      updateTaskStatus: (id: string, status: ForgeTask["status"], result?: string | null, error?: string | null): Effect.Effect<ForgeTask, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets = ["status = ?", "finished_at = datetime('now')"];
          const params: unknown[] = [status];
          if (result !== undefined) {
            sets.push("result = ?");
            params.push(result);
          }
          if (error !== undefined) {
            sets.push("error = ?");
            params.push(error);
          }
          const from =
            status === "cancelled" ? "status IN ('queued', 'running')" : "status = 'running'";
          params.push(id);
          yield* run(
            db,
            `UPDATE forge_tasks SET ${sets.join(", ")} WHERE id = ? AND ${from}`,
            ...params
          );
          return yield* queryFirst<ForgeTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, id).pipe(
            Effect.map(rowToForgeTask)
          );
        }),

      listTasksForDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<ForgeTask[], DbError> =>
        queryAll<ForgeTaskRow>(
          db,
          `${TASK_SELECT}
           WHERE ft.project_id = ? AND ft.document_type = ? AND ft.document_id = ?
           ORDER BY ft.created_at DESC
           LIMIT 20`,
          projectId,
          documentType,
          documentId
        ).pipe(Effect.map((rows) => rows.map(rowToForgeTask))),

      // Recent tasks across all projects (for the navbar status bar).
      listRecent: (limit = 10): Effect.Effect<Array<ForgeTask & { project_name: string }>, DbError> =>
        queryAll<ForgeTaskRow & { project_name: string }>(
          db,
          `SELECT ft.*, p.name AS project_name,
                  CASE WHEN ft.document_type = 'task' THEN (SELECT title FROM tasks WHERE id = ft.document_id)
                       ELSE (SELECT title FROM wiki_pages WHERE slug = ft.document_id) END AS document_title,
                  fa.name AS agent_name,
                  fs.name AS skill_name
           FROM forge_tasks ft
           INNER JOIN projects p ON p.id = ft.project_id
           LEFT JOIN forge_agents fa ON fa.id = ft.agent_id
           LEFT JOIN forge_skills fs ON fs.id = ft.skill_id
           ORDER BY ft.created_at DESC
           LIMIT ?`,
          limit
        ).pipe(
          Effect.map((rows) => rows.map((r) => ({ ...rowToForgeTask(r), project_name: r.project_name })))
        ),

      // Full task history (Forge control panel). Keyset-paginated on
      // (created_at, id) descending; the id tiebreak keeps the cursor stable
      // across rows created in the same second. Filters are optional.
      listHistory: (
        filters: { projectId?: string; status?: ForgeTaskStatus; skillId?: string; documentType?: "task" | "wiki" },
        limit: number,
        cursor?: string
      ): Effect.Effect<{ tasks: Array<ForgeTask & { project_name: string }>; hasMore: boolean }, DbError> => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (filters.projectId) {
          conditions.push("ft.project_id = ?");
          params.push(filters.projectId);
        }
        if (filters.status) {
          conditions.push("ft.status = ?");
          params.push(filters.status);
        }
        if (filters.skillId) {
          conditions.push("ft.skill_id = ?");
          params.push(filters.skillId);
        }
        if (filters.documentType) {
          conditions.push("ft.document_type = ?");
          params.push(filters.documentType);
        }
        if (cursor) {
          const [createdAt, id] = cursor.split(":");
          if (createdAt && id) {
            conditions.push("(ft.created_at < ? OR (ft.created_at = ? AND ft.id < ?))");
            params.push(createdAt, createdAt, id);
          }
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const sql = `SELECT ft.*, p.name AS project_name,
                            CASE WHEN ft.document_type = 'task' THEN (SELECT title FROM tasks WHERE id = ft.document_id)
                                 ELSE (SELECT title FROM wiki_pages WHERE slug = ft.document_id) END AS document_title,
                            fa.name AS agent_name,
                            fs.name AS skill_name
                     FROM forge_tasks ft
                     INNER JOIN projects p ON p.id = ft.project_id
                     LEFT JOIN forge_agents fa ON fa.id = ft.agent_id
                     LEFT JOIN forge_skills fs ON fs.id = ft.skill_id
                     ${where}
                     ORDER BY ft.created_at DESC, ft.id DESC
                     LIMIT ?`;
        return queryAll<ForgeTaskRow & { project_name: string }>(db, sql, ...params, limit + 1).pipe(
          Effect.map((rows) => {
            const hasMore = rows.length > limit;
            const tasks = rows.slice(0, limit).map((r) => ({ ...rowToForgeTask(r), project_name: r.project_name }));
            return { tasks, hasMore };
          })
        );
      },

      // Per-status totals for the control panel's summary strip (global, not
      // filter-scoped — the strip describes the system, the table is the view).
      countByStatus: (): Effect.Effect<Record<ForgeTaskStatus, number>, DbError> =>
        queryAll<{ status: ForgeTaskStatus; n: number }>(
          db,
          `SELECT status, COUNT(*) AS n FROM forge_tasks GROUP BY status`
        ).pipe(
          Effect.map((rows) => {
            const counts: Record<ForgeTaskStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
            for (const r of rows) counts[r.status] = r.n;
            return counts;
          })
        ),

      // Tasks referencing an agent/skill (delete guards — an entity still in
      // use by queued/running/history rows cannot be removed).
      countTasksByAgent: (agentId: string): Effect.Effect<number, DbError> =>
        queryAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM forge_tasks WHERE agent_id = ?`, agentId).pipe(
          Effect.map((rows) => rows[0]?.n ?? 0)
        ),

      countTasksBySkill: (skillId: string): Effect.Effect<number, DbError> =>
        queryAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM forge_tasks WHERE skill_id = ?`, skillId).pipe(
          Effect.map((rows) => rows[0]?.n ?? 0)
        ),

      // ── Task activity log ──
      appendLog: (id: string, taskId: string, message: string): Effect.Effect<ForgeTaskLog, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `DELETE FROM forge_task_logs WHERE task_id = ? AND id NOT IN (
               SELECT id FROM forge_task_logs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${LOG_CAP - 1}
             )`,
            taskId,
            taskId
          );
          yield* run(
            db,
            `INSERT INTO forge_task_logs (id, task_id, message) VALUES (?, ?, ?)`,
            id,
            taskId,
            message
          );
          return yield* queryFirst<ForgeTaskLogRow>(db, `SELECT * FROM forge_task_logs WHERE id = ?`, id).pipe(
            Effect.map(rowToForgeTaskLog)
          );
        }),

      listLogs: (taskId: string): Effect.Effect<ForgeTaskLog[], DbError> =>
        queryAll<ForgeTaskLogRow>(db, `SELECT * FROM forge_task_logs WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`, taskId).pipe(
          Effect.map((rows) => rows.map(rowToForgeTaskLog))
        ),
    };
  }),
}) {}
