import { Effect } from "effect";
import { SourceRepo } from "../repos/source.repo";
import { ProjectRepo } from "../repos/project.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ProjectNotFound, WikiPageNotFound, SourceNotFound, SourceFetchError, SourceUnreachable } from "../api/errors";
import { extractText } from "../../shared/tiptap-text";
import { isPrivateIp, isPublicUrl } from "../forge-ssrf";
import type { DocumentSource, TipTapDoc } from "../../shared/types";

export class SourceService extends Effect.Service<SourceService>()("Lexa/SourceService", {
  dependencies: [SourceRepo.Default, ProjectRepo.Default, WikiRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* SourceRepo;
    const projectRepo = yield* ProjectRepo;
    const wikiRepo = yield* WikiRepo;

    const resolveAddresses = (hostname: string): Effect.Effect<string[], never> =>
      Effect.gen(function* () {
        try {
          const res = yield* Effect.promise(() =>
            fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`).then((r) => r.json() as Promise<{ Answer?: { data: string }[] }>)
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
        yield* assertPublicUrl(url);
        const res = yield* Effect.promise(() =>
          fetch(url, {
            headers: { "User-Agent": "Lexa-Forge/0.1" },
            redirect: "follow",
            signal: AbortSignal.timeout(10_000),
          })
        ).pipe(
          Effect.catchAll(() => Effect.fail(new SourceUnreachable({ url })))
        );
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
      add: (input: {
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        kind: "wiki" | "external";
        ref: string;
      }): Effect.Effect<DocumentSource, ProjectNotFound | WikiPageNotFound | SourceFetchError | SourceUnreachable | ConstraintViolation | DbError | RowNotFound> =>
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
          return yield* repo.create({
            id: crypto.randomUUID(),
            projectId: input.projectId,
            documentType: input.documentType,
            documentId: input.documentId,
            kind: input.kind,
            title,
            ref: input.ref,
          }).pipe(
            Effect.catchTag("ConstraintViolation", (e) => new DbError({ message: e.message, cause: e }))
          );
        }),

      remove: (id: string): Effect.Effect<void, SourceNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const n = yield* repo.delete(id);
          if (n === 0) return yield* new SourceNotFound({ id });
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
