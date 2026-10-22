import { Effect } from "effect";
import { DbError, type DbDriver } from "./driver";

type FormatRow = { value: string };

const OPERATOR_GUIDANCE =
  "Markdown document access is disabled until an operator audits and applies the upgrade with scripts/migrate-markdown.ts.";

export function assertMarkdownReady(db: DbDriver): Effect.Effect<void, DbError> {
  return Effect.tryPromise({
    try: () => db.prepare("SELECT value FROM settings WHERE key = ?").first<FormatRow>("documents.format"),
    catch: (cause) => new DbError({ message: `${OPERATOR_GUIDANCE} Could not read documents.format.`, cause }),
  }).pipe(
    Effect.flatMap((row) => row?.value === "markdown-v1"
      ? Effect.void
      : Effect.fail(new DbError({
        message: `${OPERATOR_GUIDANCE} Current format: ${row?.value ?? "uninitialized"}.`,
      }))
    )
  );
}
