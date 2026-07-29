import { Effect } from "effect";
import { WikiService } from "../../services/wiki.service";
import { resolveProject } from "../resolve";
import { markdownToDoc } from "../../../shared/markdown";

export const tool = {
  name: "create_wiki_page",
  description: "Create a wiki page. content is Markdown. parentSlug nests under that page. Slug auto-generated from title if omitted.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      title: { type: "string", description: "Page title" },
      content: { type: "string", description: "Page content in Markdown" },
      parentSlug: { type: "string", description: "Slug of parent page (optional)" },
    },
    required: ["project", "title"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const wikiService = yield* WikiService;

      let parentId: string | undefined;
      if (args.parentSlug) {
        const parent = yield* wikiService.findBySlug(project.id, args.parentSlug);
        parentId = parent.id;
      }

      const contentDoc = args.content ? markdownToDoc(args.content) : undefined;
      const page = yield* wikiService.create(project.id, {
        title: args.title,
        content: contentDoc as any,
        contentText: args.content ?? undefined,
        parentId,
      });

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
        parentSlug,
        updatedAt: page.updatedAt,
      };
    }),
};
