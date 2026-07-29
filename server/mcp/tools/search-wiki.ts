import { Effect } from "effect";
import { WikiService } from "../../services/wiki.service";
import { resolveProject } from "../resolve";

export const tool = {
  name: "search_wiki",
  description: "Full-text search wiki pages. Returns matching pages with snippet (Markdown-safe **bold** around hits).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      query: { type: "string", description: "Search query (FTS5)" },
      limit: { type: "number", description: "Max results (default 10, max 50)" },
    },
    required: ["project", "query"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const wikiService = yield* WikiService;
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      const results = yield* wikiService.search(project.id, args.query, limit);

      return {
        results: results.map((r) => ({
          title: r.title,
          slug: r.slug,
          snippet: r.snippet,
        })),
      };
    }),
};
