import { Effect } from "effect";
import { DbError } from "../db/db";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { MilestoneRepo } from "../repos/milestone.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { ColumnRepo } from "../repos/column.repo";
import {
  columnMentionSublabel,
  mentionSlug,
  milestoneMentionSublabel,
  swimlaneMentionSublabel,
} from "../../shared/mention-entities";

export interface MentionTaskHit {
  id: string;
  key: string;
  title: string;
}

export interface MentionWikiHit {
  id: string;
  slug: string;
  title: string;
}

// Milestones/swimlanes/columns have no `slug` column, so `slug` is the derived
// mention token (mentionSlug) and `sublabel` carries the popup's one-line hint.
export interface MentionEntityHit {
  id: string;
  name: string;
  slug: string;
  sublabel: string | null;
}

export interface MentionSearchResult {
  tasks: MentionTaskHit[];
  wikiPages: MentionWikiHit[];
  milestones: MentionEntityHit[];
  swimlanes: MentionEntityHit[];
  columns: MentionEntityHit[];
}

export const MENTION_RESULTS_CAP = 8;

// GET /api/projects/:slug/mentions?q= — read-only cross-repo lookup for the
// editor @-autocomplete. Deliberately NOT folded into AssistantService: this is
// a plain project-scoped read with no provider/thread coupling. Chat-side
// @-token resolution is assistant-domain logic and lives in AssistantService's
// chat branch (ephemeral system-prompt injection, never persisted).
export class MentionService extends Effect.Service<MentionService>()("Lexa/Mention", {
  dependencies: [TaskRepo.Default, WikiRepo.Default, MilestoneRepo.Default, SwimlaneRepo.Default, ColumnRepo.Default],
  effect: Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const milestoneRepo = yield* MilestoneRepo;
    const swimlaneRepo = yield* SwimlaneRepo;
    const columnRepo = yield* ColumnRepo;

    // Case-insensitive substring on the name and on the derived slug (mirrors
    // the wiki title-or-slug match).
    const matches = (name: string, query: string): boolean => {
      const q = query.toLowerCase();
      return name.toLowerCase().includes(q) || mentionSlug(name).includes(q);
    };

    // Case-insensitive substring on task key + title (archived excluded —
    // task-link search precedent) and wiki title + slug. Tasks first; the
    // wiki fills the remainder up to the cap. Milestones, swimlanes, and
    // columns each carry their own MENTION_RESULTS_CAP budget instead of
    // sharing the tasks+wiki remainder, so an exact entity match is never
    // squeezed out by task hits. Archived milestones and swimlanes are
    // excluded (archived-task precedent). Empty q (bare "@") → default
    // suggestions instead of nothing: most recently updated live tasks (≤ cap,
    // archived excluded) with wiki pages filling the remainder; milestones /
    // swimlanes / columns are searched, not defaulted, so they stay empty
    // until a query is typed (mentions-autocomplete.html state 1 / Behavior).
    const search = (projectId: string, q: string): Effect.Effect<MentionSearchResult, DbError> =>
      Effect.gen(function* () {
        const query = q.trim();
        if (query === "") {
          const tasks = yield* taskRepo.listRecent(projectId, MENTION_RESULTS_CAP);
          const remaining = MENTION_RESULTS_CAP - tasks.length;
          const wikiPages =
            remaining > 0
              ? (yield* wikiRepo.listRecent(projectId, remaining)).map((p) => ({ id: p.id, slug: p.slug, title: p.title }))
              : [];
          return {
            tasks: tasks.map((t) => ({ id: t.id, key: t.key ?? "", title: t.title })),
            wikiPages,
            milestones: [],
            swimlanes: [],
            columns: [],
          };
        }

        const tasks = yield* taskRepo.searchByKeyOrTitle(projectId, query, MENTION_RESULTS_CAP);
        const remaining = MENTION_RESULTS_CAP - tasks.length;
        const wikiPages =
          remaining > 0
            ? (yield* wikiRepo.findByProject(projectId))
                .filter(
                  (p) =>
                    p.title.toLowerCase().includes(query.toLowerCase()) ||
                    p.slug.toLowerCase().includes(query.toLowerCase())
                )
                .slice(0, remaining)
                .map((p) => ({ id: p.id, slug: p.slug, title: p.title }))
            : [];

        // All milestones (archived included) so a swimlane's owning milestone
        // name is always available; only live ones are offered as hits.
        const allMilestones = yield* milestoneRepo.findByProject(projectId);
        const milestoneNameById = new Map(allMilestones.map((m) => [m.id, m.name] as const));
        const milestones = allMilestones
          .filter((m) => m.archivedAt === null && matches(m.name, query))
          .slice(0, MENTION_RESULTS_CAP)
          .map((m) => ({ id: m.id, name: m.name, slug: mentionSlug(m.name), sublabel: milestoneMentionSublabel(m) }));
        const swimlanes = (yield* swimlaneRepo.findByProject(projectId))
          .filter((l) => l.archivedAt === null && matches(l.name, query))
          .slice(0, MENTION_RESULTS_CAP)
          .map((l) => ({
            id: l.id,
            name: l.name,
            slug: mentionSlug(l.name),
            sublabel: swimlaneMentionSublabel(l, l.milestoneId !== null ? milestoneNameById.get(l.milestoneId) ?? null : null),
          }));
        const columns = (yield* columnRepo.findByProject(projectId))
          .filter((c) => matches(c.name, query))
          .slice(0, MENTION_RESULTS_CAP)
          .map((c) => ({ id: c.id, name: c.name, slug: mentionSlug(c.name), sublabel: columnMentionSublabel(c) }));

        return {
          tasks: tasks.map((t) => ({ id: t.id, key: t.key ?? "", title: t.title })),
          wikiPages,
          milestones,
          swimlanes,
          columns,
        };
      });

    return { search };
  }),
}) {}
