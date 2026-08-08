import { Effect } from "effect";
import { SourceRepo } from "../repos/source.repo";
import { ProjectRepo } from "../repos/project.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { DbError, RowNotFound, ConstraintViolation, Sqlite, withTx } from "../db/database";
import { ProjectNotFound, WikiPageNotFound, SourceNotFound, SourceFetchError, SourceUnreachable } from "../api/errors";
import { ActivityService } from "./activity.service";
import * as msg from "../activity-messages";
import { extractText } from "../../shared/tiptap-text";
import { isPrivateIp, isPublicUrl } from "../forge-ssrf";
import type { DocumentSource, TipTapDoc, Actor, ActivityEvent } from "../../shared/types";

export class SourceService extends Effect.Service<SourceService>()("Lexa/SourceService", {
  dependencies: [SourceRepo.Default, ProjectRepo.Default, WikiRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const repo = yield* SourceRepo;
    const projectRepo = yield* ProjectRepo;
    const wikiRepo = yield* WikiRepo;
    const activityService = yield* ActivityService;
    const db = yield* Sqlite;

    const resolveAddresses = (hostname: string): Effect.Effect<string[], never> =>
      Effect.gen(function* () {
        try {
          const res = yield* Effect.promise(() =>
            fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`).then(async (r) => {
              if (!r.ok) throw new Error(`dns.google ${r.status}`);
              return r.json() as Promise<{ Answer?: { data: string }[] }>;
            })
          );
          const addresses = (res.Answer ?? []).map((a) => a.data);
          if (addresses.length > 0) return addresses;
        } catch {
          // fall through to node:dns
        }
        const dns = yield* Effect.promise(() => import("node:dns/promises"));
        return yield* Effect.promise(() => dns.lookup(hostname, { all: true }).then((a) => a.map((x) => x.address)));
      }).pipe(
        Effect.catchAll(() => Effect.succeed([] as string[]))
      );

    // ── SSRF guard ──
    // Resolve DNS and reject any IP that is private, loopback, link-local,
    // or otherwise non-public. Lexa is self-hosted behind a tunnel; without
    // this an admin could point Forge at internal services.
    const assertPublicUrl = (rawUrl: string): Effect.Effect<void, SourceFetchError> =>
      Effect.gen(function* () {
        const check = isPublicUrl(rawUrl);
        if (!check.ok) {
          return yield* new SourceFetchError({ message: check.reason });
        }
        const addresses = yield* resolveAddresses(new URL(rawUrl).hostname);
        if (addresses.length === 0) {
          return yield* new SourceFetchError({ message: `Could not resolve host: ${new URL(rawUrl).hostname}` });
        }
        for (const ip of addresses) {
          if (isPrivateIp(ip)) {
            return yield* new SourceFetchError({ message: `Blocked: ${new URL(rawUrl).hostname} resolves to a private address (${ip})` });
          }
        }
      });

    const fetchText = (url: string): Effect.Effect<string, SourceFetchError | SourceUnreachable> =>
      Effect.gen(function* () {
        let currentUrl = url;
        yield* assertPublicUrl(currentUrl);
        // redirect: "manual" — every hop is re-validated against the SSRF
        // guard, so a public URL cannot redirect to a private address.
        for (let hops = 0; hops <= 5; hops++) {
          const res = yield* Effect.promise(() =>
            fetch(currentUrl, {
              headers: { "User-Agent": "Lexa-Forge/0.1" },
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            })
          ).pipe(
            Effect.catchAll(() => Effect.fail(new SourceUnreachable({ url })))
          );
          if (res.status >= 300 && res.status < 400) {
            if (hops === 5) {
              return yield* new SourceFetchError({ message: `Too many redirects fetching ${url}` });
            }
            const location = res.headers.get("location");
            if (!location) {
              return yield* new SourceFetchError({ message: `Redirect without Location fetching ${currentUrl}` });
            }
            currentUrl = new URL(location, currentUrl).toString();
            yield* assertPublicUrl(currentUrl);
            continue;
          }
          if (!res.ok) {
            return yield* new SourceFetchError({ message: `HTTP ${res.status} fetching ${url}` });
          }
          const html = yield* Effect.promise(() => res.text()).pipe(
            Effect.catchAll(() => Effect.fail(new SourceUnreachable({ url })))
          );
          const text = htmlToText(html);
          if (!text.trim()) {
            return yield* new SourceFetchError({ message: `No readable text at ${url}` });
          }
          return text;
        }
        return yield* new SourceFetchError({ message: `Too many redirects fetching ${url}` });
      });

    const htmlToText = (html: string): string =>
      html
        // Strip scripts/styles
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        // Block elements → newlines
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
        // Remaining tags → nothing
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 20_000);

    return {
      findByDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<DocumentSource[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          return yield* repo.findByDocument(projectId, documentType, documentId);
        }),

      // Add a source. For wiki kind, `ref` is a wiki page slug — validate it
      // exists in the project and store its title. For external, `ref` is a URL.
      // Task timelines get a source_added row in the same transaction.
      add: (actor: Actor, input: {
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        kind: "wiki" | "external";
        ref: string;
      }): Effect.Effect<{ source: DocumentSource; activity: ActivityEvent[] }, ProjectNotFound | WikiPageNotFound | SourceFetchError | SourceUnreachable | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          let title = input.ref;
          if (input.kind === "wiki") {
            const page = yield* wikiRepo.findBySlug(input.projectId, input.ref).pipe(
              Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: input.ref }))
            );
            title = page.title;
          } else {
            yield* assertPublicUrl(input.ref);
          }
          return yield* withTx(db, Effect.gen(function* () {
            const source = yield* repo.create({
              id: crypto.randomUUID(),
              projectId: input.projectId,
              documentType: input.documentType,
              documentId: input.documentId,
              kind: input.kind,
              title,
              ref: input.ref,
            });
            let activity: ActivityEvent[] = [];
            if (input.documentType === "task") {
              const ev = yield* activityService.append(input.documentId, actor, "source_added",
                msg.sourceAdded(title, input.kind === "wiki" ? "wiki" : "url"));
              activity = [ev];
            }
            return { source, activity };
          }));
        }),

      remove: (actor: Actor, id: string): Effect.Effect<{ activity: ActivityEvent[] }, SourceNotFound | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const source = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new SourceNotFound({ id }))
          );
          if (source.documentType !== "task") {
            const n = yield* repo.delete(id);
            if (n === 0) return yield* new SourceNotFound({ id });
            return { activity: [] as ActivityEvent[] };
          }
          return yield* withTx(db, Effect.gen(function* () {
            const n = yield* repo.delete(id);
            if (n === 0) return yield* new SourceNotFound({ id });
            const ev = yield* activityService.append(source.documentId, actor, "source_removed", msg.sourceRemoved(source.title));
            return { activity: [ev] };
          }));
        }),

      // Resolve a source's content as plain text (used by the Forge prompt).
      resolveContent: (projectId: string, source: DocumentSource): Effect.Effect<string, DbError | RowNotFound | WikiPageNotFound | SourceFetchError | SourceUnreachable> =>
        Effect.gen(function* () {
          if (source.kind === "wiki") {
            const page = yield* wikiRepo.findBySlug(projectId, source.ref).pipe(
              Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: source.ref }))
            );
            return extractText(page.content as TipTapDoc) || page.title;
          }
          return yield* fetchText(source.ref);
        }),
    };
  }),
}) {}
