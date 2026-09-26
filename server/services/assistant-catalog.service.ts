import { Effect } from "effect";
import { AssistantCatalogRepo } from "../repos/assistant-catalog.repo";
import { AssistantTaskRepo } from "../repos/assistant-task.repo";
import { DbError, ConstraintViolation, Db, withTx } from "../db/db";
import { AgentNotFound, SkillNotFound, AgentBuiltinDelete, AgentEntityInUse } from "../api/errors";
import type { LexaAgent, LexaSkill } from "../../shared/types";

// Builtin seed defaults — mirrors migrations/0001_init.sql (the squashed
// 2026.1.0 baseline). Reset to default restores these exact values (and
// skill sets). Keep the two in sync when editing either.
export const ASSISTANT_AGENT: { id: string; instructions: string; skillIds: string[] } = {
  id: "assistant",
  instructions:
    "You are the Assistant Agent, Lexa's companion project-management assistant. You help teams run their projects: you draft and sharpen task descriptions, requirements, and wiki pages, spot missing details, unclear scope, and weak acceptance criteria, and answer questions about the project. You may read files in your working directory (the project workspace) to ground your writing in the actual repo and docs. You do not write files, run commands, or act on any system — your whole output is the text you write. Match the document's existing voice and structure. If the linked sources contradict the document, prefer the sources.",
  skillIds: ["requirements", "deliverables", "review", "definition-of-done", "status", "polish"],
};

const DEFAULT_SKILLS: Record<string, string> = {
  requirements:
    "Write only the task's requirements — what must hold when it's done. One concrete, verifiable condition per checkbox item (- [ ]). No design proposals or background. Output only the checklist.",
  deliverables:
    "Split the task into a checklist of deliverables — concrete, actionable outputs. Each must be independently completable. Note dependencies. Output only the checklist.",
  review:
    "Review the task like a project manager: fix missing details, unclear scope, weak requirements, and risks. Output the improved full task — not a separate report.",
  "definition-of-done":
    "Write a Definition of Done checklist (- [ ]): conditions that must hold before the task counts as complete. Each item concrete and verifiable. Output only the checklist.",
  status:
    "Write a status update: what's done, what's blocked (and why), what's next. Be honest; flag risks early. Output only the status update.",
  polish:
    "Polish the selected text: clearer and more concise, keeping the meaning, structure, and level of detail. Output only the polished text.",
};

export class AssistantCatalogService extends Effect.Service<AssistantCatalogService>()("Lexa/AssistantCatalog", {
  dependencies: [AssistantCatalogRepo.Default, AssistantTaskRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* AssistantCatalogRepo;
    const taskRepo = yield* AssistantTaskRepo;
    const db = yield* Db;

    return {
      // ── Agents ──
      listAgents: (): Effect.Effect<LexaAgent[], DbError> => repo.listAgents(),

      createAgent: (input: { name: string; description: string; instructions: string }): Effect.Effect<LexaAgent, ConstraintViolation | DbError> =>
        repo.createAgent({ ...input, id: crypto.randomUUID() }),

      updateAgent: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<LexaAgent, AgentNotFound | ConstraintViolation | DbError> =>
        repo.updateAgent(id, patch).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id }))),

      deleteAgent: (id: string): Effect.Effect<void, AgentNotFound | AgentBuiltinDelete | AgentEntityInUse | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const agent = yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
          if (agent.isBuiltin) {
            return yield* new AgentBuiltinDelete({ kind: "agent", name: agent.name });
          }
          const count = yield* taskRepo.countTasksByAgent(id);
          if (count > 0) {
            return yield* new AgentEntityInUse({ kind: "agent", name: agent.name, count });
          }
          yield* repo.deleteAgent(id).pipe(
            Effect.catchTag("RowNotFound", () => new AgentNotFound({ id }))
          );
        }),

      replaceAgentSkills: (agentId: string, skillIds: string[]): Effect.Effect<LexaAgent, AgentNotFound | SkillNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.findAgentById(agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: agentId })));
          const skills = yield* repo.listSkills();
          const known = new Set(skills.map((s) => s.id));
          for (const skillId of skillIds) {
            if (!known.has(skillId)) {
              return yield* new SkillNotFound({ id: skillId });
            }
          }
          yield* repo.replaceAgentSkills(agentId, skillIds);
          return yield* repo.findAgentById(agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: agentId })));
        }),

      // Builtin-only: restore the seeded instructions + the agent's default
      // skill set (the single builtin assistant agent).
      resetAgentToDefault: (id: string): Effect.Effect<LexaAgent, AgentNotFound | AgentBuiltinDelete | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const agent = yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
          const seed = agent.id === ASSISTANT_AGENT.id ? ASSISTANT_AGENT : null;
          if (!agent.isBuiltin || seed === null) {
            return yield* new AgentBuiltinDelete({ kind: "agent", name: agent.name });
          }
          return yield* withTx(
            db,
            Effect.gen(function* () {
              yield* repo.updateAgent(id, { instructions: seed.instructions }).pipe(
                Effect.catchTag("RowNotFound", () => new AgentNotFound({ id }))
              );
              yield* repo.replaceAgentSkills(id, seed.skillIds);
              return yield* repo.findAgentById(id).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id })));
            })
          );
        }),

      // ── Skills ──
      listSkills: (): Effect.Effect<LexaSkill[], DbError> => repo.listSkills(),

      createSkill: (input: { name: string; description: string; instructions: string }): Effect.Effect<LexaSkill, ConstraintViolation | DbError> =>
        repo.createSkill({ ...input, id: crypto.randomUUID() }),

      updateSkill: (id: string, patch: { name?: string; description?: string; instructions?: string }): Effect.Effect<LexaSkill, SkillNotFound | ConstraintViolation | DbError> =>
        repo.updateSkill(id, patch).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id }))),

      deleteSkill: (id: string): Effect.Effect<void, SkillNotFound | AgentBuiltinDelete | AgentEntityInUse | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const skill = yield* repo.findSkillById(id).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id })));
          if (skill.isBuiltin) {
            return yield* new AgentBuiltinDelete({ kind: "skill", name: skill.name });
          }
          const count = yield* taskRepo.countTasksBySkill(id);
          if (count > 0) {
            return yield* new AgentEntityInUse({ kind: "skill", name: skill.name, count });
          }
          yield* repo.deleteSkill(id).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id }))
          );
        }),

      resetSkillToDefault: (id: string): Effect.Effect<LexaSkill, SkillNotFound | AgentBuiltinDelete | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const skill = yield* repo.findSkillById(id).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id })));
          const instructions = DEFAULT_SKILLS[skill.id];
          if (!skill.isBuiltin || instructions === undefined) {
            return yield* new AgentBuiltinDelete({ kind: "skill", name: skill.name });
          }
          return yield* repo.updateSkill(id, { instructions }).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id }))
          );
        }),
    };
  }),
}) {}
