import { Effect } from "effect";
import { DbError } from "../db/database";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";

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

export interface MentionSearchResult {
  tasks: MentionTaskHit[];
  wikiPages: MentionWikiHit[];
}

export const MENTION_RESULTS_CAP = 8;

// GET /api/projects/:slug/mentions?q= — read-only cross-repo lookup for the
// editor @-autocomplete. Deliberately NOT folded into HeraldService: this is
// a plain project-scoped read with no provider/thread coupling. Chat-side
// @-token resolution is herald-domain logic and lives in HeraldService's
// chat branch (ephemeral system-prompt injection, never persisted).
export class MentionService extends Effect.Service<MentionService>()("Lexa/Mention", {
  dependencies: [TaskRepo.Default, WikiRepo.Default],
  effect: Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;

    // Case-insensitive substring on task key + title (archived excluded —
    // task-link search precedent) and wiki title + slug. Tasks first; the
    // wiki fills the remainder up to the cap. Empty q → empty arrays.
    const search = (projectId: string, q: string): Effect.Effect<MentionSearchResult, DbError> =>
      Effect.gen(function* () {
        const query = q.trim();
        if (query === "") return { tasks: [], wikiPages: [] };

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

        return {
          tasks: tasks.map((t) => ({ id: t.id, key: t.key ?? "", title: t.title })),
          wikiPages,
        };
      });

    return { search };
  }),
}) {}

