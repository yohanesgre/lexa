import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpServerResponse } from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { d1Live } from "../db/d1";
import { WikiPageNotFound, errorResponse, errorToStatus } from "./errors";
import { clampLimit, nextCursor } from "../../shared/pagination";
import { ProjectService } from "../services/project.service";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnService } from "../services/column.service";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneService } from "../services/swimlane.service";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { TaskService } from "../services/task.service";
import { TaskRepo } from "../repos/task.repo";
import { WikiService } from "../services/wiki.service";
import { WikiRepo } from "../repos/wiki.repo";
import { extractText } from "../../shared/tiptap-text";

const healthEndpoint = HttpApiEndpoint.get("health", "/health").addSuccess(
  Schema.Struct({ ok: Schema.Boolean })
);

const healthGroup = HttpApiGroup.make("health").add(healthEndpoint);

const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  description: Schema.String,
  githubRepo: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ProjectListResponse = Schema.Struct({
  data: Schema.Array(ProjectSchema),
  nextCursor: Schema.NullOr(Schema.String),
});

const CreateProjectPayload = Schema.Struct({
  name: Schema.String,
  slug: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  githubRepo: Schema.optional(Schema.NullOr(Schema.String)),
});

const SlugPath = Schema.Struct({ slug: Schema.String });

const listEndpoint = HttpApiEndpoint.get("list", "/projects").addSuccess(ProjectListResponse, { status: 200 });

const createEndpoint = HttpApiEndpoint.post("create", "/projects")
  .setPayload(CreateProjectPayload)
  .addSuccess(ProjectSchema, { status: 201 });

const getBySlugEndpoint = HttpApiEndpoint.get("getBySlug", "/projects/:slug")
  .setPath(SlugPath)
  .addSuccess(ProjectSchema, { status: 200 });

const projectsGroup = HttpApiGroup.make("projects")
  .add(listEndpoint)
  .add(createEndpoint)
  .add(getBySlugEndpoint);

const ColumnSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  position: Schema.Number,
  color: Schema.String,
  wipLimit: Schema.NullOr(Schema.Number),
  requiredFields: Schema.Array(Schema.String),
  githubState: Schema.NullOr(Schema.Literal("open", "closed")),
});

const ColumnDataResponse = Schema.Struct({ data: Schema.Array(ColumnSchema) });

const ColumnPayload = Schema.Struct({
  name: Schema.String,
  position: Schema.optional(Schema.Number),
  color: Schema.optional(Schema.String),
  wipLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  requiredFields: Schema.optional(Schema.Array(Schema.String)),
  githubState: Schema.optional(Schema.NullOr(Schema.Literal("open", "closed"))),
});

const ColumnUpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  color: Schema.optional(Schema.String),
  wipLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  requiredFields: Schema.optional(Schema.Array(Schema.String)),
  githubState: Schema.optional(Schema.NullOr(Schema.Literal("open", "closed"))),
});

const ColumnPath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const columnsGroup = HttpApiGroup.make("columns")
  .add(HttpApiEndpoint.get("listColumns", "/projects/:slug/columns")
    .setPath(SlugPath).addSuccess(ColumnDataResponse))
  .add(HttpApiEndpoint.post("createColumn", "/projects/:slug/columns")
    .setPath(SlugPath).setPayload(ColumnPayload).addSuccess(ColumnSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateColumn", "/projects/:slug/columns/:id")
    .setPath(ColumnPath).setPayload(ColumnUpdatePayload).addSuccess(ColumnSchema))
  .add(HttpApiEndpoint.del("deleteColumn", "/projects/:slug/columns/:id")
    .setPath(ColumnPath)  .addSuccess(Schema.Undefined, { status: 204 }));

const SwimlaneSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  position: Schema.Number,
});

const SwimlaneDataResponse = Schema.Struct({ data: Schema.Array(SwimlaneSchema) });

const SwimlanePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
});

const SwimlanePath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const WikiPageSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  content: Schema.Any,
  contentText: Schema.optional(Schema.String),
  parentId: Schema.NullOr(Schema.String),
  position: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const WikiPageMetaSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  position: Schema.Number,
  hasChildren: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const WikiPageCreatePayload = Schema.Struct({
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.String,
  slug: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Any),
});

const WikiPageUpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Any),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  position: Schema.optional(Schema.Number),
  saveType: Schema.optional(Schema.Literal("autosave", "manual")),
});

const WikiPageListResponse = Schema.Struct({ data: Schema.Array(WikiPageMetaSchema) });

const WikiPageChildrenResponse = Schema.Struct({ data: Schema.Array(WikiPageMetaSchema) });

const WikiSearchItemSchema = Schema.extend(WikiPageSchema, Schema.Struct({ snippet: Schema.String }));

const WikiSearchResponse = Schema.Struct({ data: Schema.Array(WikiSearchItemSchema) });

const PagePath = Schema.Struct({ slug: Schema.String, pageSlug: Schema.String });

const RevisionPath = Schema.Struct({ slug: Schema.String, pageSlug: Schema.String, revisionId: Schema.String });

const WikiPageRevisionSummarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  saveType: Schema.Literal("autosave", "manual"),
  createdAt: Schema.String,
});

const WikiPageRevisionSchema = Schema.Struct({
  id: Schema.String,
  pageId: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  content: Schema.Any,
  contentText: Schema.String,
  saveType: Schema.Literal("autosave", "manual"),
  createdAt: Schema.String,
});

const RevisionsListResponse = Schema.Struct({ revisions: Schema.Array(WikiPageRevisionSummarySchema) });

const RevisionResponse = Schema.Struct({ revision: WikiPageRevisionSchema });

const RestorePayload = Schema.Struct({ revisionId: Schema.String });

const swimlanesGroup = HttpApiGroup.make("swimlanes")
  .add(HttpApiEndpoint.get("listSwimlanes", "/projects/:slug/swimlanes")
    .setPath(SlugPath).addSuccess(SwimlaneDataResponse))
  .add(HttpApiEndpoint.post("createSwimlane", "/projects/:slug/swimlanes")
    .setPath(SlugPath).setPayload(SwimlanePayload).addSuccess(SwimlaneSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateSwimlane", "/projects/:slug/swimlanes/:id")
    .setPath(SwimlanePath).setPayload(SwimlanePayload).addSuccess(SwimlaneSchema))
  .add(HttpApiEndpoint.del("deleteSwimlane", "/projects/:slug/swimlanes/:id")
    .setPath(SwimlanePath)  .addSuccess(Schema.Undefined, { status: 204 }));

const TaskSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  columnId: Schema.String,
  swimlaneId: Schema.NullOr(Schema.String),
  title: Schema.String,
  description: Schema.Any,
  priority: Schema.Literal("urgent", "high", "medium", "low"),
  type: Schema.Literal("feature", "bug", "task", "asset"),
  assignee: Schema.NullOr(Schema.String),
  position: Schema.String,
  github: Schema.NullOr(Schema.Struct({
    issueId: Schema.String,
    issueNumber: Schema.Number,
    repo: Schema.String,
    url: Schema.String,
    syncedState: Schema.NullOr(Schema.Literal("open", "closed")),
    outOfSync: Schema.Boolean,
  })),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const TaskListResponse = Schema.Struct({
  data: Schema.Array(TaskSchema),
  nextCursor: Schema.NullOr(Schema.String),
});

const CreateTaskPayload = Schema.Struct({
  columnId: Schema.String,
  swimlaneId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.String,
  description: Schema.optional(Schema.Any),
  priority: Schema.optional(Schema.Literal("urgent", "high", "medium", "low")),
  type: Schema.optional(Schema.Literal("feature", "bug", "task", "asset")),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
});

const UpdateTaskPayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.Any),
  priority: Schema.optional(Schema.Literal("urgent", "high", "medium", "low")),
  type: Schema.optional(Schema.Literal("feature", "bug", "task", "asset")),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
});

const MoveTaskPayload = Schema.Struct({
  columnId: Schema.String,
  swimlaneId: Schema.optional(Schema.NullOr(Schema.String)),
  beforeTaskId: Schema.optional(Schema.String),
  afterTaskId: Schema.optional(Schema.String),
});

const TaskPath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const BoardSchema = Schema.Struct({
  project: ProjectSchema,
  columns: Schema.Array(ColumnSchema),
  swimlanes: Schema.Array(SwimlaneSchema),
  tasks: Schema.Array(TaskSchema),
});

const tasksGroup = HttpApiGroup.make("tasks")
  .add(HttpApiEndpoint.get("listTasks", "/projects/:slug/tasks")
    .setPath(SlugPath).addSuccess(TaskListResponse))
  .add(HttpApiEndpoint.post("createTask", "/projects/:slug/tasks")
    .setPath(SlugPath).setPayload(CreateTaskPayload).addSuccess(TaskSchema, { status: 201 }))
  .add(HttpApiEndpoint.get("getTask", "/projects/:slug/tasks/:id")
    .setPath(TaskPath).addSuccess(TaskSchema))
  .add(HttpApiEndpoint.patch("updateTask", "/projects/:slug/tasks/:id")
    .setPath(TaskPath).setPayload(UpdateTaskPayload).addSuccess(TaskSchema))
  .add(HttpApiEndpoint.post("moveTask", "/projects/:slug/tasks/:id/move")
    .setPath(TaskPath).setPayload(MoveTaskPayload).addSuccess(TaskSchema))
  .add(HttpApiEndpoint.del("deleteTask", "/projects/:slug/tasks/:id")
    .setPath(TaskPath)  .addSuccess(Schema.Undefined, { status: 204 }));

const boardGroup = HttpApiGroup.make("board")
  .add(HttpApiEndpoint.get("getBoard", "/projects/:slug/board")
    .setPath(SlugPath).addSuccess(BoardSchema));

const wikiGroup = HttpApiGroup.make("wiki")
  .add(HttpApiEndpoint.get("listPages", "/projects/:slug/wiki")
    .setPath(SlugPath).addSuccess(WikiPageListResponse))
  .add(HttpApiEndpoint.post("createPage", "/projects/:slug/wiki")
    .setPath(SlugPath).setPayload(WikiPageCreatePayload).addSuccess(WikiPageSchema, { status: 201 }))
  .add(HttpApiEndpoint.get("searchPages", "/projects/:slug/wiki/search")
    .setPath(SlugPath).addSuccess(WikiSearchResponse))
  .add(HttpApiEndpoint.get("getPage", "/projects/:slug/wiki/:pageSlug")
    .setPath(PagePath).addSuccess(WikiPageSchema))
  .add(HttpApiEndpoint.get("listChildren", "/projects/:slug/wiki/:pageSlug/children")
    .setPath(PagePath).addSuccess(WikiPageChildrenResponse))
  .add(HttpApiEndpoint.patch("updatePage", "/projects/:slug/wiki/:pageSlug")
    .setPath(PagePath).setPayload(WikiPageUpdatePayload).addSuccess(WikiPageSchema))
  .add(HttpApiEndpoint.del("deletePage", "/projects/:slug/wiki/:pageSlug")
    .setPath(PagePath).addSuccess(Schema.Undefined, { status: 204 }))
  .add(HttpApiEndpoint.get("listRevisions", "/projects/:slug/wiki/:pageSlug/revisions")
    .setPath(PagePath).addSuccess(RevisionsListResponse))
  .add(HttpApiEndpoint.get("getRevision", "/projects/:slug/wiki/:pageSlug/revisions/:revisionId")
    .setPath(RevisionPath).addSuccess(RevisionResponse))
  .add(HttpApiEndpoint.post("restoreRevision", "/projects/:slug/wiki/:pageSlug/restore")
    .setPath(PagePath).setPayload(RestorePayload).addSuccess(WikiPageSchema));

export const LexaApi = HttpApi.make("lexa")
  .add(healthGroup)
  .add(projectsGroup)
  .add(columnsGroup)
  .add(swimlanesGroup)
  .add(tasksGroup)
  .add(boardGroup)
  .add(wikiGroup)
  .prefix("/api");

const apiLayer = HttpApiBuilder.api(LexaApi);

const respond = <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  eff.pipe(
    Effect.catchAll((e) =>
      Effect.succeed(
        HttpServerResponse.unsafeJson(errorResponse(e as { _tag: string } & Record<string, unknown>), {
          status: errorToStatus(e as { _tag: string }),
        })
      )
    )
  );

const healthLive = HttpApiBuilder.group(LexaApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ ok: true as const }))
);

const projectsLive = HttpApiBuilder.group(LexaApi, "projects", (handlers) =>
  handlers
    .handle("list", () =>
      respond(Effect.gen(function* () {
        const service = yield* ProjectService;
        const projects = yield* service.list();
        return { data: projects.map(formatProject), nextCursor: null };
      }))
    )
    .handle("create", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ProjectService;
        const project = yield* service.create({
          name: req.payload.name, slug: req.payload.slug,
          description: req.payload.description, githubRepo: req.payload.githubRepo,
        });
        return formatProject(project);
      }))
    )
    .handle("getBySlug", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ProjectService;
        const project = yield* service.findBySlug(req.path.slug);
        return formatProject(project);
      }))
    )
);

const columnsLive = HttpApiBuilder.group(LexaApi, "columns", (handlers) =>
  handlers
    .handle("listColumns", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const columnService = yield* ColumnService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const columns = yield* columnService.findByProject(project.id);
        return { data: columns.map(formatColumn) };
      }))
    )
    .handle("createColumn", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const columnService = yield* ColumnService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const column = yield* columnService.create({
          projectId: project.id, name: req.payload.name,
          color: req.payload.color,
          wipLimit: req.payload.wipLimit, requiredFields: req.payload.requiredFields as string[] | undefined,
          githubState: req.payload.githubState,
        });
        return formatColumn(column);
      }))
    )
    .handle("updateColumn", (req) =>
      respond(Effect.gen(function* () {
        const columnService = yield* ColumnService;
        const column = yield* columnService.update(req.path.id, {
          name: req.payload.name, position: req.payload.position,
          color: req.payload.color, wipLimit: req.payload.wipLimit,
          requiredFields: req.payload.requiredFields as string[] | undefined,
          githubState: req.payload.githubState,
        });
        return formatColumn(column);
      }))
    )
    .handle("deleteColumn", (req) =>
      respond(Effect.gen(function* () {
        const columnService = yield* ColumnService;
        yield* columnService.delete(req.path.id);
        return undefined;
      }))
    )
);

const swimlanesLive = HttpApiBuilder.group(LexaApi, "swimlanes", (handlers) =>
  handlers
    .handle("listSwimlanes", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const swimlaneService = yield* SwimlaneService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const swimlanes = yield* swimlaneService.findByProject(project.id);
        return { data: swimlanes.map(formatSwimlane) };
      }))
    )
    .handle("createSwimlane", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const swimlaneService = yield* SwimlaneService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const swimlane = yield* swimlaneService.create({
          projectId: project.id, name: req.payload.name, description: req.payload.description,
        });
        return formatSwimlane(swimlane);
      }))
    )
    .handle("updateSwimlane", (req) =>
      respond(Effect.gen(function* () {
        const swimlaneService = yield* SwimlaneService;
        const swimlane = yield* swimlaneService.update(req.path.id, {
          name: req.payload.name, description: req.payload.description, position: req.payload.position,
        });
        return formatSwimlane(swimlane);
      }))
    )
    .handle("deleteSwimlane", (req) =>
      respond(Effect.gen(function* () {
        const swimlaneService = yield* SwimlaneService;
        yield* swimlaneService.delete(req.path.id);
        return undefined;
      }))
    )
);

const tasksLive = HttpApiBuilder.group(LexaApi, "tasks", (handlers) =>
  handlers
    .handle("listTasks", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const taskService = yield* TaskService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const q = new URL(req.request.url).searchParams;
        const limit = clampLimit(q.get("limit"));
        const cursor = q.get("cursor") ?? undefined;
        const filters = {
          columnId: q.get("columnId") ?? undefined,
          swimlaneId: q.get("swimlaneId") ?? undefined,
          assignee: q.get("assignee") ?? undefined,
          type: (q.get("type") ?? undefined) as "feature" | "bug" | "task" | "asset" | undefined,
        };
        const result = yield* taskService.findByProject(project.id, filters, limit, cursor);
        return {
          data: result.tasks.map(formatTask),
          nextCursor: result.hasMore ? nextCursor(result.tasks, limit) : null,
        };
      }))
    )
    .handle("createTask", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const taskService = yield* TaskService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const task = yield* taskService.create({
          projectId: project.id, columnId: req.payload.columnId,
          swimlaneId: req.payload.swimlaneId, title: req.payload.title,
          description: req.payload.description, priority: req.payload.priority,
          type: req.payload.type, assignee: req.payload.assignee,
        });
        return formatTask(task);
      }))
    )
    .handle("getTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const task = yield* taskService.getById(req.path.id);
        return formatTask(task);
      }))
    )
    .handle("updateTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const task = yield* taskService.update(req.path.id, {
          title: req.payload.title, description: req.payload.description,
          priority: req.payload.priority, type: req.payload.type,
          assignee: req.payload.assignee,
        });
        return formatTask(task);
      }))
    )
    .handle("moveTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const task = yield* taskService.move(req.path.id, {
          columnId: req.payload.columnId, swimlaneId: req.payload.swimlaneId,
          beforeTaskId: req.payload.beforeTaskId, afterTaskId: req.payload.afterTaskId,
        });
        return formatTask(task);
      }))
    )
    .handle("deleteTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        yield* taskService.delete(req.path.id);
        return undefined;
      }))
    )
);

const boardLive = HttpApiBuilder.group(LexaApi, "board", (handlers) =>
  handlers.handle("getBoard", (req) =>
    respond(Effect.gen(function* () {
      const projectService = yield* ProjectService;
      const columnService = yield* ColumnService;
      const swimlaneService = yield* SwimlaneService;
      const taskService = yield* TaskService;
      const project = yield* projectService.findBySlug(req.path.slug);
      const columns = yield* columnService.findByProject(project.id);
      const swimlanes = yield* swimlaneService.findByProject(project.id);
      const tasks = yield* taskService.findAllByProject(project.id);
      return {
        project: formatProject(project),
        columns: columns.map(formatColumn),
        swimlanes: swimlanes.map(formatSwimlane),
        tasks: tasks.map(formatTask),
      };
    }))
  )
);

const wikiLive = HttpApiBuilder.group(LexaApi, "wiki", (handlers) =>
  handlers
    .handle("listPages", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const pages = yield* wikiService.findByProject(project.id);
        const parentIds = new Set(pages.map((p) => p.parentId).filter((id): id is string => id !== null));
        return { data: pages.map((p) => formatWikiPageMeta(p, parentIds)) };
      }))
    )
    .handle("createPage", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const contentText = req.payload.content ? extractText(req.payload.content) : undefined;
        const page = yield* wikiService.create(project.id, {
          title: req.payload.title,
          slug: req.payload.slug,
          content: req.payload.content,
          contentText,
          parentId: req.payload.parentId ?? undefined,
        });
        return formatWikiPage(page);
      }))
    )
    .handle("searchPages", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const q = new URL(req.request.url).searchParams.get("q");
        if (!q) return { data: [] as any[] };
        const results = yield* wikiService.search(project.id, q);
        return { data: results.map(formatWikiPage) };
      }))
    )
    .handle("getPage", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const page = yield* wikiService.findBySlug(project.id, req.path.pageSlug);
        return formatWikiPage(page);
      }))
    )
    .handle("listChildren", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const page = yield* wikiService.findBySlug(project.id, req.path.pageSlug);
        const children = yield* wikiService.findChildren(project.id, page.id);
        const allPages = yield* wikiService.findByProject(project.id);
        const parentIds = new Set(allPages.map((p) => p.parentId).filter((id): id is string => id !== null));
        return { data: children.map((p) => formatWikiPageMeta(p, parentIds)) };
      }))
    )
    .handle("updatePage", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const page = yield* wikiService.findBySlug(project.id, req.path.pageSlug);
        const updateInput: Record<string, unknown> = {};
        if (req.payload.title !== undefined) updateInput.title = req.payload.title;
        if (req.payload.slug !== undefined) updateInput.slug = req.payload.slug;
        if (req.payload.parentId !== undefined) updateInput.parentId = req.payload.parentId;
        if (req.payload.position !== undefined) updateInput.position = req.payload.position;
        if (req.payload.content !== undefined) {
          updateInput.content = JSON.stringify(req.payload.content);
          updateInput.contentText = extractText(req.payload.content);
        }
        const saveType = req.payload.saveType ?? "autosave";
        const updated = yield* wikiService.update(page.id, updateInput as any, saveType);
        return formatWikiPage(updated);
      }))
    )
    .handle("deletePage", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const page = yield* wikiService.findBySlug(project.id, req.path.pageSlug);
        yield* wikiService.delete(page.id);
        return undefined;
      }))
    )
    .handle("listRevisions", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const q = new URL(req.request.url).searchParams;
        const limit = q.get("limit") ? parseInt(q.get("limit")!, 10) : undefined;
        const revisions = yield* wikiService.listRevisions(req.path.pageSlug, project.id, limit);
        return { revisions: revisions.map(formatWikiPageRevisionSummary) };
      }))
    )
    .handle("getRevision", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const page = yield* wikiService.findBySlug(project.id, req.path.pageSlug);
        const revision = yield* wikiService.getRevision(req.path.revisionId);
        if (revision.pageId !== page.id) {
          return yield* new WikiPageNotFound({ id: req.path.revisionId });
        }
        return { revision: formatWikiPageRevision(revision) };
      }))
    )
    .handle("restoreRevision", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const wikiService = yield* WikiService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const page = yield* wikiService.restoreRevision(req.payload.revisionId, req.path.pageSlug, project.id);
        return formatWikiPage(page);
      }))
    )
);

function formatProject(p: { id: string; name: string; slug: string; description: string; githubRepo: string | null; createdAt: string; updatedAt: string }) {
  return p as any;
}

function formatColumn(c: { id: string; projectId: string; name: string; position: number; color: string; wipLimit: number | null; requiredFields: string[]; githubState: "open" | "closed" | null }) {
  return c as any;
}

function formatSwimlane(s: { id: string; projectId: string; name: string; description: string; position: number }) {
  return s as any;
}

function formatTask(t: { id: string; projectId: string; columnId: string; swimlaneId: string | null; title: string; description: any; priority: string; type: string; assignee: string | null; position: string; github: any; createdAt: string; updatedAt: string }) {
  return t as any;
}

function formatWikiPage(page: { id: string; projectId: string; title: string; slug: string; content: any; parentId: string | null; position: number; createdAt: string; updatedAt: string }) {
  return page as any;
}

function formatWikiPageMeta(
  meta: { id: string; projectId: string; title: string; slug: string; parentId: string | null; position: number; updatedAt: string },
  parentIds: Set<string>
) {
  const hasChildren = parentIds.has(meta.id);
  return { ...meta, hasChildren, createdAt: "" } as any;
}

function formatWikiPageRevisionSummary(r: { id: string; title: string; saveType: string; createdAt: string }) {
  return r as any;
}

function formatWikiPageRevision(r: { id: string; pageId: string; title: string; slug: string; content: any; contentText: string; saveType: string; createdAt: string }) {
  return r as any;
}

export function createApiHandler() {
  const serviceLayer = Layer.mergeAll(
    ProjectRepo.Default, ProjectService.Default,
    ColumnRepo.Default, ColumnService.Default,
    SwimlaneRepo.Default, SwimlaneService.Default,
    TaskRepo.Default, TaskService.Default,
    WikiRepo.Default, WikiService.Default,
  );
  const handlerLayer = Layer.mergeAll(
    healthLive, projectsLive, columnsLive, swimlanesLive, tasksLive, boardLive, wikiLive,
  ).pipe(Layer.provide(serviceLayer), Layer.provide(d1Live));
  const merged = Layer.mergeAll(apiLayer, handlerLayer);
  return HttpApiBuilder.toWebHandler(merged as unknown as Parameters<typeof HttpApiBuilder.toWebHandler>[0]);
}
