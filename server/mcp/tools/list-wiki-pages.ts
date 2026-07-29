import { Effect } from "effect";
import { WikiService } from "../../services/wiki.service";
import { resolveProject } from "../resolve";

export const tool = {
  name: "list_wiki_pages",
  description: "List all wiki pages in a project. Returns PageMeta (title, slug, parentSlug, updatedAt).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      limit: { type: "number", description: "Max results per page (default 50, max 200)" },
      cursor: { type: "string", description: "Pagination cursor from previous response" },
    },
    required: ["project"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const wikiService = yield* WikiService;
      const allPages = yield* wikiService.findByProject(project.id);

      const slugMap = new Map(allPages.map((p) => [p.id, p.slug]));

      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);

      let offset = 0;
      if (args.cursor) {
        try {
          const decoded = JSON.parse(atob(args.cursor));
          if (typeof decoded.offset === "number") {
            offset = decoded.offset;
          }
        } catch {}
      }

      const slice = allPages.slice(offset, offset + limit);
      const hasMore = offset + limit < allPages.length;

      const pages = slice.map((p) => ({
        title: p.title,
        slug: p.slug,
        parentSlug: p.parentId ? slugMap.get(p.parentId) ?? null : null,
        updatedAt: p.updatedAt,
      }));

      let nextCursor: string | null = null;
      if (hasMore) {
        nextCursor = btoa(JSON.stringify({ offset: offset + limit }));
      }

      return { pages, nextCursor };
    }),
};
