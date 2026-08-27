import { Effect } from "effect";
import { Sqlite, DbError, ConstraintViolation } from "../db/database";
import { ActivityRepo } from "../repos/activity.repo";
import { CommentRepo } from "../repos/comment.repo";
import { ActivityItem, Actor, ActivityType, ActivityEvent } from "../../shared/types";

export class ActivityService extends Effect.Service<ActivityService>()("Lexa/ActivityService", {
  dependencies: [ActivityRepo.Default, CommentRepo.Default],
  effect: Effect.gen(function* () {
    const activityRepo = yield* ActivityRepo;
    const commentRepo = yield* CommentRepo;
    const db = yield* Sqlite;

    const append = (taskId: string, actor: Actor, type: ActivityType, message: string, opts?: { viaHerald?: boolean }): Effect.Effect<ActivityEvent, DbError | ConstraintViolation> =>
      // Single-statement insert (no BEGIN) — inherently joins an outer
      // withTx/batch transaction on the shared connection.
      activityRepo.insert({
        taskId, actorKind: actor.kind, actorLabel: actor.label,
        actorUserId: actor.userId ?? null, type, message,
        viaHerald: opts?.viaHerald === true,
      });

    const listMerged = (taskId: string, cursor: string | null, limit: number): Effect.Effect<{ items: ActivityItem[]; nextCursor: string | null }, DbError> =>
      Effect.gen(function* () {
        const parsed = cursor ? (() => {
          const parts = cursor.split("|");
          const createdAt = parts[0] ?? "";
          const idStr = parts[1] ?? "0";
          const kind = parts[2] as "event" | "comment" | undefined;
          if (!createdAt || !idStr || !kind) return null;
          return { createdAt, id: Number(idStr), kind };
        })() : null;
        const c = parsed ? { createdAt: parsed.createdAt, id: parsed.id } : null;
        const page = limit + 1;
        const events = yield* activityRepo.listByTaskKeyset(taskId, c, page);
        const comments = yield* commentRepo.listByTaskKeyset(taskId, c, page);
        const merged = ([] as ({ at: string; id: number; kind: "event" | "comment"; item: ActivityItem })[])
          .concat(
            events.map((e) => ({ at: e.createdAt, id: e.id, kind: "event" as const, item: { kind: "event", ...e } })),
            comments.map((cm) => ({ at: cm.createdAt, id: cm.id, kind: "comment" as const, item: { kind: "comment", ...cm } }))
          )
          .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : y.id - x.id));
        const hasMore = merged.length > limit;
        const slice = merged.slice(0, limit);
        const items = slice.map((s) => s.item).reverse(); // ascending oldest→newest
        const last = slice[slice.length - 1];
        const nextCursor = hasMore && last
          ? `${last.at}|${last.id}|${last.kind}`
          : null;
        return { items, nextCursor };
      });

    return { append, listMerged };
  }),
}) {}
