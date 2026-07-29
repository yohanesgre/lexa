import { Effect } from "effect";
import { WikiService } from "../../services/wiki.service";
import { resolveProject } from "../resolve";
import { markdownToDoc } from "../../../shared/markdown";

export const tool = {
  name: "update_wiki_page",
  description: "Update a wiki page. content is Markdown. Returns PageMeta.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      pageSlug: { type: "string", description: "Page slug to update" },
      title: { type: "string", description: "New title" },
      content: { type: "string", description: "New content in Markdown" },
    },
    required: ["project", "pageSlug"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const wikiService = yield* WikiService;
      const current = yield* wikiService.findBySlug(project.id, args.pageSlug);

      const updateInput: Record<string, unknown> = {};
      if (args.title !== undefined) updateInput.title = args.title;
      if (args.content !== undefined) {
        const doc = markdownToDoc(args.content);
        updateInput.content = JSON.stringify(doc);
        updateInput.contentText = args.content;
      }

      const page = yield* wikiService.update(current.id, updateInput as any, "manual");

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
