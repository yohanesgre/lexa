import { Effect } from "effect";
import { WikiService } from "../../services/wiki.service";
import { WikiPageNotFound } from "../../api/errors";
import { resolveProject } from "../resolve";
import { docToMarkdown } from "../../../shared/markdown";

export const tool = {
  name: "get_wiki_page",
  description: "Get a wiki page by project slug and page slug. content is Markdown.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      pageSlug: { type: "string", description: "Page slug" },
    },
    required: ["project", "pageSlug"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const wikiService = yield* WikiService;
      const page = yield* wikiService.findBySlug(project.id, args.pageSlug).pipe(
        Effect.catchTag("WikiPageNotFound", () =>
          Effect.gen(function* () {
            const siblings = yield* wikiService.findByProject(project.id);
            return yield* new WikiPageNotFound({
              id: args.pageSlug,
              availablePageSlugs: siblings.map((p) => p.slug),
            } as any);
          })
        )
      );

      let parentSlug: string | null = null;
      if (page.parentId) {
        const parentResult = yield* wikiService.getById(page.parentId).pipe(
          Effect.catchTag("WikiPageNotFound", () => Effect.succeed(null))
        );
        parentSlug = parentResult?.slug ?? null;
      }

      return {
        title: page.title,
        slug: page.slug,
        content: docToMarkdown(page.content),
        parentSlug,
        updatedAt: page.updatedAt,
      };
    }),
};
