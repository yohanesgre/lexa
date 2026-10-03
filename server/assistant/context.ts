// Shared per-turn context helpers (ADR-0004 §1; H1).
//
// `buildSkillPromptParts`, the @-mention resolver and the last-user-text probe
// are the assembly primitives the legacy REST services and the Worker-side
// harness assembly both use, so one prompt surface cannot drift from the other.
// The mention resolver is dependency-injected (no Effect service imports) so the
// Bun services and the Worker read path can share it verbatim.

import { Effect } from "effect";
import type { BoundSkill } from "./tools";
import { parseSkillTokens } from "../../shared/skill-tokens";
import { parseTaskKey } from "../task-key";
import {
  matchBoundSkillByName,
  buildMentionContextBlock,
  MENTION_CAPS,
  scanMentionTokens,
  type ResolvedMention,
} from "../services/assistant-helpers";
import {
  columnMentionSublabel,
  mentionSlug,
  milestoneMentionSublabel,
  swimlaneMentionSublabel,
} from "../../shared/mention-entities";
import { extractText } from "../../shared/tiptap-text";
import type { TipTapDoc } from "../../shared/types";

// Per-message skill context: the ≤3 `$mentioned` skills bound to the agent,
// injected under `## Skill: {name}`, plus the compact catalog of every bound
// skill (≤20 with descriptions, the rest counted). Catalog is null when the
// agent has nothing bound.
export function buildSkillPromptParts(
  message: string,
  boundSkills: readonly BoundSkill[]
): { skillMarkdowns: string[]; skillCatalog: string | null } {
  const mentioned = parseSkillTokens(message)
    .map((t) => matchBoundSkillByName(boundSkills, t))
    .filter((s): s is BoundSkill => s !== null)
    .slice(0, 3);
  const skillMarkdowns = mentioned
    .filter((s) => (s.instructions ?? "").trim() !== "")
    .map((s) => `## Skill: ${s.name}\n${s.instructions}`);
  const skillCatalog = boundSkills.length === 0 ? null
    : `Available skills — invoke with $name, or call get_skill for details:\n` +
      boundSkills.slice(0, 20).map((s) => { const d = (s.description ?? "").trim(); return d ? `- ${s.name} — ${d}` : `- ${s.name}`; }).join("\n") +
      (boundSkills.length > 20 ? `\n… and ${boundSkills.length - 20} more` : "");
  return { skillMarkdowns, skillCatalog };
}

/** User-role text of one message, or `null` when it is not a user message. */
function userMessageText(message: unknown): string | null {
  const m = message as { role?: unknown; content?: unknown; parts?: unknown } | null;
  if (!m || m.role !== "user") return null;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p): p is { type?: unknown; text?: unknown } => typeof p === "object" && p !== null)
      .filter((p) => (p.type === "text" || p.type === undefined) && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

/** Last user-role text in a transcript (legacy `content` string or UIMessage parts). */
export function lastUserText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = userMessageText(messages[i]);
    if (text !== null) return text;
  }
  return "";
}

/**
 * First user-role text with non-empty content in a transcript. Used to derive
 * a thread title from the opening turn (a leading attachment-only message with
 * no text is skipped so a later text turn can still seed the title).
 */
export function firstUserText(messages: readonly unknown[]): string {
  for (const message of messages) {
    const text = userMessageText(message);
    if (text !== null && text !== "") return text;
  }
  return "";
}

export interface MentionTaskHit {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: TipTapDoc;
}

export interface MentionWikiHit {
  id: string;
  title: string;
  content: TipTapDoc;
}

export interface MentionResolverDeps {
  dbAll: <T>(sql: string, ...params: unknown[]) => Promise<T[]>;
  /** `null` on RowNotFound; throws on other errors (mirrors the service path). */
  findTaskByKey: (key: string) => Promise<MentionTaskHit | null>;
  /** `null` on RowNotFound; throws on other errors (mirrors the service path). */
  findWikiBySlug: (projectId: string, slug: string) => Promise<MentionWikiHit | null>;
}

interface MentionEntities {
  milestones: Array<{ id: string; name: string; due_at: string | null; archived_at: string | null; sprint_count: number }>;
  swimlanes: Array<{ id: string; name: string; kind: "backlog" | "sprint"; due_at: string | null; archived_at: string | null; milestone_id: string | null }>;
  columns: Array<{ id: string; name: string; position: number; github_state: "open" | "closed" | null; is_done: number }>;
}

// Resolve `@`-mentions in a message to a labeled context block. Total: every
// lookup failure is treated as "no hit", never as a turn failure. One token may
// match SEVERAL kinds (a wiki page and a milestone/column can share a derived
// slug), so a hit never consumes the token: every kind is tried for every
// token, dedupe is by `kind:id`, and the overall cap stays at
// `MENTION_CAPS.maxMentions`.
export async function resolveMentionContext(
  deps: MentionResolverDeps,
  projectId: string,
  message: string
): Promise<string> {
  const tokens = scanMentionTokens(message);
  if (tokens.length === 0) return "";
  const seen = new Set<string>();
  const resolved: ResolvedMention[] = [];
  const add = (m: ResolvedMention): void => {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key) || resolved.length >= MENTION_CAPS.maxMentions) return;
    seen.add(key);
    resolved.push(m);
  };
  // Milestones/swimlanes/columns have no `slug` column, so a token is matched
  // against the derived slug (mentionSlug) of each name. Loaded lazily and once
  // per message; archived milestones/swimlanes are skipped for matching but kept
  // in the list so a swimlane's owning milestone name still resolves.
  let entities: MentionEntities | null = null;
  const loadEntities = async (): Promise<MentionEntities> => {
    const rows = async <T>(sql: string): Promise<T[]> => {
      try {
        return await deps.dbAll<T>(sql, projectId);
      } catch {
        return [];
      }
    };
    const milestones = await rows<MentionEntities["milestones"][number]>(
      `SELECT m.id, m.name, m.due_at, m.archived_at,
              (SELECT COUNT(*) FROM swimlanes s WHERE s.milestone_id = m.id) AS sprint_count
       FROM milestones m WHERE m.project_id = ? ORDER BY m.position`
    );
    const swimlanes = await rows<MentionEntities["swimlanes"][number]>(
      `SELECT id, name, kind, due_at, archived_at, milestone_id FROM swimlanes WHERE project_id = ? ORDER BY position`
    );
    const columns = await rows<MentionEntities["columns"][number]>(
      `SELECT id, name, position, github_state, is_done FROM columns WHERE project_id = ? ORDER BY position`
    );
    return { milestones, swimlanes, columns };
  };
  for (const token of tokens) {
    if (resolved.length >= MENTION_CAPS.maxMentions) break;
    const parsed = parseTaskKey(token);
    if (parsed) {
      let t: MentionTaskHit | null = null;
      try {
        t = await deps.findTaskByKey(`${parsed.prefix}-${parsed.number}`);
      } catch {
        t = null;
      }
      if (!t || t.projectId !== projectId) continue;
      add({ kind: "task", id: t.id, label: `${t.key} — ${t.title}`, text: extractText(t.description) });
    } else {
      const slug = token.toLowerCase();
      let page: MentionWikiHit | null = null;
      let firstFailedWithOther = false;
      try {
        page = await deps.findWikiBySlug(projectId, token);
      } catch {
        firstFailedWithOther = true;
      }
      if (page === null && !firstFailedWithOther) {
        try {
          page = await deps.findWikiBySlug(projectId, slug);
        } catch {
          page = null;
        }
      }
      if (page) {
        add({ kind: "wiki", id: page.id, label: page.title, text: extractText(page.content) });
      }
      if (entities === null) entities = await loadEntities();
      const target = mentionSlug(token);
      if (target === "") continue;
      const milestone = entities.milestones.find((m) => m.archived_at === null && mentionSlug(m.name) === target);
      if (milestone) {
        add({
          kind: "milestone",
          id: milestone.id,
          label: milestone.name,
          text: milestoneMentionSublabel({ dueAt: milestone.due_at, archivedAt: milestone.archived_at, sprintCount: milestone.sprint_count }),
        });
      }
      const swimlane = entities.swimlanes.find((l) => l.archived_at === null && mentionSlug(l.name) === target);
      if (swimlane) {
        const owningMilestone = swimlane.milestone_id !== null
          ? entities.milestones.find((m) => m.id === swimlane.milestone_id)?.name ?? null
          : null;
        add({
          kind: "swimlane",
          id: swimlane.id,
          label: swimlane.name,
          text: swimlaneMentionSublabel({ kind: swimlane.kind, dueAt: swimlane.due_at, archivedAt: swimlane.archived_at }, owningMilestone),
        });
      }
      const column = entities.columns.find((c) => mentionSlug(c.name) === target);
      if (column) {
        add({
          kind: "column",
          id: column.id,
          label: column.name,
          text: columnMentionSublabel({ position: column.position, isDone: column.is_done !== 0, githubState: column.github_state }),
        });
      }
    }
  }
  return buildMentionContextBlock(resolved);
}

/** Effect wrapper for service call sites; the resolver itself never fails. */
export function resolveMentionContextEffect(
  deps: MentionResolverDeps,
  projectId: string,
  message: string
): Effect.Effect<string, never> {
  return Effect.promise(() => resolveMentionContext(deps, projectId, message));
}
