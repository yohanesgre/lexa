import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpMiddleware, HttpServerResponse } from "@effect/platform";
import { Cause, Effect, Layer, Schema } from "effect";
import { LoggerLayer } from "../logging/logger";
import { Sqlite } from "../db/database";
import { Database } from "bun:sqlite";
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
import { ApiKeyService } from "../services/api-key.service";
import { ApiKeyRepo } from "../repos/api-key.repo";
import { UserService } from "../services/user.service";
import { UserRepo } from "../repos/user.repo";
import { UserProjectRoleService } from "../services/user-project-role.service";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { DashboardService } from "../services/dashboard.service";
import { extractText } from "../../shared/tiptap-text";

const ApiKeySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});

const CreateApiKeyInput = Schema.Struct({
  name: Schema.String,
});

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

const ProjectMemberSchema = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  role: Schema.Literal("admin", "member"),
});

const ProjectMembersResponse = Schema.Struct({ data: Schema.Array(ProjectMemberSchema) });

const membersEndpoint = HttpApiEndpoint.get("listMembers", "/projects/:slug/members")
  .setPath(SlugPath)
  .addSuccess(ProjectMembersResponse, { status: 200 });

const ProjectUpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  githubRepo: Schema.optional(Schema.NullOr(Schema.String)),
});

const projectsGroup = HttpApiGroup.make("projects")
  .add(listEndpoint)
  .add(createEndpoint)
  .add(getBySlugEndpoint)
  .add(membersEndpoint)
  .add(
    HttpApiEndpoint.patch("updateProject", "/projects/:slug")
      .setPath(SlugPath).setPayload(ProjectUpdatePayload).addSuccess(ProjectSchema)
  )
  .add(
    HttpApiEndpoint.del("deleteProject", "/projects/:slug")
      .setPath(SlugPath)
      .addSuccess(Schema.UndefinedOr(Schema.Void))
  );

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

const GithubIssueSchema = Schema.Struct({
  issueId: Schema.String,
  issueNumber: Schema.Number,
  repo: Schema.String,
  syncedState: Schema.NullOr(Schema.Literal("open", "closed")),
  url: Schema.String,
  outOfSync: Schema.Boolean,
});

const TaskSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  columnId: Schema.String,
  swimlaneId: Schema.NullOr(Schema.String),
  title: Schema.String,
  description: Schema.Any,
  priority: Schema.Literal("urgent", "high", "medium", "low"),
  type: Schema.Literal("feature", "bug", "task", "asset"),
  assignees: Schema.Array(Schema.String),
  position: Schema.String,
  githubs: Schema.Array(GithubIssueSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const TaskListResponse = Schema.Struct({
  data: Schema.Array(TaskSchema),
  nextCursor: Schema.NullOr(Schema.String),
});

const CreateTaskPayload = Schema.Struct({
  columnId: Schema.String,
  swimlaneId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.Any),
  priority: Schema.optional(Schema.Literal("urgent", "high", "medium", "low")),
  type: Schema.optional(Schema.Literal("feature", "bug", "task", "asset")),
  assignees: Schema.optional(Schema.Array(Schema.String)),
});

const UpdateTaskPayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.Any),
  priority: Schema.optional(Schema.Literal("urgent", "high", "medium", "low")),
  type: Schema.optional(Schema.Literal("feature", "bug", "task", "asset")),
  assignees: Schema.optional(Schema.Array(Schema.String)),
});

const MoveTaskPayload = Schema.Struct({
  columnId: Schema.String,
  swimlaneId: Schema.String,
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

const WipSegmentSchema = Schema.Struct({
  state: Schema.Literal("ok", "approaching", "exceeded", "empty"),
  flex: Schema.Number,
});

const ProjectHealthSchema = Schema.Struct({
  project: ProjectSchema,
  taskCount: Schema.Number,
  columnCount: Schema.Number,
  urgentCount: Schema.Number,
  syncCount: Schema.Number,
  health: Schema.Literal("ok", "approaching", "exceeded"),
  wipSegments: Schema.Array(WipSegmentSchema),
});

const DashboardStatsSchema = Schema.Struct({
  totalTasks: Schema.Number,
  activeProjects: Schema.Number,
  wipExceeded: Schema.Number,
  outOfSync: Schema.Number,
});

const UrgentTaskSchema = Schema.Struct({
  id: Schema.String, title: Schema.String,
  projectName: Schema.String, projectSlug: Schema.String,
  columnName: Schema.String, priority: Schema.String,
});

const OutOfSyncTaskSchema = Schema.Struct({
  id: Schema.String, title: Schema.String,
  projectName: Schema.String, projectSlug: Schema.String,
  repo: Schema.String, issueNumber: Schema.Number,
});

const DashboardSchema = Schema.Struct({
  projects: Schema.Array(ProjectHealthSchema),
  stats: DashboardStatsSchema,
  urgentTasks: Schema.Array(UrgentTaskSchema),
  outOfSyncTasks: Schema.Array(OutOfSyncTaskSchema),
});

const dashboardGroup = HttpApiGroup.make("dashboard")
  .add(HttpApiEndpoint.get("getDashboard", "/dashboard").addSuccess(DashboardSchema));

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

const ApiKeyPath = Schema.Struct({ id: Schema.String });

const apiKeysGroup = HttpApiGroup.make("api-keys")
  .add(HttpApiEndpoint.get("listApiKeys", "/settings/api-keys")
    .addSuccess(Schema.Struct({ data: Schema.Array(ApiKeySchema) })))
  .add(HttpApiEndpoint.post("createApiKey", "/settings/api-keys")
    .setPayload(CreateApiKeyInput)
    .addSuccess(Schema.Struct({ key: ApiKeySchema, rawKey: Schema.String }), { status: 201 }))
  .add(HttpApiEndpoint.del("deleteApiKey", "/settings/api-keys/:id")
    .setPath(ApiKeyPath).addSuccess(Schema.UndefinedOr(Schema.Void)));

const UserSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.String,
  createdAt: Schema.String,
  lastSeen: Schema.NullOr(Schema.String),
});

const UserPath = Schema.Struct({ id: Schema.String });
const UpdateUserRoleInput = Schema.Struct({ role: Schema.Literal("admin", "member") });

const ProjectRoleEntry = Schema.Struct({
  projectId: Schema.String,
  projectSlug: Schema.String,
  role: Schema.Literal("admin", "member"),
});

const SetProjectRoleInput = Schema.Struct({
  projectId: Schema.String,
  role: Schema.Literal("admin", "member"),
});

const adminGroup = HttpApiGroup.make("admin")
  .add(HttpApiEndpoint.get("listUsers", "/admin/users")
    .addSuccess(Schema.Struct({ data: Schema.Array(UserSchema) })))
  .add(HttpApiEndpoint.patch("updateUserRole", "/admin/users/:id")
    .setPath(UserPath).setPayload(UpdateUserRoleInput).addSuccess(UserSchema))
  .add(HttpApiEndpoint.get("listUserProjectRoles", "/admin/users/:id/projects")
    .setPath(UserPath).addSuccess(Schema.Struct({ data: Schema.Array(ProjectRoleEntry) })))
  .add(HttpApiEndpoint.put("setUserProjectRole", "/admin/users/:id/projects")
    .setPath(UserPath).setPayload(SetProjectRoleInput).addSuccess(ProjectRoleEntry))
  .add(HttpApiEndpoint.del("removeUserProjectRole", "/admin/users/:id/projects/:projectId")
    .setPath(Schema.Struct({ id: Schema.String, projectId: Schema.String })).addSuccess(Schema.UndefinedOr(Schema.Void)));

export const LexaApi = HttpApi.make("lexa")
  .add(healthGroup)
  .add(projectsGroup)
  .add(columnsGroup)
  .add(swimlanesGroup)
  .add(tasksGroup)
  .add(boardGroup)
  .add(wikiGroup)
  .add(dashboardGroup)
  .add(apiKeysGroup)
  .add(adminGroup)
  .prefix("/api");

const apiLayer = HttpApiBuilder.api(LexaApi);

const respond = <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  eff.pipe(
    Effect.catchAllCause((cause) => {
      const failure = Cause.failureOption(cause);
      if (failure._tag === "Some") {
        const err = failure.value as { _tag: string } & Record<string, unknown>;
        const resp = errorResponse(err);
        const status = errorToStatus(err);
        return Effect.logError(`[HTTP] ${status} ${resp.error.code}: ${resp.error.message}`).pipe(
          Effect.annotateLogs({ code: resp.error.code, status, ...resp.error.details }),
          Effect.as(HttpServerResponse.unsafeJson(resp, { status })),
        );
      }
      for (const d of Cause.defects(cause)) {
        console.error("[API] Defect:", d instanceof Error ? d.message : String(d), d instanceof Error ? d.stack : undefined);
      }
      return Effect.succeed(
        HttpServerResponse.unsafeJson(
          { error: { code: "INTERNAL", message: "Internal error" } },
          { status: 500 }
        )
      );
    })
  );

const healthLive = HttpApiBuilder.group(LexaApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ ok: true as const }))
);

const projectsLive = HttpApiBuilder.group(LexaApi, "projects", (handlers) =>
  handlers
    .handle("list", (req) =>
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
    .handle("listMembers", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const roleRepo = yield* UserProjectRoleRepo;
        const userRepo = yield* UserRepo;
        const project = yield* projectService.findBySlug(req.path.slug);
        const roles = yield* roleRepo.findByProjectId(project.id);
        const members = yield* Effect.forEach(roles, (r) =>
          Effect.gen(function* () {
            const user = yield* userRepo.findById(r.user_id);
            if (user.role === "admin") return undefined;
            return { name: user.name, email: user.email, role: r.role };
          })
        );
        return { data: members.filter((m): m is { name: string; email: string; role: "admin" | "member" } => m !== undefined) };
      }))
    )
    .handle("updateProject", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ProjectService;
        const project = yield* service.update(req.path.slug, {
          name: req.payload.name,
          description: req.payload.description,
          githubRepo: req.payload.githubRepo,
        });
        return formatProject(project);
      }))
    )
    .handle("deleteProject", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ProjectService;
        yield* service.delete(req.path.slug);
        return undefined;
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
          type: req.payload.type, assignees: req.payload.assignees,
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
          assignees: req.payload.assignees,
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

const dashboardLive = HttpApiBuilder.group(LexaApi, "dashboard", (handlers) =>
  handlers.handle("getDashboard", () =>
    respond(Effect.gen(function* () {
      const service = yield* DashboardService;
      return yield* service.getDashboard();
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

const apiKeysLive = HttpApiBuilder.group(LexaApi, "api-keys", (handlers) =>
  handlers
    .handle("listApiKeys", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ApiKeyService;
        const keys = yield* service.list();
        return { data: keys };
      }))
    )
    .handle("createApiKey", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ApiKeyService;
        const result = yield* service.create(req.payload.name);
        return result;
      }))
    )
    .handle("deleteApiKey", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ApiKeyService;
        yield* service.delete(req.path.id);
        return undefined;
      }))
    )
);

const adminLive = HttpApiBuilder.group(LexaApi, "admin", (handlers) =>
  handlers
    .handle("listUsers", () =>
      respond(Effect.gen(function* () {
        const service = yield* UserService;
        const users = yield* service.list();
        return { data: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, lastSeen: u.last_seen })) };
      }))
    )
    .handle("updateUserRole", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* UserService;
        if (req.payload.role === "admin") {
          yield* service.promoteToAdmin(req.path.id);
        } else {
          yield* service.demoteToMember(req.path.id, "0");
        }
        const user = yield* service.getById(req.path.id);
        return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.created_at, lastSeen: user.last_seen };
      }))
    )
    .handle("listUserProjectRoles", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* UserProjectRoleService;
        const projectRepo = yield* ProjectRepo;
        const roles = yield* service.listForUser(req.path.id);
        const entries = yield* Effect.forEach(roles, (r) =>
          Effect.gen(function* () {
            const p = yield* projectRepo.findById(r.project_id).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            );
            return { projectId: r.project_id, projectSlug: p ? (p as any).slug : "unknown", role: r.role };
          })
        );
        return { data: entries };
      }))
    )
    .handle("setUserProjectRole", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* UserProjectRoleService;
        yield* service.setRole(req.path.id, req.payload.projectId, req.payload.role);
        return { projectId: req.payload.projectId, projectSlug: req.payload.projectId, role: req.payload.role };
      }))
    )
    .handle("removeUserProjectRole", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* UserProjectRoleService;
        yield* service.removeAccess(req.path.id, req.path.projectId);
        return undefined;
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

function formatTask(t: { id: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: any; priority: string; type: string; assignees: string[]; position: string; githubs: any[]; createdAt: string; updatedAt: string }) {
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

export function createApiHandler(dbPath: string) {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const dbLayer = Layer.succeed(Sqlite, db);

  const serviceLayer = Layer.mergeAll(
    ProjectRepo.Default, ProjectService.Default,
    ColumnRepo.Default, ColumnService.Default,
    SwimlaneRepo.Default, SwimlaneService.Default,
    TaskRepo.Default, TaskService.Default,
    WikiRepo.Default, WikiService.Default,
    ApiKeyRepo.Default, ApiKeyService.Default,
    UserRepo.Default, UserService.Default,
    UserProjectRoleRepo.Default, UserProjectRoleService.Default,
    DashboardService.Default,
  );
  const handlerLayer = Layer.mergeAll(
    healthLive, projectsLive, columnsLive, swimlanesLive, tasksLive, boardLive, wikiLive, apiKeysLive, adminLive, dashboardLive,
  ).pipe(Layer.provide(Layer.provide(serviceLayer, Layer.mergeAll(dbLayer, LoggerLayer))));
  const merged = Layer.mergeAll(apiLayer, handlerLayer);
  const { handler } = HttpApiBuilder.toWebHandler(merged as unknown as Parameters<typeof HttpApiBuilder.toWebHandler>[0]);
  return async (req: Request) => {
    const start = Date.now();
    const url = new URL(req.url);
    try {
      const res = await handler(req);
      const level = res.status >= 500 ? "ERROR" : res.status >= 400 ? "WARN" : "INFO";
      console.log(JSON.stringify({ level, service: "http", method: req.method, path: url.pathname, status: res.status, duration: Date.now() - start, timestamp: new Date().toISOString() }));
      return res;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.log(JSON.stringify({ level: "ERROR", service: "http", method: req.method, path: url.pathname, status: 500, duration: Date.now() - start, timestamp: new Date().toISOString(), error: e.message, stack: e.stack }));
      return new Response(JSON.stringify({ error: { code: "INTERNAL", message: e.message } }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  };
}
