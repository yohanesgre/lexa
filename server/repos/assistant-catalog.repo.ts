import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, withTx, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { LexaAgentRow, LexaSkillRow, rowToLexaAgent, rowToLexaSkill } from "../../shared/db";
import type { LexaAgent, LexaSkill } from "../../shared/types";

// Comma-joined attached skill ids for an agent row (agents list endpoint).
const AGENT_SELECT = `
  SELECT fa.*,
         (SELECT GROUP_CONCAT(skill_id) FROM lexa_agent_skills WHERE agent_id = fa.id) AS skill_ids
  FROM lexa_agents fa
`;

export class AssistantCatalogRepo extends Effect.Service<AssistantCatalogRepo>()("Lexa/AssistantCatalogRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      // ── Agents & skills (global rule bundles) ──
      listAgents: (): Effect.Effect<LexaAgent[], DbError> =>
        queryAll<LexaAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} ORDER BY fa.is_builtin DESC, fa.created_at`).pipe(
          Effect.map((rows) => rows.map((r) => rowToLexaAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean))))
        ),

      findAgentById: (id: string): Effect.Effect<LexaAgent, RowNotFound | DbError> =>
        queryFirst<LexaAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, id).pipe(
          Effect.map((r) => rowToLexaAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean)))
        ),

      createAgent: (input: { id: string; name: string; description: string; instructions: string }): Effect.Effect<LexaAgent, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES (?, ?, ?, ?, 0)`,
            input.id,
            input.name,
            input.description,
            input.instructions
          );
          const row = yield* queryFirst<LexaAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, input.id).pipe(
            Effect.catchTag("RowNotFound", () => new DbError({ message: "agent row missing after create" }))
          );
          return rowToLexaAgent(row, []);
        }),

      updateAgent: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<LexaAgent, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
          if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
          if (patch.instructions !== undefined) { sets.push("instructions = ?"); params.push(patch.instructions); }
          if (sets.length === 0) {
            return yield* queryFirst<LexaAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, id).pipe(
              Effect.map((r) => rowToLexaAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean)))
            );
          }
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE lexa_agents SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<LexaAgentRow & { skill_ids: string | null }>(db, `${AGENT_SELECT} WHERE fa.id = ?`, id).pipe(
            Effect.map((r) => rowToLexaAgent(r, (r.skill_ids ?? "").split(",").filter(Boolean)))
          );
        }),

      deleteAgent: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        run(db, `DELETE FROM lexa_agents WHERE id = ?`, id).pipe(
          Effect.flatMap((changes) => (changes === 0 ? Effect.fail(new RowNotFound({ table: "lexa_agents" })) : Effect.void))
        ),

      replaceAgentSkills: (agentId: string, skillIds: string[]): Effect.Effect<void, ConstraintViolation | DbError> =>
        withTx(
          db,
          Effect.gen(function* () {
            yield* run(db, `DELETE FROM lexa_agent_skills WHERE agent_id = ?`, agentId);
            for (const skillId of skillIds) {
              yield* run(db, `INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES (?, ?)`, agentId, skillId);
            }
          })
        ),

      listSkills: (): Effect.Effect<LexaSkill[], DbError> =>
        queryAll<LexaSkillRow>(db, `SELECT * FROM lexa_skills ORDER BY is_builtin DESC, created_at`).pipe(
          Effect.map((rows) => rows.map(rowToLexaSkill))
        ),

      findSkillById: (id: string): Effect.Effect<LexaSkill, RowNotFound | DbError> =>
        queryFirst<LexaSkillRow>(db, `SELECT * FROM lexa_skills WHERE id = ?`, id).pipe(Effect.map(rowToLexaSkill)),

      createSkill: (input: { id: string; name: string; description: string; instructions: string }): Effect.Effect<LexaSkill, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES (?, ?, ?, ?, 0)`,
            input.id,
            input.name,
            input.description,
            input.instructions
          );
          const row = yield* queryFirst<LexaSkillRow>(db, `SELECT * FROM lexa_skills WHERE id = ?`, input.id).pipe(
            Effect.catchTag("RowNotFound", () => new DbError({ message: "skill row missing after create" }))
          );
          return rowToLexaSkill(row);
        }),

      updateSkill: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<LexaSkill, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
          if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
          if (patch.instructions !== undefined) { sets.push("instructions = ?"); params.push(patch.instructions); }
          if (sets.length === 0) {
            return yield* queryFirst<LexaSkillRow>(db, `SELECT * FROM lexa_skills WHERE id = ?`, id).pipe(Effect.map(rowToLexaSkill));
          }
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE lexa_skills SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<LexaSkillRow>(db, `SELECT * FROM lexa_skills WHERE id = ?`, id).pipe(Effect.map(rowToLexaSkill));
        }),

      deleteSkill: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        run(db, `DELETE FROM lexa_skills WHERE id = ?`, id).pipe(
          Effect.flatMap((changes) => (changes === 0 ? Effect.fail(new RowNotFound({ table: "lexa_skills" })) : Effect.void))
        ),
    };
  }),
}) {}
