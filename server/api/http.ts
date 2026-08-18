import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpMiddleware, HttpServerResponse } from "@effect/platform";
import { Cause, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LoggerLayer } from "../logging/logger";
import { Sqlite, withTx, DbError } from "../db/database";
import { Database } from "bun:sqlite";
import { getSetting, setSetting, deleteSetting } from "../db/settings";
import { ProjectNotFound, WikiPageNotFound, MachineNotFound, Forbidden, SetupLocked, TaskNotFound, InvalidName, InvalidRateLimit, InvalidGithubSettings, NoUserContext, GithubApiError, errorResponse, errorToStatus } from "./errors";
import { respond } from "./http-helpers";
import { AuthIdentity, actorFromIdentity } from "./auth";
import { teamsGroup, createTeamsLive } from "./teams";
import { workspaceGroup, createWorkspaceLive } from "./workspace";
import { sessionsGroup, createSessionsLive } from "./sessions";
import { auth } from "../auth";
import { createApiMiddleware } from "./middleware";
import { resolveRateLimitFromDbValues, syncRateLimitFromDb } from "./rate-limit";
import { syncGitHubConfigFromDb, resetGithubCaches } from "../github/client";
import { selectRepoFiles, REPO_CONTENT_DEFAULTS } from "../github/repo-content";
import { clampLimit, nextCursor } from "../../shared/pagination";
import { ProjectService } from "../services/project.service";
import { ProjectRepo } from "../repos/project.repo";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { ColumnService } from "../services/column.service";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneService } from "../services/swimlane.service";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { MilestoneService } from "../services/milestone.service";
import { MilestoneRepo } from "../repos/milestone.repo";
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
import { TeamsService, TeamNotFound } from "../services/teams.service";
import { WorkspaceService } from "../services/workspace.service";
import { AuthorizationService } from "../services/authorization.service";
import { WorkspaceInvitesService } from "../services/workspace-invites.service";
import { PasswordLinksService } from "../services/password-links.service";
import { FieldConfigService } from "../services/field-config.service";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ForgeService } from "../services/forge.service";
import { RuntimeEventService } from "../services/runtime-event.service";
import { ForgeRepo } from "../repos/forge.repo";
import { RuntimeEventRepo } from "../repos/runtime-event.repo";
import { RuntimeMachineRepo } from "../repos/runtime-machine.repo";
import { RuntimeMachineService } from "../services/runtime-machine.service";
import { SourceService } from "../services/source.service";
import { SourceRepo } from "../repos/source.repo";
import { TaskLinkService } from "../services/task-link.service";
import { TaskLinkRepo } from "../repos/task-link.repo";
import { GitHubService } from "../services/github.service";
import { ActivityService } from "../services/activity.service";
import { ActivityRepo } from "../repos/activity.repo";
import { CommentRepo } from "../repos/comment.repo";
import { CommentService } from "../services/comment.service";
import * as msg from "../activity-messages";
import { WebhookEventRepo } from "../repos/webhook-event.repo";
import { GitHubClient } from "../github/client";
import { extractText } from "../../shared/tiptap-text";
import type { ActivityEvent, ForgeTask, Project, DomainProject } from "../../shared/types";

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

// ── Setup wizard (first-run bootstrap, API-key exempt) ──
const SetupStatusSchema = Schema.Struct({
  configured: Schema.Boolean,
  needsAdmin: Schema.Boolean,
  hasApiKey: Schema.Boolean,
  hasProjects: Schema.Boolean,
  hasUsers: Schema.Boolean,
});
const SetupAdminInput = Schema.Struct({ email: Schema.String, password: Schema.String });
const SetupApiKeyResponse = Schema.Struct({ key: Schema.String });
const SetupSeedResponse = Schema.Struct({ seeded: Schema.Boolean });
const SetupOkResponse = Schema.Struct({ ok: Schema.Boolean });

const setupGroup = HttpApiGroup.make("setup")
  .add(HttpApiEndpoint.get("status", "/setup/status").addSuccess(SetupStatusSchema))
  .add(HttpApiEndpoint.post("setAdmin", "/setup/admin").setPayload(SetupAdminInput).addSuccess(SetupOkResponse))
  .add(HttpApiEndpoint.post("createApiKey", "/setup/api-key").addSuccess(SetupApiKeyResponse))
  .add(HttpApiEndpoint.post("seed", "/setup/seed").addSuccess(SetupSeedResponse))
  .add(HttpApiEndpoint.post("complete", "/setup/complete").addSuccess(SetupOkResponse));

const ProjectRepoSchema = Schema.Struct({
  repo: Schema.String.pipe(
    Schema.filter((r: string) => /^[^/\s]+\/[^/\s]+$/.test(r) || "repo must be owner/name")
  ),
  sourceRole: Schema.Boolean,
  workspaceRole: Schema.Boolean,
}).pipe(
  Schema.filter((r) => r.sourceRole || r.workspaceRole || "at least one role is required")
);

const ProjectRepoListResponse = Schema.Struct({ data: Schema.Array(ProjectRepoSchema) });

const GithubIssueSummarySchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literal("open", "closed"),
});

const GithubIssueListResponse = Schema.Struct({ data: Schema.Array(GithubIssueSummarySchema) });

const TaskFromIssuePayload = Schema.Struct({
  repo: Schema.String,
  issueNumber: Schema.Number,
});
const PutProjectReposPayload = Schema.Struct({
  repos: Schema.Array(ProjectRepoSchema),
});

const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  description: Schema.String,
  repos: Schema.Array(ProjectRepoSchema),
  // owning team (organization id); null = unassigned (superadmin-only until assigned)
  teamId: Schema.NullOr(Schema.String),
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
});

const SetProjectTeamPayload = Schema.Struct({
  teamId: Schema.NullOr(Schema.String),
});

const ProjectIdPath = Schema.Struct({ projectId: Schema.String });

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
    // Team assignment: superadmin any team; team admin own team only.
    // teamId null = unassigned (superadmin-only until assigned).
    HttpApiEndpoint.patch("setProjectTeam", "/projects/:projectId/team")
      .setPath(ProjectIdPath).setPayload(SetProjectTeamPayload).addSuccess(ProjectSchema)
  )
  .add(
    HttpApiEndpoint.get("listRepos", "/projects/:slug/repos")
      .setPath(SlugPath)
      .addSuccess(ProjectRepoListResponse)
  )
  .add(
    HttpApiEndpoint.get("listGithubIssues", "/projects/:slug/github/issues")
      .setPath(SlugPath)
      .addSuccess(GithubIssueListResponse)
  )
  .add(
    HttpApiEndpoint.put("replaceRepos", "/projects/:slug/repos")
      .setPath(SlugPath)
      .setPayload(PutProjectReposPayload)
      .addSuccess(ProjectRepoListResponse)
  )
  .add(
    HttpApiEndpoint.del("deleteProject", "/projects/:slug")
      .setPath(SlugPath)
      .addSuccess(Schema.Void, { status: 204 })
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
  isDone: Schema.Boolean,
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
  isDone: Schema.optional(Schema.Boolean),
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
    .setPath(ColumnPath)  .addSuccess(Schema.Void, { status: 204 }));

const SwimlaneSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  position: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  startAt: Schema.NullOr(Schema.String),
  kind: Schema.Literal("backlog", "sprint"),
  milestoneId: Schema.NullOr(Schema.String),
});

const SwimlaneDataResponse = Schema.Struct({ data: Schema.Array(SwimlaneSchema) });

const SwimlanePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
  startAt: Schema.optional(Schema.NullOr(Schema.String)),
  milestoneId: Schema.optional(Schema.NullOr(Schema.String)),
});

// PATCH is partial — name is optional here (POST keeps the strict payload).
const SwimlaneUpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
  startAt: Schema.optional(Schema.NullOr(Schema.String)),
  milestoneId: Schema.optional(Schema.NullOr(Schema.String)),
});

const SwimlanePath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const MilestoneSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  position: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  sprintCount: Schema.Number,
  archivedSprintCount: Schema.Number,
});

const MilestoneDataResponse = Schema.Struct({ data: Schema.Array(MilestoneSchema) });

const MilestonePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const MilestoneUpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const MilestonePath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const FieldOptionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  color: Schema.String,
  position: Schema.Number,
});

const FieldConfigSchema = Schema.Struct({
  priorities: Schema.Array(FieldOptionSchema),
  types: Schema.Array(FieldOptionSchema),
});

const FieldOptionInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.String,
  color: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
});

const FieldConfigPayload = Schema.Struct({
  priorities: Schema.Array(FieldOptionInputSchema),
  types: Schema.Array(FieldOptionInputSchema),
});

const fieldConfigGroup = HttpApiGroup.make("field-config")
  .add(HttpApiEndpoint.get("getFieldConfig", "/projects/:slug/field-config")
    .setPath(SlugPath).addSuccess(FieldConfigSchema))
  .add(HttpApiEndpoint.put("putFieldConfig", "/projects/:slug/field-config")
    .setPath(SlugPath).setPayload(FieldConfigPayload).addSuccess(FieldConfigSchema));

// ── Forge (runtime agent writing assistant) ──

const RuntimeModelSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.String,
});

const RuntimeAgentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const RuntimeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.Literal("opencode", "hermes", "command-code"),
  machineId: Schema.NullOr(Schema.String),
  // owning team; null = global runtime (claims any team's tasks)
  teamId: Schema.NullOr(Schema.String),
  agent: Schema.String,
  model: Schema.String,
  printLogs: Schema.Boolean,
  logLevel: Schema.Literal("", "DEBUG", "INFO", "WARN", "ERROR"),
  extraArgs: Schema.Array(Schema.String),
  modelsCatalog: Schema.Array(RuntimeModelSchema),
  agentsCatalog: Schema.Array(RuntimeAgentSchema),
  status: Schema.Literal("online", "offline"),
  lastError: Schema.NullOr(Schema.String),
  hostname: Schema.String,
  lastSeen: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const ForgeTaskSchema = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.NullOr(Schema.String),
  projectId: Schema.String,
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  documentTitle: Schema.String,
  agentId: Schema.String,
  skillId: Schema.String,
  agentName: Schema.String,
  skillName: Schema.String,
  extraPrompt: Schema.String,
  selection: Schema.String,
  docContext: Schema.String,
  status: Schema.Literal("queued", "running", "completed", "failed", "cancelled"),
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});

// Claim response carries the runtime's server-authoritative config so the
// daemon spawns with the latest provider + model + injected args + opencode
// logging flags without restarting, plus the server-built prompt (sources
// resolved, output rules enforced) and the task's agent/skill rules as
// Markdown — the daemon writes those into the run dir as AGENTS.md +
// .agents/<skill>/SKILL.md (files-only delivery, no host store). `skillIds`
// is the full current skill-id set: the daemon prunes stale skill dirs from
// the workspace so obsolete bundles never pollute opencode's discovery.
// `repoContent` (when present) is best-effort linked-repo context the daemon
// writes into repo-content/ (owner = owner part, repo = full "owner/repo").
const RepoContentEntrySchema = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  path: Schema.String,
  content: Schema.String,
});

// `repoContent` is the best-effort linked-repo context the daemon writes into
// repo-content/ (owner = owner part, repo = full "owner/repo"). Always an
// array — [] when nothing shipped (the daemon writes files only when
// non-empty).
const ClaimResponseSchema = Schema.Struct({
  task: Schema.NullOr(ForgeTaskSchema),
  provider: Schema.Literal("opencode", "hermes", "command-code"),
  agent: Schema.String,
  model: Schema.String,
  printLogs: Schema.Boolean,
  logLevel: Schema.Literal("", "DEBUG", "INFO", "WARN", "ERROR"),
  extraArgs: Schema.Array(Schema.String),
  prompt: Schema.String,
  agentMarkdown: Schema.String,
  skillMarkdown: Schema.String,
  skillIds: Schema.Array(Schema.String),
  repoContent: Schema.Array(RepoContentEntrySchema),
  // Warm-session verdict: the runtime session id to continue, or null when
  // there is no mapping or the mapped agent/skill no longer match the task
  // (daemon then mints a fresh session). agentId/skillId are the task's own
  // — for logging, they tell the daemon what the mapping must match.
  runtimeSessionId: Schema.NullOr(Schema.String),
  agentId: Schema.String,
  skillId: Schema.String,
});

const ForgeAgentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  isBuiltin: Schema.Boolean,
  skillIds: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ForgeSkillSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  isBuiltin: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

// ── Forge warm sessions (document ↔ runtime agent conversation mapping) ──
// Sessions are document-agnostic metadata: any document_id is valid, no 404s.
const ForgeSessionSchema = Schema.Struct({
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  runtimeId: Schema.String,
  runtimeSessionId: Schema.String,
  provider: Schema.Literal("opencode", "hermes", "command-code"),
  agentId: Schema.String,
  skillId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ForgeSessionListResponse = Schema.Struct({ data: Schema.Array(ForgeSessionSchema) });

const ForgeSessionUpsertInput = Schema.Struct({
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  runtimeId: Schema.String,
  runtimeSessionId: Schema.String,
  provider: Schema.Literal("opencode", "hermes", "command-code"),
  agentId: Schema.String,
  skillId: Schema.String,
});

// DELETE (daemon-side drop) and POST reset share the document+runtime ref.
const ForgeSessionRefInput = Schema.Struct({
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  runtimeId: Schema.String,
});

const CreateForgeAgentInput = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalWith(Schema.String, { default: () => "" }),
  instructions: Schema.String,
});

const UpdateForgeAgentInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
});

const ReplaceAgentSkillsInput = Schema.Struct({ skillIds: Schema.Array(Schema.String) });

const CreateForgeSkillInput = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalWith(Schema.String, { default: () => "" }),
  instructions: Schema.String,
});

const UpdateForgeSkillInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
});

const ForgeAgentPath = Schema.Struct({ id: Schema.String });
const ForgeSkillPath = Schema.Struct({ id: Schema.String });

const SourceSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  kind: Schema.Literal("wiki", "external"),
  title: Schema.String,
  ref: Schema.String,
  createdAt: Schema.String,
});

const RegisterRuntimeInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  provider: Schema.Literal("opencode", "hermes", "command-code"),
  machineId: Schema.String,
  teamId: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  hostname: Schema.optional(Schema.String),
});

// ── Runtime setup events (web wizard → machine CLI listener) ──
const RuntimeEventSchema = Schema.Struct({
  id: Schema.String,
  machineId: Schema.String,
  action: Schema.Literal("install", "update", "remove"),
  agentCli: Schema.Literal("opencode", "hermes", "command-code"),
  apiKeyId: Schema.NullOr(Schema.String),
  status: Schema.Literal("pending", "claimed", "completed", "failed"),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  claimedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});

const CreateRuntimeEventInput = Schema.Struct({
  machineId: Schema.String,
  action: Schema.Literal("install", "update"),
  agentCli: Schema.Literal("opencode", "hermes", "command-code"),
  apiKeyId: Schema.optional(Schema.String),
  rawKey: Schema.optional(Schema.String),
});

const RuntimeEventListResponse = Schema.Struct({ data: Schema.Array(RuntimeEventSchema) });
const RuntimeEventPath = Schema.Struct({ id: Schema.String });
const FailRuntimeEventInput = Schema.Struct({ error: Schema.String });

// ── Machine presence and CLI-reported runtime catalogs ──
const MachineSchema = Schema.Struct({
  id: Schema.String,
  hostname: Schema.String,
  clis: Schema.Array(Schema.Struct({
    provider: Schema.Literal("opencode", "hermes", "command-code"),
    version: Schema.String,
  })),
  lastSeen: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const MachineListResponse = Schema.Struct({ data: Schema.Array(MachineSchema) });
// Heartbeat response extends the machine with the project index — the
// listener provisions one workspace dir per project under ~/.lexa/projects/
// and keeps its local project-name lookup fresh without extra requests.
const MachineHeartbeatResponse = Schema.Struct({
  ...MachineSchema.fields,
  projects: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    slug: Schema.String,
    description: Schema.String,
  })),
});
const MachineRegisterInput = Schema.Struct({
  id: Schema.String,
  hostname: Schema.String,
  secret: Schema.optionalWith(Schema.String, { default: () => "" }),
});
// Register returns the minted secret exactly once (first registration only);
// re-registration no-ops without a secret.
const MachineRegisterResponse = Schema.Struct({
  machine: MachineSchema,
  secret: Schema.NullOr(Schema.String),
});
const MachineIdPath = Schema.Struct({ id: Schema.String });
const DaemonErrorInput = Schema.Struct({
  runtimeId: Schema.String,
  error: Schema.String,
});
const RuntimeCatalogInput = Schema.Struct({
  runtimeId: Schema.String,
  agentCli: Schema.Literal("opencode", "hermes", "command-code"),
  models: Schema.Array(RuntimeModelSchema),
  agents: Schema.Array(RuntimeAgentSchema),
});
const MachineHeartbeatInput = Schema.Struct({
  id: Schema.String,
  hostname: Schema.optional(Schema.String),
  runtimes: Schema.optional(Schema.Array(RuntimeCatalogInput)),
  clis: Schema.optional(Schema.Array(Schema.Struct({
    provider: Schema.Literal("opencode", "hermes", "command-code"),
    version: Schema.String,
  }))),
  daemonErrors: Schema.optional(Schema.Array(DaemonErrorInput)),
});

const UpdateRuntimeInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.Literal("opencode", "hermes", "command-code")),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  printLogs: Schema.optional(Schema.Boolean),
  logLevel: Schema.optional(Schema.Literal("", "DEBUG", "INFO", "WARN", "ERROR")),
  extraArgs: Schema.optional(Schema.Array(Schema.String)),
});

const HeartbeatInput = Schema.Struct({
  runtimeId: Schema.String,
});
const ClaimInput = Schema.Struct({ runtimeId: Schema.String });
const ClaimRuntimeEventInput = Schema.Struct({ machineId: Schema.String });
const CompleteTaskInput = Schema.Struct({ result: Schema.String });
const FailTaskInput = Schema.Struct({ error: Schema.String });

const CreateForgeTaskInput = Schema.Struct({
  slug: Schema.String,
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  agentId: Schema.String,
  skillId: Schema.String,
  extraPrompt: Schema.optional(Schema.String),   // per-run additional instructions
  selection: Schema.optional(Schema.String),
  runtimeId: Schema.optional(Schema.String),   // pick a specific runtime; omitted = any
});

const ForgeTaskPath = Schema.Struct({ id: Schema.String });
const RuntimeIdPath = Schema.Struct({ id: Schema.String });

const ForgeTaskListResponse = Schema.Struct({ data: Schema.Array(ForgeTaskSchema) });

const RecentForgeTaskSchema = Schema.extend(
  ForgeTaskSchema,
  Schema.Struct({ projectName: Schema.String })
);
const RecentForgeTaskListResponse = Schema.Struct({ data: Schema.Array(RecentForgeTaskSchema) });

// History rows carry the project name (control panel lists across projects).
// summary = per-status totals, global (not filter-scoped).
const ForgeTaskHistoryResponse = Schema.Struct({
  data: Schema.Array(RecentForgeTaskSchema),
  nextCursor: Schema.NullOr(Schema.String),
  summary: Schema.Struct({
    queued: Schema.Number,
    running: Schema.Number,
    completed: Schema.Number,
    failed: Schema.Number,
    cancelled: Schema.Number,
  }),
});

const ForgeTaskLogSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  message: Schema.String,
  stream: Schema.Literal("out", "err"),
  level: Schema.Literal("info", "warn", "error"),
  createdAt: Schema.String,
});
const ForgeTaskLogListResponse = Schema.Struct({ data: Schema.Array(ForgeTaskLogSchema) });
// stream/level are classified ONCE by the daemon at write time; defaults keep
// older daemons (and any non-daemon writer) working.
const AppendLogInput = Schema.Struct({
  message: Schema.String,
  stream: Schema.optional(Schema.Literal("out", "err")),
  level: Schema.optional(Schema.Literal("info", "warn", "error")),
});

const DocumentPath = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("task", "wiki"),
  id: Schema.String,
});

const AddSourceInput = Schema.Struct({
  kind: Schema.Literal("wiki", "external"),
  ref: Schema.String,
});

const SourceListResponse = Schema.Struct({ data: Schema.Array(SourceSchema) });

// ── Task links (subtask / blocked-by / related) ──

const TaskLinkSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  fromTaskId: Schema.String,
  toTaskId: Schema.String,
  relation: Schema.Literal("subtask_of", "blocked_by", "related_to"),
  createdAt: Schema.String,
});

const TaskLinkListResponse = Schema.Struct({ data: Schema.Array(TaskLinkSchema) });

const AddTaskLinkInput = Schema.Struct({
  toTaskId: Schema.String,
  relation: Schema.Literal("subtask_of", "blocked_by", "related_to"),
});

const TaskLinkSuggestionSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  columnName: Schema.String,
  type: Schema.String,
  priority: Schema.String,
});

const TaskSearchResponse = Schema.Struct({ data: Schema.Array(TaskLinkSuggestionSchema) });

// Mutation envelope (invariant 6): the response carries the activity rows
// appended by the mutation — clients prepend them to the timeline via
// setQueryData (Task 14), never refetch.
const ActivityEventSchema = Schema.Struct({
  kind: Schema.Literal("event"),
  id: Schema.Number,
  actorKind: Schema.Literal("user", "agent", "system"),
  actorLabel: Schema.String,
  actorUserId: Schema.NullOr(Schema.String),
  type: Schema.Literal("created", "moved", "field_changed", "archived", "restored", "deleted",
    "link_added", "link_removed", "source_added", "source_removed",
    "github_linked", "github_unlinked", "github_synced",
    "forge_completed", "forge_failed", "forge_cancelled",
    "commented", "comment_deleted"),
  message: Schema.String,
  createdAt: Schema.String,
});

const TaskCommentSchema = Schema.Struct({
  kind: Schema.Literal("comment"),
  id: Schema.Number,
  authorId: Schema.NullOr(Schema.String),
  authorKind: Schema.Literal("user", "agent", "system"),
  authorLabel: Schema.String,
  body: Schema.Any,
  editedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const LinkMutationResponse = Schema.Struct({
  data: TaskLinkSchema,
  activity: Schema.Array(ActivityEventSchema),
});
const SourceMutationResponse = Schema.Struct({
  data: SourceSchema,
  activity: Schema.Array(ActivityEventSchema),
});

const TaskLinkPath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const taskLinksGroup = HttpApiGroup.make("task-links")
  .add(HttpApiEndpoint.get("listTaskLinks", "/projects/:slug/tasks/:id/links")
    .setPath(TaskLinkPath).addSuccess(TaskLinkListResponse))
  .add(HttpApiEndpoint.post("addTaskLink", "/projects/:slug/tasks/:id/links")
    .setPath(TaskLinkPath).setPayload(AddTaskLinkInput).addSuccess(LinkMutationResponse, { status: 201 }))
  .add(HttpApiEndpoint.del("removeTaskLink", "/projects/:slug/tasks/:id/links/:linkId")
    .setPath(Schema.Struct({ slug: Schema.String, id: Schema.String, linkId: Schema.String }))
    .addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.get("searchTasks", "/projects/:slug/tasks/search")
    .setPath(SlugPath).addSuccess(TaskSearchResponse));

const forgeGroup = HttpApiGroup.make("forge")
  .add(HttpApiEndpoint.post("registerRuntime", "/forge/runtimes/register")
    .setPayload(RegisterRuntimeInput).addSuccess(RuntimeSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateRuntime", "/forge/runtimes/:id")
    .setPath(RuntimeIdPath).setPayload(UpdateRuntimeInput).addSuccess(RuntimeSchema))
  .add(HttpApiEndpoint.del("removeRuntime", "/forge/runtimes/:id")
    .setPath(RuntimeIdPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("heartbeat", "/forge/daemon/heartbeat")
    .setPayload(HeartbeatInput).addSuccess(Schema.Struct({ ok: Schema.Boolean })))
  .add(HttpApiEndpoint.post("claimTask", "/forge/daemon/claim")
    .setPayload(ClaimInput).addSuccess(ClaimResponseSchema))
  // Runtime setup events — web wizard creates, CLI listener claims/completes.
  .add(HttpApiEndpoint.post("createRuntimeEvent", "/forge/runtime-events")
    .setPayload(CreateRuntimeEventInput).addSuccess(RuntimeEventSchema, { status: 201 }))
  .add(HttpApiEndpoint.post("claimRuntimeEvent", "/forge/runtime-events/claim")
    .setPayload(ClaimRuntimeEventInput)
    .addSuccess(Schema.NullOr(Schema.Struct({ event: RuntimeEventSchema, rawKey: Schema.NullOr(Schema.String) }))))
  .add(HttpApiEndpoint.post("completeRuntimeEvent", "/forge/runtime-events/:id/complete")
    .setPath(RuntimeEventPath).addSuccess(RuntimeEventSchema))
  .add(HttpApiEndpoint.post("failRuntimeEvent", "/forge/runtime-events/:id/fail")
    .setPath(RuntimeEventPath).setPayload(FailRuntimeEventInput).addSuccess(RuntimeEventSchema))
  .add(HttpApiEndpoint.get("getRuntimeEvent", "/forge/runtime-events/:id")
    .setPath(RuntimeEventPath).addSuccess(RuntimeEventSchema))
  .add(HttpApiEndpoint.get("listRuntimeEvents", "/forge/runtime-events")
    .addSuccess(RuntimeEventListResponse))
  .add(HttpApiEndpoint.post("machineHeartbeat", "/forge/machines/heartbeat")
    .setPayload(MachineHeartbeatInput).addSuccess(MachineHeartbeatResponse))
  .add(HttpApiEndpoint.post("registerMachine", "/forge/machines/register")
    .setPayload(MachineRegisterInput).addSuccess(MachineRegisterResponse))
  .add(HttpApiEndpoint.get("listMachines", "/forge/machines")
    .addSuccess(MachineListResponse))
  .add(HttpApiEndpoint.del("removeMachine", "/forge/machines/:id")
    .setPath(MachineIdPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.get("listRuntimes", "/forge/runtimes")
    .addSuccess(Schema.Struct({ data: Schema.Array(RuntimeSchema) })))
  .add(HttpApiEndpoint.post("createForgeTask", "/forge/tasks")
    .setPayload(CreateForgeTaskInput).addSuccess(ForgeTaskSchema, { status: 201 }))
  .add(HttpApiEndpoint.get("getForgeTask", "/forge/tasks/:id")
    .setPath(ForgeTaskPath).addSuccess(ForgeTaskSchema))
  .add(HttpApiEndpoint.get("listForgeTasks", "/forge/tasks")
    .addSuccess(ForgeTaskListResponse))
  .add(HttpApiEndpoint.get("listRecentForgeTasks", "/forge/tasks/recent")
    .addSuccess(RecentForgeTaskListResponse))
  .add(HttpApiEndpoint.get("listForgeTaskHistory", "/forge/tasks/history")
    .addSuccess(ForgeTaskHistoryResponse))
  .add(HttpApiEndpoint.post("completeForgeTask", "/forge/daemon/tasks/:id/complete")
    .setPath(ForgeTaskPath).setPayload(CompleteTaskInput).addSuccess(ForgeTaskSchema))
  .add(HttpApiEndpoint.post("failForgeTask", "/forge/daemon/tasks/:id/fail")
    .setPath(ForgeTaskPath).setPayload(FailTaskInput).addSuccess(ForgeTaskSchema))
  .add(HttpApiEndpoint.get("getDaemonTaskStatus", "/forge/daemon/tasks/:id/status")
    .setPath(ForgeTaskPath).addSuccess(Schema.Struct({ status: Schema.String })))
  .add(HttpApiEndpoint.post("cancelForgeTask", "/forge/tasks/:id/cancel")
    .setPath(ForgeTaskPath).addSuccess(ForgeTaskSchema))
  .add(HttpApiEndpoint.get("listForgeTaskLogs", "/forge/tasks/:id/logs")
    .setPath(ForgeTaskPath).addSuccess(ForgeTaskLogListResponse))
  .add(HttpApiEndpoint.post("appendForgeTaskLog", "/forge/daemon/tasks/:id/log")
    .setPath(ForgeTaskPath).setPayload(AppendLogInput).addSuccess(ForgeTaskLogSchema))
  .add(HttpApiEndpoint.get("listForgeAgents", "/forge/agents")
    .addSuccess(Schema.Struct({ data: Schema.Array(ForgeAgentSchema) })))
  .add(HttpApiEndpoint.post("createForgeAgent", "/forge/agents")
    .setPayload(CreateForgeAgentInput).addSuccess(ForgeAgentSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateForgeAgent", "/forge/agents/:id")
    .setPath(ForgeAgentPath).setPayload(UpdateForgeAgentInput).addSuccess(ForgeAgentSchema))
  .add(HttpApiEndpoint.del("deleteForgeAgent", "/forge/agents/:id")
    .setPath(ForgeAgentPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.put("replaceAgentSkills", "/forge/agents/:id/skills")
    .setPath(ForgeAgentPath).setPayload(ReplaceAgentSkillsInput).addSuccess(ForgeAgentSchema))
  .add(HttpApiEndpoint.post("resetForgeAgent", "/forge/agents/:id/reset")
    .setPath(ForgeAgentPath).addSuccess(ForgeAgentSchema))
  .add(HttpApiEndpoint.get("listForgeSkills", "/forge/skills")
    .addSuccess(Schema.Struct({ data: Schema.Array(ForgeSkillSchema) })))
  .add(HttpApiEndpoint.post("createForgeSkill", "/forge/skills")
    .setPayload(CreateForgeSkillInput).addSuccess(ForgeSkillSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateForgeSkill", "/forge/skills/:id")
    .setPath(ForgeSkillPath).setPayload(UpdateForgeSkillInput).addSuccess(ForgeSkillSchema))
  .add(HttpApiEndpoint.del("deleteForgeSkill", "/forge/skills/:id")
    .setPath(ForgeSkillPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("resetForgeSkill", "/forge/skills/:id/reset")
    .setPath(ForgeSkillPath).addSuccess(ForgeSkillSchema))
  // Warm sessions: the daemon PUTs the pre-spawn mapping and DELETEs it on
  // cancel/timeout; the browser GETs (popover line) and POSTs reset.
  .add(HttpApiEndpoint.get("listForgeSessions", "/forge/sessions")
    .addSuccess(ForgeSessionListResponse))
  .add(HttpApiEndpoint.put("upsertForgeSession", "/forge/sessions")
    .setPayload(ForgeSessionUpsertInput).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.del("removeForgeSession", "/forge/sessions")
    .setPayload(ForgeSessionRefInput).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("resetForgeSession", "/forge/sessions/reset")
    .setPayload(ForgeSessionRefInput).addSuccess(Schema.Void, { status: 204 })
    .addError(Schema.Struct({ _tag: Schema.Literal("ForgeSessionActive") })))
  .add(HttpApiEndpoint.get("listSources", "/projects/:slug/documents/:type/:id/sources")
    .setPath(DocumentPath).addSuccess(SourceListResponse))
  .add(HttpApiEndpoint.post("addSource", "/projects/:slug/documents/:type/:id/sources")
    .setPath(DocumentPath).setPayload(AddSourceInput).addSuccess(SourceMutationResponse, { status: 201 }))
  .add(HttpApiEndpoint.del("removeSource", "/projects/:slug/documents/:type/:id/sources/:sourceId")
    .setPath(Schema.Struct({ slug: Schema.String, type: Schema.Literal("task", "wiki"), id: Schema.String, sourceId: Schema.String }))
    .addSuccess(Schema.Void, { status: 204 }));

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

const SwimlaneMutationResponse = Schema.Struct({
  data: SwimlaneSchema,
  activity: Schema.Array(ActivityEventSchema),
});

const MilestoneMutationResponse = Schema.Struct({
  data: MilestoneSchema,
  activity: Schema.Array(ActivityEventSchema),
});

const milestonesGroup = HttpApiGroup.make("milestones")
  .add(HttpApiEndpoint.get("listMilestones", "/projects/:slug/milestones")
    .setPath(SlugPath).addSuccess(MilestoneDataResponse))
  .add(HttpApiEndpoint.post("createMilestone", "/projects/:slug/milestones")
    .setPath(SlugPath).setPayload(MilestonePayload).addSuccess(MilestoneSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateMilestone", "/projects/:slug/milestones/:id")
    .setPath(MilestonePath).setPayload(MilestoneUpdatePayload).addSuccess(MilestoneSchema))
  .add(HttpApiEndpoint.del("deleteMilestone", "/projects/:slug/milestones/:id")
    .setPath(MilestonePath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("archiveMilestone", "/projects/:slug/milestones/:id/archive")
    .setPath(MilestonePath).addSuccess(MilestoneMutationResponse))
  .add(HttpApiEndpoint.post("restoreMilestone", "/projects/:slug/milestones/:id/restore")
    .setPath(MilestonePath).addSuccess(MilestoneMutationResponse));

const swimlanesGroup = HttpApiGroup.make("swimlanes")
  .add(HttpApiEndpoint.get("listSwimlanes", "/projects/:slug/swimlanes")
    .setPath(SlugPath).addSuccess(SwimlaneDataResponse))
  .add(HttpApiEndpoint.post("createSwimlane", "/projects/:slug/swimlanes")
    .setPath(SlugPath).setPayload(SwimlanePayload).addSuccess(SwimlaneSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateSwimlane", "/projects/:slug/swimlanes/:id")
    .setPath(SwimlanePath).setPayload(SwimlaneUpdatePayload).addSuccess(SwimlaneSchema))
  .add(HttpApiEndpoint.del("deleteSwimlane", "/projects/:slug/swimlanes/:id")
    .setPath(SwimlanePath)  .addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("archiveSwimlane", "/projects/:slug/swimlanes/:id/archive")
    .setPath(SwimlanePath).addSuccess(SwimlaneMutationResponse))
  .add(HttpApiEndpoint.post("restoreSwimlane", "/projects/:slug/swimlanes/:id/restore")
    .setPath(SwimlanePath).addSuccess(SwimlaneMutationResponse));

const GithubIssueSchema = Schema.Struct({
  issueId: Schema.String,
  issueNumber: Schema.Number,
  repo: Schema.String,
  syncedState: Schema.NullOr(Schema.Literal("open", "closed")),
  url: Schema.String,
  outOfSync: Schema.Boolean,
  pushFailed: Schema.Boolean,
});

const TaskSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  columnId: Schema.String,
  swimlaneId: Schema.NullOr(Schema.String),
  title: Schema.String,
  description: Schema.Any,
  priority: Schema.String,        // priority_options.id
  type: Schema.String,            // type_options.id
  assignees: Schema.Array(Schema.String),
  position: Schema.String,
  githubs: Schema.Array(GithubIssueSchema),
  archivedAt: Schema.NullOr(Schema.String),
  dueAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const TaskListResponse = Schema.Struct({
  data: Schema.Array(TaskSchema),
  nextCursor: Schema.NullOr(Schema.String),
});

const TaskMutationResponse = Schema.Struct({
  data: TaskSchema,
  activity: Schema.Array(ActivityEventSchema),
});

const CreateTaskPayload = Schema.Struct({
  columnId: Schema.String,
  swimlaneId: Schema.optional(Schema.String),
  title: Schema.String,
  description: Schema.optional(Schema.Any),
  priority: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  assignees: Schema.optional(Schema.Array(Schema.String)),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const UpdateTaskPayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.Any),
  priority: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  assignees: Schema.optional(Schema.Array(Schema.String)),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const MoveTaskPayload = Schema.Struct({
  columnId: Schema.String,
  swimlaneId: Schema.String,
  beforeTaskId: Schema.optional(Schema.String),
  afterTaskId: Schema.optional(Schema.String),
  clearDueAt: Schema.optional(Schema.Boolean),
});

const TaskPath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const GithubLinkPayload = Schema.Struct({ repo: Schema.String });

const GithubLinkExistingPayload = Schema.Struct({
  repo: Schema.String,
  issueNumber: Schema.Number,
});

const GithubLinkPath = Schema.Struct({ slug: Schema.String, id: Schema.String, issueId: Schema.String });

const ActivityItemSchema = Schema.Union(ActivityEventSchema, TaskCommentSchema);
const ActivityPageSchema = Schema.Struct({ data: Schema.Array(ActivityItemSchema), nextCursor: Schema.NullOr(Schema.String) });

const CommentPayloadSchema = Schema.Struct({ body: Schema.Any });
const CommentIdPath = Schema.Struct({ slug: Schema.String, id: Schema.String, commentId: Schema.NumberFromString });
const CommentCreateResponseSchema = Schema.Struct({
  data: Schema.Struct({ comment: TaskCommentSchema, activity: ActivityEventSchema }),
});
const CommentUpdateResponseSchema = Schema.Struct({ data: TaskCommentSchema });

const BoardSchema = Schema.Struct({
  project: ProjectSchema,
  columns: Schema.Array(ColumnSchema),
  swimlanes: Schema.Array(SwimlaneSchema),
  milestones: Schema.Array(MilestoneSchema),
  fieldConfig: FieldConfigSchema,
  links: Schema.Array(TaskLinkSchema),
  tasks: Schema.Array(TaskSchema),
});

const tasksGroup = HttpApiGroup.make("tasks")
  .add(HttpApiEndpoint.get("listTasks", "/projects/:slug/tasks")
    .setPath(SlugPath).addSuccess(TaskListResponse))
  .add(HttpApiEndpoint.post("createTask", "/projects/:slug/tasks")
    .setPath(SlugPath).setPayload(CreateTaskPayload).addSuccess(TaskMutationResponse, { status: 201 }))
  .add(HttpApiEndpoint.get("getTask", "/projects/:slug/tasks/:id")
    .setPath(TaskPath).addSuccess(TaskSchema))
  .add(HttpApiEndpoint.patch("updateTask", "/projects/:slug/tasks/:id")
    .setPath(TaskPath).setPayload(UpdateTaskPayload).addSuccess(TaskMutationResponse))
  .add(HttpApiEndpoint.post("moveTask", "/projects/:slug/tasks/:id/move")
    .setPath(TaskPath).setPayload(MoveTaskPayload).addSuccess(TaskMutationResponse))
  .add(HttpApiEndpoint.del("deleteTask", "/projects/:slug/tasks/:id")
    .setPath(TaskPath)  .addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("archiveTask", "/projects/:slug/tasks/:id/archive")
    .setPath(TaskPath).addSuccess(TaskMutationResponse))
  .add(HttpApiEndpoint.post("restoreTask", "/projects/:slug/tasks/:id/restore")
    .setPath(TaskPath).addSuccess(TaskMutationResponse))
  .add(HttpApiEndpoint.get("taskActivity", "/projects/:slug/tasks/:id/activity")
    .setPath(TaskPath).addSuccess(ActivityPageSchema))
  .add(HttpApiEndpoint.post("createComment", "/projects/:slug/tasks/:id/comments")
    .setPath(TaskPath).setPayload(CommentPayloadSchema).addSuccess(CommentCreateResponseSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateComment", "/projects/:slug/tasks/:id/comments/:commentId")
    .setPath(CommentIdPath).setPayload(CommentPayloadSchema).addSuccess(CommentUpdateResponseSchema))
  .add(HttpApiEndpoint.del("deleteComment", "/projects/:slug/tasks/:id/comments/:commentId")
    .setPath(CommentIdPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("linkGithubIssue", "/projects/:slug/tasks/:id/github-link")
    .setPath(TaskPath).setPayload(GithubLinkPayload).addSuccess(TaskMutationResponse))
  .add(HttpApiEndpoint.post("linkExistingGithubIssue", "/projects/:slug/tasks/:id/github-link-existing")
    .setPath(TaskPath).setPayload(GithubLinkExistingPayload).addSuccess(TaskMutationResponse))
  .add(HttpApiEndpoint.del("unlinkGithubIssue", "/projects/:slug/tasks/:id/github-link/:issueId")
    .setPath(GithubLinkPath).addSuccess(TaskMutationResponse))
  .add(HttpApiEndpoint.post("createTaskFromIssue", "/projects/:slug/github/task-from-issue")
    .setPath(SlugPath).setPayload(TaskFromIssuePayload).addSuccess(TaskMutationResponse, { status: 201 }));

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
    .setPath(PagePath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.get("listRevisions", "/projects/:slug/wiki/:pageSlug/revisions")
    .setPath(PagePath).addSuccess(RevisionsListResponse))
  .add(HttpApiEndpoint.get("getRevision", "/projects/:slug/wiki/:pageSlug/revisions/:revisionId")
    .setPath(RevisionPath).addSuccess(RevisionResponse))
  .add(HttpApiEndpoint.post("restoreRevision", "/projects/:slug/wiki/:pageSlug/restore")
    .setPath(PagePath).setPayload(RestorePayload).addSuccess(WikiPageSchema));

const ApiKeyPath = Schema.Struct({ id: Schema.String });

// Response shape is the frontend contract: envOverride is retained but env is
// no longer a runtime source (bootstrap mirror only) — always false.
const RateLimitSchema = Schema.Struct({
  max: Schema.Number,
  windowMs: Schema.Number,
  envOverride: Schema.Boolean,
});

// Deliberately loose (optional numbers): every invalid shape — missing field,
// non-integer, out of range — is validated in the handler and fails with the
// same 422 INVALID_RATE_LIMIT envelope (platform schema decode errors are 400).
const RateLimitInput = Schema.Struct({
  max: Schema.optional(Schema.Number),
  windowMs: Schema.optional(Schema.Number),
});

// DB is the single source of truth: source is "settings" if any github_*
// settings row exists (mirrored from env at boot), else "none" — env is never
// a runtime state. Only appId is returned as a value — the PEM and webhook
// secret are write-only (booleans only).
const GithubSettingsSchema = Schema.Struct({
  appId: Schema.String,
  privateKeySet: Schema.Boolean,
  webhookSecretSet: Schema.Boolean,
  source: Schema.Literal("settings", "none"),
});

// Loose (all optional): presence is validated in the handler so missing and
// invalid fields share the 422 INVALID_GITHUB_SETTINGS envelope. The PEM and
// webhook secret are write-only — the GET response never carries their values.
const GithubSettingsInput = Schema.Struct({
  appId: Schema.optional(Schema.String),
  privateKey: Schema.optional(Schema.String),
  webhookSecret: Schema.optional(Schema.String),
});

const apiKeysGroup = HttpApiGroup.make("api-keys")
  .add(HttpApiEndpoint.get("listApiKeys", "/settings/api-keys")
    .addSuccess(Schema.Struct({ data: Schema.Array(ApiKeySchema) })))
  .add(HttpApiEndpoint.post("createApiKey", "/settings/api-keys")
    .setPayload(CreateApiKeyInput)
    .addSuccess(Schema.Struct({ key: ApiKeySchema, rawKey: Schema.String }), { status: 201 }))
  .add(HttpApiEndpoint.del("deleteApiKey", "/settings/api-keys/:id")
    .setPath(ApiKeyPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.get("getRateLimit", "/settings/rate-limit")
    .addSuccess(RateLimitSchema))
  .add(HttpApiEndpoint.put("setRateLimit", "/settings/rate-limit")
    .setPayload(RateLimitInput)
    .addSuccess(RateLimitSchema))
  .add(HttpApiEndpoint.get("getGithubSettings", "/settings/github")
    .addSuccess(GithubSettingsSchema))
  .add(HttpApiEndpoint.put("setGithubSettings", "/settings/github")
    .setPayload(GithubSettingsInput)
    .addSuccess(GithubSettingsSchema))
  .add(HttpApiEndpoint.get("searchGithubRepos", "/settings/github/search-repos")
    .addSuccess(Schema.Struct({ data: Schema.Array(Schema.String) })));

const UserSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.String,
  createdAt: Schema.String,
  lastSeen: Schema.NullOr(Schema.String),
});

const UserPath = Schema.Struct({ id: Schema.String });

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
  .add(HttpApiEndpoint.get("listUserProjectRoles", "/admin/users/:id/projects")
    .setPath(UserPath).addSuccess(Schema.Struct({ data: Schema.Array(ProjectRoleEntry) })))
  .add(HttpApiEndpoint.put("setUserProjectRole", "/admin/users/:id/projects")
    .setPath(UserPath).setPayload(SetProjectRoleInput).addSuccess(ProjectRoleEntry))
  .add(HttpApiEndpoint.del("removeUserProjectRole", "/admin/users/:id/projects/:projectId")
    .setPath(Schema.Struct({ id: Schema.String, projectId: Schema.String })).addSuccess(Schema.Void, { status: 204 }));

// Self-service — no admin gate: the acting user comes from the session cookie
// or a key-bound user (middleware → AuthIdentity.userId). Agents with bare
// keys get NO_USER_CONTEXT: they have no profile to edit.
const UpdateMyNameInput = Schema.Struct({ name: Schema.String });

const meGroup = HttpApiGroup.make("me")
  .add(HttpApiEndpoint.patch("updateMe", "/me")
    .setPayload(UpdateMyNameInput)
    .addSuccess(UserSchema));

export const LexaApi = HttpApi.make("lexa")
  .add(healthGroup)
  .add(setupGroup)
  .add(projectsGroup)
  .add(columnsGroup)
  .add(swimlanesGroup)
  .add(milestonesGroup)
  .add(fieldConfigGroup)
  .add(forgeGroup)
  .add(taskLinksGroup)
  .add(tasksGroup)
  .add(boardGroup)
  .add(wikiGroup)
  .add(dashboardGroup)
  .add(apiKeysGroup)
  .add(adminGroup)
  .add(meGroup)
  .add(teamsGroup)
  .add(workspaceGroup)
  .add(sessionsGroup)
  .prefix("/api");

const apiLayer = HttpApiBuilder.api(LexaApi);

// The HttpApi platform rewrites req.request.url to a host-less relative path
// (fromWeb → removeHost). originalUrl keeps the full URL, so parse query params
// from that instead of calling `new URL(req.request.url)` (which throws).
const searchParams = (req: { request: { originalUrl: string } }): URLSearchParams =>
  URL.parse(req.request.originalUrl)?.searchParams ?? new URLSearchParams();

// Admin-only gate: consumes the caller identity resolved by the API
// middleware (member keys are 403'd there already — this is belt-and-braces
// for any handler reached through a path that skips the middleware check).
const requireAdmin = Effect.gen(function* () {
  const identity = yield* AuthIdentity;
  if (identity.role !== "admin") {
    return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
  }
  return identity;
});

// Effective GitHub config for the response envelope — DB ONLY (env is a
// first-boot bootstrap, mirrored into the settings table at boot). source is
// "settings" if any github_* row exists, else "none". Only appId is returned
// as a value — the PEM and webhook secret are write-only (booleans only).
function githubSettingsResponse(db: Database): {
  appId: string;
  privateKeySet: boolean;
  webhookSecretSet: boolean;
  source: "settings" | "none";
} {
  const settings = {
    appId: getSetting(db, "github_app_id"),
    privateKey: getSetting(db, "github_private_key"),
    webhookSecret: getSetting(db, "github_webhook_secret"),
  };
  const nonEmpty = (v: string | null): string => (v !== null && v.trim() !== "" ? v : "");
  const anySettings = settings.appId !== null || settings.privateKey !== null || settings.webhookSecret !== null;
  return {
    appId: nonEmpty(settings.appId),
    privateKeySet: nonEmpty(settings.privateKey) !== "",
    webhookSecretSet: nonEmpty(settings.webhookSecret) !== "",
    source: anySettings ? "settings" : "none",
  };
}

// At most N source repos per claim — app-level setting forge_repo_cap
// (env bootstrap LXK_FORGE_REPO_CAP, default 3; same pattern as rate limits).
const DEFAULT_REPO_CONTENT_REPOS = 3;

interface RepoContentEntry {
  owner: string;
  repo: string; // full "owner/repo"
  path: string;
  content: string;
}

// Best-effort linked-repo content for Forge context (Contents: Read). Every
// failure — unconfigured app, missing repo, network, per-file errors — skips
// that repo/file with a warn; the claim NEVER fails because context is
// unavailable. Caps: ≤3 repos, ≤maxFiles files total, ≤maxTotalBytes total,
// each file truncated to maxBytesPerFile at write.
const loadTaskRepoContent = (task: ForgeTask): Effect.Effect<RepoContentEntry[], never, GitHubClient | TaskRepo | ProjectReposRepo | Sqlite> =>
  Effect.gen(function* () {
    if (task.documentType !== "task") return [];
    const taskRepo = yield* TaskRepo;
    const taskRow = yield* taskRepo.findById(task.documentId).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    if (!taskRow) return [];
    // Source: the project's SOURCE-ROLE repos (admin-controlled), capped by
    // the forge_repo_cap setting. Task-linked repos no longer feed context.
    const reposRepo = yield* ProjectReposRepo;
    const projectRepos = yield* reposRepo.listByProject(taskRow.projectId).pipe(
      Effect.catchAll(() => Effect.succeed([]))
    );
    const db = yield* Sqlite;
    const capRaw = getSetting(db, "forge_repo_cap") || process.env.LXK_FORGE_REPO_CAP || "";
    const capParsed = Number.parseInt(capRaw, 10);
    const cap = Number.isFinite(capParsed) && capParsed > 0 ? capParsed : DEFAULT_REPO_CONTENT_REPOS;
    const repos = projectRepos.filter((r) => r.sourceRole).map((r) => r.repo).slice(0, cap);
    if (repos.length === 0) return [];
    const client = yield* GitHubClient;
    const entries: RepoContentEntry[] = [];
    let totalBytes = 0;
    for (const fullRepo of repos) {
      const [owner, name] = fullRepo.split("/");
      if (!owner || !name) continue;
      const branch = yield* client.getDefaultBranch(owner, name).pipe(
        Effect.tapError((e) => Effect.logWarning(`[Forge] repo-content: skip ${fullRepo}: ${e.message}`)),
        Effect.catchAll(() => Effect.succeed(""))
      );
      if (!branch) continue;
      const tree = yield* client.getRepoFileTree(owner, name, branch).pipe(
        Effect.tapError((e) => Effect.logWarning(`[Forge] repo-content: tree failed for ${fullRepo}: ${e.message}`)),
        Effect.catchAll(() => Effect.succeed([] as { path: string; type: string; size?: number }[]))
      );
      const selected = selectRepoFiles(tree);
      for (const file of selected) {
        if (entries.length >= REPO_CONTENT_DEFAULTS.maxFiles) break;
        const content = yield* client.getRepoFileContent(owner, name, file.path).pipe(
          Effect.tapError((e) => Effect.logWarning(`[Forge] repo-content: skip ${fullRepo}:${file.path}: ${e.message}`)),
          Effect.catchAll(() => Effect.succeed(""))
        );
        if (!content) continue;
        const truncated = content.slice(0, REPO_CONTENT_DEFAULTS.maxBytesPerFile);
        if (totalBytes + truncated.length > REPO_CONTENT_DEFAULTS.maxTotalBytes) continue;
        totalBytes += truncated.length;
        entries.push({ owner, repo: fullRepo, path: file.path, content: truncated });
      }
    }
    return entries;
  });

const healthLive = HttpApiBuilder.group(LexaApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ ok: true as const }))
);

function generateRawApiKey(): string {
  const raw = randomBytes(32);
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of raw) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) { result = chars[Number(value % base)] + result; value /= base; }
  while (result.length < 43) result = chars[0] + result;
  return `lxk_${result}`;
}

function setupStatus(db: Database) {
  const apiKeyCount = (db.prepare("SELECT COUNT(*) c FROM api_keys").get() as { c: number }).c;
  const projectCount = (db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c;
  const userCount = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  const superadminCount = (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'superadmin'").get() as { c: number }).c;
  const adminEmails = (process.env.LXK_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const setupComplete = getSetting(db, "setup_complete") === "1";
  return {
    configured: setupComplete || (apiKeyCount > 0 && superadminCount > 0),
    needsAdmin: superadminCount === 0,
    hasApiKey: apiKeyCount > 0,
    hasProjects: projectCount > 0,
    hasUsers: userCount > 0,
  };
}

// The wizard is only for first install: once setup is complete (flag set by
// /setup/complete) or real projects exist, the mutating endpoints lock.
// setAdmin (superadmin account creation) stays open while the env-provided
// key exists but no superadmin ACCOUNT does — the web wizard is the only way
// to set the superadmin password (no --admin-password flag, R3).
function setupAdminLocked(db: Database): boolean {
  const apiKeyCount = (db.prepare("SELECT COUNT(*) c FROM api_keys").get() as { c: number }).c;
  const superadminCount = (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'superadmin'").get() as { c: number }).c;
  return getSetting(db, "setup_complete") === "1" ||
    ((db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c > 0) ||
    (apiKeyCount > 0 && superadminCount > 0);
}

// api-key minting / seed / complete lock like before: an instance configured
// entirely via env (LXK_ADMIN_EMAILS + a key) must not leave key minting open.
function setupLocked(db: Database): boolean {
  const adminEmails = (process.env.LXK_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const apiKeyCount = (db.prepare("SELECT COUNT(*) c FROM api_keys").get() as { c: number }).c;
  return getSetting(db, "setup_complete") === "1" ||
    ((db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c > 0) ||
    (apiKeyCount > 0 && adminEmails.length > 0);
}

const setupLive = HttpApiBuilder.group(LexaApi, "setup", (handlers) =>
  handlers
    .handle("status", () =>
      respond(Effect.gen(function* () {
        const db = yield* Sqlite;
        return setupStatus(db);
      }))
    )
    .handle("setAdmin", (req) =>
      respond(Effect.gen(function* () {
        const db = yield* Sqlite;
        if (setupAdminLocked(db)) return yield* Effect.fail(new SetupLocked());
        // Allow-list at provisioning only (Q12): when LXK_ADMIN_EMAILS is set,
        // only those emails may become superadmin; empty env = bootstrap (first
        // operator picks freely). Never written back to the setting — env-only.
        const allowlist = (process.env.LXK_ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        const email = req.payload.email.trim().toLowerCase();
        if (allowlist.length > 0 && !allowlist.includes(email)) {
          return yield* Effect.fail(new Forbidden({ message: "Email is not in the LXK_ADMIN_EMAILS allow-list" }));
        }
        const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | null;
        if (!existing) {
          yield* Effect.tryPromise(() =>
            auth.api.createUser({
              body: { email, password: req.payload.password, name: email.split("@")[0] || email, data: { role: "superadmin" } },
            })
          ).pipe(
            Effect.mapError(() => new Forbidden({ message: "Superadmin account creation failed" }))
          );
        }
        return { ok: true as const };
      }))
    )
    .handle("createApiKey", () =>
      respond(Effect.gen(function* () {
        const db = yield* Sqlite;
        if (setupLocked(db)) return yield* Effect.fail(new SetupLocked());
        const key = generateRawApiKey();
        const keyHash = createHash("sha256").update(key).digest("hex");
        db.prepare("INSERT INTO api_keys (id, name, key_hash) VALUES (?, ?, ?)").run(crypto.randomUUID(), "setup-wizard", keyHash);
        return { key };
      }))
    )
    .handle("seed", () =>
      respond(Effect.gen(function* () {
        const db = yield* Sqlite;
        if (setupLocked(db)) return yield* Effect.fail(new SetupLocked());
        const lxkEnv = process.env.LXK_ENV;
        if (lxkEnv && lxkEnv !== "dev") return { seeded: false as const };
        const seedFile = join(import.meta.dir, "../../scripts/seed-dev.sql");
        if (!existsSync(seedFile)) return { seeded: false as const };
        const projectCount = (db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c;
        if (projectCount > 0) return { seeded: false as const };
        db.exec(readFileSync(seedFile, "utf-8"));
        return { seeded: true as const };
      }))
    )
    .handle("complete", () =>
      respond(Effect.gen(function* () {
        const db = yield* Sqlite;
        if (setupLocked(db)) return yield* Effect.fail(new SetupLocked());
        setSetting(db, "setup_complete", "1");
        return { ok: true as const };
      }))
    )
);

const projectsLive = HttpApiBuilder.group(LexaApi, "projects", (handlers) =>
  handlers
    .handle("list", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ProjectService;
        const projects = yield* service.list();
        return { data: yield* Effect.forEach(projects, withRepos), nextCursor: null };
      }))
    )
    .handle("create", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ProjectService;
        const project = yield* service.create({
          name: req.payload.name, slug: req.payload.slug,
          description: req.payload.description,
        });
        return yield* withRepos(project);
      }))
    )
    .handle("getBySlug", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ProjectService;
        const project = yield* service.findBySlug(req.path.slug);
        return yield* withRepos(project);
      }))
    )
    .handle("setProjectTeam", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        const projectService = yield* ProjectService;
        const teams = yield* TeamsService;
        const authz = yield* AuthorizationService;
        yield* projectService.findById(req.path.projectId); // 404 oracle
        const teamId = req.payload.teamId;
        if (teamId === null) {
          // Unassigning = superadmin-only until assigned
          if (identity.role !== "admin") return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
        } else {
          const team = yield* teams.findById(teamId);
          if (!team) return yield* Effect.fail(new TeamNotFound({ teamId }));
          if (identity.role !== "admin") {
            if (!identity.userId) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
            const ok = yield* authz.canManageTeam(identity.userId, teamId);
            if (!ok) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
          }
        }
        const updated = yield* projectService.setTeam(req.path.projectId, teamId);
        return yield* withRepos(updated);
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
        yield* requireAdmin;
        const service = yield* ProjectService;
        const project = yield* service.update(req.path.slug, {
          name: req.payload.name,
          description: req.payload.description,
        });
        return yield* withRepos(project);
      }))
    )
    .handle("listRepos", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ProjectService;
        const repos = yield* service.listRepos(req.path.slug);
        return { data: repos };
      }))
    )
    .handle("listGithubIssues", (req) =>
      respond(Effect.gen(function* () {
        const githubService = yield* GitHubService;
        const params = searchParams(req);
        const repo = params.get("repo") ?? "";
        if (!repo) {
          return yield* Effect.fail(new GithubApiError({ message: "repo query param is required (owner/name)" }));
        }
        const issues = yield* githubService.listWorkspaceIssues(req.path.slug, repo, params.get("q") ?? "");
        return { data: issues };
      }))
    )
    .handle("replaceRepos", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ProjectService;
        const repos = yield* service.replaceRepos(
          req.path.slug,
          req.payload.repos.map((r) => ({ repo: r.repo, sourceRole: r.sourceRole, workspaceRole: r.workspaceRole }))
        );
        return { data: repos };
      }))
    )
    .handle("deleteProject", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
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
        yield* requireAdmin;
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
        yield* requireAdmin;
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
        yield* requireAdmin;
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
        const swimlanes = yield* swimlaneService.findByProject(project.id, { includeArchived: true });
        return { data: swimlanes.map(formatSwimlane) };
      }))
    )
    .handle("createSwimlane", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const projectService = yield* ProjectService;
        const swimlaneService = yield* SwimlaneService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const swimlane = yield* swimlaneService.create({
          projectId: project.id, name: req.payload.name, description: req.payload.description,
          dueAt: req.payload.dueAt, startAt: req.payload.startAt, milestoneId: req.payload.milestoneId,
        });
        return formatSwimlane(swimlane);
      }))
    )
    .handle("updateSwimlane", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const swimlaneService = yield* SwimlaneService;
        const swimlane = yield* swimlaneService.update(req.path.id, {
          name: req.payload.name, description: req.payload.description, position: req.payload.position,
          dueAt: req.payload.dueAt, startAt: req.payload.startAt, milestoneId: req.payload.milestoneId,
        });
        return formatSwimlane(swimlane);
      }))
    )
    .handle("deleteSwimlane", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const swimlaneService = yield* SwimlaneService;
        yield* swimlaneService.delete(req.path.id);
        return undefined;
      }))
    )
    .handle("archiveSwimlane", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const swimlaneService = yield* SwimlaneService;
        const identity = yield* AuthIdentity;
        const result = yield* swimlaneService.archive(actorFromIdentity(identity), req.path.id);
        return { data: formatSwimlane(result.lane), activity: activityPayload(result.activity) };
      }))
    )
    .handle("restoreSwimlane", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const swimlaneService = yield* SwimlaneService;
        const identity = yield* AuthIdentity;
        const result = yield* swimlaneService.restore(actorFromIdentity(identity), req.path.id);
        return { data: formatSwimlane(result.lane), activity: activityPayload(result.activity) };
      }))
    )
);

const milestonesLive = HttpApiBuilder.group(LexaApi, "milestones", (handlers) =>
  handlers
    .handle("listMilestones", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const milestoneService = yield* MilestoneService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const milestones = yield* milestoneService.findByProject(project.id, { includeArchived: true });
        return { data: milestones.map(formatMilestone) };
      }))
    )
    .handle("createMilestone", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const projectService = yield* ProjectService;
        const milestoneService = yield* MilestoneService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const milestone = yield* milestoneService.create({
          projectId: project.id, name: req.payload.name, description: req.payload.description, dueAt: req.payload.dueAt,
        });
        return formatMilestone(milestone);
      }))
    )
    .handle("updateMilestone", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const milestoneService = yield* MilestoneService;
        const milestone = yield* milestoneService.update(req.path.id, {
          name: req.payload.name, description: req.payload.description, position: req.payload.position, dueAt: req.payload.dueAt,
        });
        return formatMilestone(milestone);
      }))
    )
    .handle("deleteMilestone", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const milestoneService = yield* MilestoneService;
        yield* milestoneService.delete(req.path.id);
        return undefined;
      }))
    )
    .handle("archiveMilestone", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const milestoneService = yield* MilestoneService;
        const identity = yield* AuthIdentity;
        const result = yield* milestoneService.archive(actorFromIdentity(identity), req.path.id);
        return { data: formatMilestone(result.milestone), activity: activityPayload(result.activity) };
      }))
    )
    .handle("restoreMilestone", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const milestoneService = yield* MilestoneService;
        const identity = yield* AuthIdentity;
        const result = yield* milestoneService.restore(actorFromIdentity(identity), req.path.id);
        return { data: formatMilestone(result.milestone), activity: activityPayload(result.activity) };
      }))
    )
);

const fieldConfigLive = HttpApiBuilder.group(LexaApi, "field-config", (handlers) =>  handlers
    .handle("getFieldConfig", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* FieldConfigService;
        const project = yield* projectService.findBySlug(req.path.slug);
        return yield* service.findByProject(project.id);
      }))
    )
    .handle("putFieldConfig", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const projectService = yield* ProjectService;
        const service = yield* FieldConfigService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const config = yield* service.replace(project.id, {
          priorities: req.payload.priorities.map((o, i) => ({
            id: o.id ?? "",
            label: o.label,
            color: o.color ?? "#6b7280",
            position: o.position ?? i,
          })),
          types: req.payload.types.map((o, i) => ({
            id: o.id ?? "",
            label: o.label,
            color: o.color ?? "#6b7280",
            position: o.position ?? i,
          })),
        });
        return config;
      }))
    )
);

const forgeLive = HttpApiBuilder.group(LexaApi, "forge", (handlers) =>
  handlers
    .handle("registerRuntime", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const runtime = yield* service.registerRuntime({
          id: req.payload.id,
          name: req.payload.name,
          provider: req.payload.provider,
          machineId: req.payload.machineId,
          teamId: req.payload.teamId ?? null,
          agent: req.payload.agent?.trim() || "build",
          model: req.payload.model?.trim() || "",
          hostname: req.payload.hostname ?? "",
        });
        // Successful registration proves the daemon's credential works —
        // clear any previously reported failure.
        yield* service.clearRuntimeLastError(runtime.id);
        return runtime;
      }))
    )
    .handle("updateRuntime", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        return yield* service.updateRuntime(req.path.id, {
          ...(req.payload.name !== undefined ? { name: req.payload.name } : {}),
          ...(req.payload.provider !== undefined ? { provider: req.payload.provider } : {}),
          ...(req.payload.agent !== undefined ? { agent: req.payload.agent } : {}),
          ...(req.payload.model !== undefined ? { model: req.payload.model } : {}),
          ...(req.payload.printLogs !== undefined ? { printLogs: req.payload.printLogs } : {}),
          ...(req.payload.logLevel !== undefined ? { logLevel: req.payload.logLevel } : {}),
          ...(req.payload.extraArgs !== undefined ? { extraArgs: [...req.payload.extraArgs] } : {}),
        });
      }))
    )
    .handle("removeRuntime", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const eventService = yield* RuntimeEventService;
        const runtime = yield* service.getRuntimeConfig(req.path.id);
        // Never blocks on machine state: the remove event is delivered
        // whenever the machine's listener next heartbeats. Runtimes without
        // a machine have nothing to notify — delete directly.
        if (runtime.machineId) {
          yield* eventService.createRemove({ machineId: runtime.machineId, agentCli: runtime.provider });
          // Remove events are provider-scoped; a machine hosts at most one
          // runtime per agent CLI — remove the whole pair.
          yield* service.removeRuntimePair(runtime.machineId, runtime.provider);
        } else {
          yield* service.removeRuntime(req.path.id);
        }
        return undefined;
      }))
    )
    .handle("heartbeat", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        yield* service.heartbeat(req.payload.runtimeId);
        // A live heartbeat proves the credential works — clear any
        // previously reported auth failure.
        yield* service.clearRuntimeLastError(req.payload.runtimeId);
        return { ok: true as const };
      }))
    )
    .handle("claimTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const task = yield* service.claimNext(req.payload.runtimeId);
        if (!task) return { task: null, provider: "opencode" as const, agent: "", model: "", printLogs: false, logLevel: "", extraArgs: [], prompt: "", agentMarkdown: "", skillMarkdown: "", skillIds: [], repoContent: [], runtimeSessionId: null, agentId: "", skillId: "" };
        const runtime = yield* service.getRuntimeConfig(req.payload.runtimeId);
        // Warm-session verdict: continue the mapped runtime session only when
        // its agent/skill match the task's — otherwise null (daemon mints).
        const runtimeSessionId = yield* service.resolveSessionForTask(task, req.payload.runtimeId);
        // Best-effort linked-repo content (Contents: Read) — assembled BEFORE
        // the prompt so the prompt can point the agent at repo-content/.
        const repoContent = yield* loadTaskRepoContent(task);
        // Server-authoritative prompt (resolves linked sources, enforces
        // output rules). If source resolution fails, fall back to the
        // daemon's local minimal build rather than blocking the claim.
        const prompt = yield* service.buildPromptForTask(task, repoContent.length > 0).pipe(
          Effect.catchAll(() => Effect.succeed(""))
        );
        // Claim-carried rule files: the daemon writes these into the run dir
        // as AGENTS.md + .agents/<skill>/SKILL.md before spawning the CLI.
        const { rules, skillIds } = yield* Effect.all({
          rules: service.resolveRules(task).pipe(
            Effect.map((r) => ({ agentMarkdown: r.agent.instructions, skillMarkdown: r.skill.instructions })),
            Effect.catchAll(() => Effect.succeed({ agentMarkdown: "", skillMarkdown: "" }))
          ),
          skillIds: service.listSkills().pipe(
            Effect.map((s) => s.map((x) => x.id)),
            Effect.catchAll(() => Effect.succeed([] as string[]))
          ),
        });
        return { task, provider: runtime.provider, agent: runtime.agent, model: runtime.model, printLogs: runtime.printLogs, logLevel: runtime.logLevel, extraArgs: runtime.extraArgs, prompt, agentMarkdown: rules.agentMarkdown, skillMarkdown: rules.skillMarkdown, skillIds, repoContent, runtimeSessionId, agentId: task.agentId, skillId: task.skillId };
      }))
    )
    // Runtime setup events — the CLI listener claims these over the same
    // poll pattern the daemon uses for tasks.
    .handle("createRuntimeEvent", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeEventService;
        return yield* service.create({
          machineId: req.payload.machineId,
          action: req.payload.action,
          agentCli: req.payload.agentCli,
          apiKeyId: req.payload.apiKeyId,
          rawKey: req.payload.rawKey,
        });
      }))
    )
    .handle("claimRuntimeEvent", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeEventService;
        return yield* service.claimForMachine(req.payload.machineId, req.request.headers["x-machine-secret"] ?? "");
      }))
    )
    .handle("completeRuntimeEvent", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeEventService;
        return yield* service.complete(req.path.id);
      }))
    )
    .handle("failRuntimeEvent", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeEventService;
        return yield* service.fail(req.path.id, req.payload.error);
      }))
    )
    .handle("getRuntimeEvent", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeEventService;
        return yield* service.getById(req.path.id);
      }))
    )
    .handle("listRuntimeEvents", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeEventService;
        const q = searchParams(req);
        const events = yield* service.list(q.get("machineId") ?? undefined);
        return { data: events };
      }))
    )
    .handle("machineHeartbeat", (req) =>
      respond(Effect.gen(function* () {
        const machineService = yield* RuntimeMachineService;
        const forgeService = yield* ForgeService;
        const projectService = yield* ProjectService;
        const machine = yield* machineService.heartbeat({
          id: req.payload.id,
          hostname: req.payload.hostname ?? "",
          clis: req.payload.clis ? req.payload.clis.map((c) => ({ provider: c.provider, version: c.version })) : undefined,
        });
        if (req.payload.runtimes) {
          yield* forgeService.syncCatalogs(req.payload.id, req.payload.runtimes.map((catalog) => ({
            runtimeId: catalog.runtimeId,
            agentCli: catalog.agentCli,
            models: [...catalog.models],
            agents: [...catalog.agents],
          })));
        }
        if (req.payload.daemonErrors) {
          // The daemon died with a reportable failure (e.g. revoked API key,
          // exit code 3). The listener has valid auth, so it relays on the
          // machine's behalf — the runtime row surfaces it as lastError.
          yield* forgeService.reportDaemonErrors([...req.payload.daemonErrors]);
        }
        // Stuck-task sweep: runs while any machine listens (3s cadence) —
        // the only case where a re-claim is possible. Re-queues 'running'
        // tasks whose runtime has been offline > 10 min, and hard-deletes
        // stale 'running' runs (started > FORGE_STALE_RUN_MIN, runtime
        // offline/gone — the runner is dead and will never complete).
        const swept = yield* forgeService.sweepStalledTasks();
        if (swept > 0) {
          console.log(`[forge-sweep] ${swept} stale task(s) re-queued or removed`);
        }
        const projects = yield* projectService.list();
        return { ...machine, projects: projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug, description: p.description })) };
      }))
    )
    .handle("registerMachine", (req) =>
      respond(Effect.gen(function* () {
        const machineService = yield* RuntimeMachineService;
        return yield* machineService.register({
          id: req.payload.id,
          hostname: req.payload.hostname,
          secret: req.payload.secret,
        });
      }))
    )
    .handle("removeMachine", (req) =>
      respond(Effect.gen(function* () {
        const machineService = yield* RuntimeMachineService;
        yield* machineService.delete(req.path.id);
        return undefined;
      }))
    )
    .handle("listMachines", () =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeMachineService;
        const machines = yield* service.list();
        return { data: machines };
      }))
    )
    .handle("listRuntimes", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        const service = yield* ForgeService;
        let runtimes = yield* service.listRuntimes();
        // Team gating: team admin sees own-team + global runtimes; keys and
        // superadmin sessions see all. ?teamId= narrows the result.
        const teamFilter = searchParams(req).get("teamId");
        if (identity.role !== "admin") {
          if (!identity.userId) return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
          const authz = yield* AuthorizationService;
          const visible: (typeof runtimes)[number][] = [];
          for (const r of runtimes) {
            if (r.teamId === null || (yield* authz.isTeamAdmin(identity.userId, r.teamId))) visible.push(r);
          }
          runtimes = visible;
        }
        if (teamFilter) {
          runtimes = runtimes.filter((r) => r.teamId === teamFilter);
        }
        return { data: runtimes };
      }))
    )
    .handle("createForgeTask", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* ForgeService;
        const project = yield* projectService.findBySlug(req.payload.slug);
        const task = yield* service.create({
          projectId: project.id,
          documentType: req.payload.documentType,
          documentId: req.payload.documentId,
          agentId: req.payload.agentId,
          skillId: req.payload.skillId,
          extraPrompt: req.payload.extraPrompt ?? "",
          selection: req.payload.selection ?? "",
          runtimeId: req.payload.runtimeId,
        });
        return task;
      }))
    )
    .handle("getForgeTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        return yield* service.getById(req.path.id);
      }))
    )
    .handle("listForgeTasks", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* ForgeService;
        const q = searchParams(req);
        const slug = q.get("slug");
        if (!slug) return yield* Effect.fail(ProjectNotFound);
        const project = yield* projectService.findBySlug(slug);
        const documentType = (q.get("documentType") ?? "task") as "task" | "wiki";
        const documentId = q.get("documentId") ?? "";
        const tasks = yield* service.listForDocument(project.id, documentType, documentId);
        return { data: tasks };
      }))
    )
    .handle("listRecentForgeTasks", () =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const tasks = yield* service.listRecent(10);
        return { data: tasks };
      }))
    )
    .handle("listForgeTaskHistory", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* ForgeService;
        const q = searchParams(req);
        const slug = q.get("slug") ?? undefined;
        const project = slug ? yield* projectService.findBySlug(slug) : null;
        const status = q.get("status");
        const skillId = q.get("skillId") ?? undefined;
        const documentType = q.get("documentType");
        const statuses = new Set(["queued", "running", "completed", "failed", "cancelled"]);
        const limitRaw = Number(q.get("limit") ?? 50);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
        const result = yield* service.listHistory(
          {
            projectId: project?.id,
            status: status && statuses.has(status) ? (status as "queued" | "running" | "completed" | "failed" | "cancelled") : undefined,
            skillId,
            documentType: documentType === "task" || documentType === "wiki" ? documentType : undefined,
          },
          limit,
          q.get("cursor") ?? undefined
        );
        return { data: result.tasks, nextCursor: result.nextCursor, summary: result.summary };
      }))
    )
    .handle("completeForgeTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        return yield* service.complete(req.path.id, req.payload.result);
      }))
    )
    .handle("getDaemonTaskStatus", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const task = yield* service.getById(req.path.id);
        return { status: task.status };
      }))
    )
    .handle("failForgeTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        return yield* service.fail(req.path.id, req.payload.error);
      }))
    )
    .handle("cancelForgeTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        return yield* service.cancel(req.path.id);
      }))
    )
    .handle("listForgeTaskLogs", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const logs = yield* service.listLogs(req.path.id);
        return { data: logs };
      }))
    )
    .handle("appendForgeTaskLog", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        return yield* service.appendLog(req.path.id, req.payload.message, req.payload.stream ?? "out", req.payload.level ?? "info");
      }))
    )
    .handle("listForgeAgents", () =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const agents = yield* service.listAgents();
        return { data: agents };
      }))
    )
    .handle("createForgeAgent", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        return yield* service.createAgent(req.payload);
      }))
    )
    .handle("updateForgeAgent", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        return yield* service.updateAgent(req.path.id, req.payload);
      }))
    )
    .handle("deleteForgeAgent", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        yield* service.deleteAgent(req.path.id);
        return undefined;
      }))
    )
    .handle("replaceAgentSkills", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        return yield* service.replaceAgentSkills(req.path.id, [...req.payload.skillIds]);
      }))
    )
    .handle("resetForgeAgent", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        return yield* service.resetAgentToDefault(req.path.id);
      }))
    )
    .handle("listForgeSkills", () =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const skills = yield* service.listSkills();
        return { data: skills };
      }))
    )
    .handle("createForgeSkill", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        return yield* service.createSkill(req.payload);
      }))
    )
    .handle("updateForgeSkill", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        return yield* service.updateSkill(req.path.id, req.payload);
      }))
    )
    .handle("deleteForgeSkill", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        yield* service.deleteSkill(req.path.id);
        return undefined;
      }))
    )
    .handle("resetForgeSkill", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ForgeService;
        return yield* service.resetSkillToDefault(req.path.id);
      }))
    )
    .handle("listSources", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* SourceService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const sources = yield* service.findByDocument(project.id, req.path.type, req.path.id);
        return { data: sources };
      }))
    )
    .handle("addSource", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* SourceService;
        const identity = yield* AuthIdentity;
        const project = yield* projectService.findBySlug(req.path.slug);
        const { source, activity } = yield* service.add(actorFromIdentity(identity), {
          projectId: project.id,
          documentType: req.path.type,
          documentId: req.path.id,
          kind: req.payload.kind,
          ref: req.payload.ref,
        });
        return { data: source, activity: activityPayload(activity) };
      }))
    )
    .handle("removeSource", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* SourceService;
        const identity = yield* AuthIdentity;
        yield* service.remove(actorFromIdentity(identity), req.path.sourceId);
        return undefined;
      }))
    )
    .handle("listForgeSessions", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const q = searchParams(req);
        const documentType = q.get("documentType");
        const documentId = q.get("documentId");
        // Sessions are document-agnostic metadata; missing refs are just an
        // empty list (never 404).
        if (documentType !== "task" && documentType !== "wiki") return { data: [] };
        if (!documentId) return { data: [] };
        return { data: yield* service.forgeSessionList(documentType, documentId) };
      }))
    )
    .handle("upsertForgeSession", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        yield* service.forgeSessionUpsert(req.payload);
        return undefined;
      }))
    )
    .handle("removeForgeSession", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        yield* service.forgeSessionRemove(req.payload.documentType, req.payload.documentId, req.payload.runtimeId);
        return undefined;
      }))
    )
    .handle("resetForgeSession", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        yield* service.forgeSessionReset(req.payload.documentType, req.payload.documentId, req.payload.runtimeId);
        return undefined;
      }))
    )
);

const taskLinksLive = HttpApiBuilder.group(LexaApi, "task-links", (handlers) =>
  handlers
    .handle("listTaskLinks", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* TaskLinkService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const links = yield* service.findByTask(project.id, req.path.id);
        return { data: links };
      }))
    )
    .handle("addTaskLink", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* TaskLinkService;
        const identity = yield* AuthIdentity;
        const project = yield* projectService.findBySlug(req.path.slug);
        const { link, activity } = yield* service.add(actorFromIdentity(identity), {
          projectId: project.id,
          fromTaskId: req.path.id,
          toTaskId: req.payload.toTaskId,
          relation: req.payload.relation,
        });
        return { data: link, activity: activityPayload(activity) };
      }))
    )
    .handle("removeTaskLink", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* TaskLinkService;
        const identity = yield* AuthIdentity;
        yield* service.remove(actorFromIdentity(identity), req.path.linkId);
        return undefined;
      }))
    )
    .handle("searchTasks", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const service = yield* TaskLinkService;
        const project = yield* projectService.findBySlug(req.path.slug);
        const q = searchParams(req).get("q") ?? "";
        const exclude = searchParams(req).get("exclude") ?? "";
        const suggestions = yield* service.search(project.id, q, exclude);
        return { data: suggestions };
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
        const q = searchParams(req);
        const limit = clampLimit(q.get("limit"));
        const cursor = q.get("cursor") ?? undefined;
        const filters = {
          columnId: q.get("columnId") ?? undefined,
          swimlaneId: q.get("swimlaneId") ?? undefined,
          assignee: q.get("assignee") ?? undefined,
          type: q.get("type") ?? undefined,
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
        const identity = yield* AuthIdentity;
        const project = yield* projectService.findBySlug(req.path.slug);
        const { task, activity } = yield* taskService.create(actorFromIdentity(identity), {
          projectId: project.id, columnId: req.payload.columnId,
          swimlaneId: req.payload.swimlaneId, title: req.payload.title,
          description: req.payload.description, priority: req.payload.priority,
          type: req.payload.type, parentId: req.payload.parentId,
          assignees: req.payload.assignees ? [...req.payload.assignees] : undefined,
          dueAt: req.payload.dueAt,
        });
        return { data: formatTask(task), activity: activityPayload(activity) };
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
        const githubService = yield* GitHubService;
        const identity = yield* AuthIdentity;
        const { task, activity } = yield* taskService.update(actorFromIdentity(identity), req.path.id, {
          title: req.payload.title, description: req.payload.description,
          priority: req.payload.priority, type: req.payload.type,
          assignees: req.payload.assignees ? [...req.payload.assignees] : undefined,
          dueAt: req.payload.dueAt,
        });
        if (task.githubs.length > 0) {
          // Best-effort content push (title+body → all linked issues). The
          // service diffs against the last pushed values, so a save that only
          // changed priority/type/assignees is a no-op. Non-blocking: a GitHub
          // failure never fails the update.
          yield* githubService.syncContentFromLexa(task.id).pipe(
            Effect.catchTag("DbError", (e) => Effect.logWarning(`[GitHub] content sync failed for task ${task.id}`, e)),
            Effect.catchTag("ConstraintViolation", (e) => Effect.logWarning(`[GitHub] content sync failed for task ${task.id}`, e))
          );
          // Re-fetch so the mutation response carries the fresh divergence
          // flags (pushFailed) — the response is the authoritative cache.
          const fresh = yield* taskService.getById(task.id);
          return { data: formatTask(fresh), activity: activityPayload(activity) };
        }
        return { data: formatTask(task), activity: activityPayload(activity) };
      }))
    )
    .handle("moveTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const columnService = yield* ColumnService;
        const githubService = yield* GitHubService;
        const identity = yield* AuthIdentity;
        const { task, activity } = yield* taskService.move(actorFromIdentity(identity), req.path.id, {
          columnId: req.payload.columnId, swimlaneId: req.payload.swimlaneId,
          beforeTaskId: req.payload.beforeTaskId, afterTaskId: req.payload.afterTaskId,
          clearDueAt: req.payload.clearDueAt,
        });
        const column = yield* columnService.getById(req.payload.columnId);
        if (column.githubState && task.githubs.length > 0) {
          // Best-effort, non-blocking: a GitHub failure never fails the move
          // (the move already committed — failing here would make clients
          // retry and risk double work; echo suppression makes a re-sync
          // idempotent). Log and skip.
          yield* githubService.syncStateFromLexa(task.id, column.githubState).pipe(
            Effect.catchTag("GithubApiError", (e) => Effect.logWarning(`[GitHub] sync failed for task ${task.id}`, e)),
            Effect.catchTag("DbError", (e) => Effect.logWarning(`[GitHub] sync failed for task ${task.id}`, e)),
            Effect.catchTag("ConstraintViolation", (e) => Effect.logWarning(`[GitHub] sync failed for task ${task.id}`, e))
          );
        }
        return { data: formatTask(task), activity: activityPayload(activity) };
      }))
    )
    .handle("deleteTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const identity = yield* AuthIdentity;
        yield* taskService.delete(actorFromIdentity(identity), req.path.id);
        return undefined;
      }))
    )
    .handle("archiveTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const identity = yield* AuthIdentity;
        const { task, activity } = yield* taskService.archive(actorFromIdentity(identity), req.path.id);
        return { data: formatTask(task), activity: activityPayload(activity) };
      }))
    )
    .handle("restoreTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const identity = yield* AuthIdentity;
        const { task, activity } = yield* taskService.restore(actorFromIdentity(identity), req.path.id);
        return { data: formatTask(task), activity: activityPayload(activity) };
      }))
    )
    .handle("taskActivity", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const activityService = yield* ActivityService;
        yield* projectService.findBySlug(req.path.slug);
        const q = searchParams(req);
        const limit = clampLimit(q.get("limit"));
        const page = yield* activityService.listMerged(req.path.id, q.get("cursor") ?? null, limit);
        return { data: page.items, nextCursor: page.nextCursor };
      }))
    )
    .handle("createComment", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        const commentService = yield* CommentService;
        const projectService = yield* ProjectService;
        yield* projectService.findBySlug(req.path.slug);
        const result = yield* commentService.create(req.path.id, actorFromIdentity(identity), req.payload.body);
        return {
          data: {
            comment: { kind: "comment" as const, ...result.comment },
            activity: { kind: "event" as const, ...result.activity },
          },
        };
      }))
    )
    .handle("updateComment", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        const commentService = yield* CommentService;
        const comment = yield* commentService.edit(req.path.commentId, identity, req.payload.body);
        return { data: { kind: "comment" as const, ...comment } };
      }))
    )
    .handle("deleteComment", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        const commentService = yield* CommentService;
        const taskRepo = yield* TaskRepo;
        const task = yield* taskRepo.findById(req.path.id).pipe(
          Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: req.path.id }))
        );
        yield* commentService.remove(req.path.commentId, identity, task.projectId);
        return undefined;
      }))
    )
    .handle("linkGithubIssue", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const taskService = yield* TaskService;
        const githubService = yield* GitHubService;
        const identity = yield* AuthIdentity;
        yield* projectService.findBySlug(req.path.slug);
        const linked = yield* githubService.createLinkedIssue(actorFromIdentity(identity), req.path.id, req.payload.repo);
        const task = yield* taskService.getById(req.path.id);
        return { data: formatTask(task), activity: activityPayload(linked.activity) };
      }))
    )
    .handle("linkExistingGithubIssue", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const taskService = yield* TaskService;
        const githubService = yield* GitHubService;
        const identity = yield* AuthIdentity;
        yield* projectService.findBySlug(req.path.slug);
        const linked = yield* githubService.linkExistingIssue(actorFromIdentity(identity), req.path.id, req.payload.repo, req.payload.issueNumber);
        const task = yield* taskService.getById(req.path.id);
        return { data: formatTask(task), activity: activityPayload(linked.activity) };
      }))
    )
    .handle("unlinkGithubIssue", (req) =>
      respond(Effect.gen(function* () {
        const projectService = yield* ProjectService;
        const taskService = yield* TaskService;
        const taskRepo = yield* TaskRepo;
        const activityService = yield* ActivityService;
        const identity = yield* AuthIdentity;
        yield* projectService.findBySlug(req.path.slug);
        const task = yield* taskService.getById(req.path.id);
        const issue = task.githubs.find((g) => g.issueId === req.path.issueId);
        const db = yield* Sqlite;
        // Does NOT close or delete the GitHub issue.
        const ev = yield* withTx(db, Effect.gen(function* () {
          yield* taskRepo.unlinkGithubIssue(req.path.id, req.path.issueId);
          if (issue) {
            // Handler-level emission — the unlink lives in the route, not a
            // service (documented deviation: services-only rule).
            return yield* activityService.append(req.path.id, actorFromIdentity(identity), "github_unlinked",
              msg.githubUnlinked(issue.repo, issue.issueNumber));
          }
          return null;
        }));
        const updated = yield* taskService.getById(req.path.id);
        return { data: formatTask(updated), activity: ev ? activityPayload([ev]) : [] };
      }))
    )
    .handle("createTaskFromIssue", (req) =>
      respond(Effect.gen(function* () {
        const githubService = yield* GitHubService;
        const identity = yield* AuthIdentity;
        const { taskId, activity } = yield* githubService.createTaskFromIssue(
          actorFromIdentity(identity),
          req.path.slug,
          req.payload.repo,
          req.payload.issueNumber
        );
        const taskService = yield* TaskService;
        const task = yield* taskService.getById(taskId);
        return { data: formatTask(task), activity: activityPayload(activity) };
      }))
    )
);

const boardLive = HttpApiBuilder.group(LexaApi, "board", (handlers) =>
  handlers.handle("getBoard", (req) =>
    respond(Effect.gen(function* () {
      const projectService = yield* ProjectService;
      const columnService = yield* ColumnService;
      const swimlaneService = yield* SwimlaneService;
      const milestoneService = yield* MilestoneService;
      const taskService = yield* TaskService;
      const fieldConfigService = yield* FieldConfigService;
      const taskLinkRepo = yield* TaskLinkRepo;
      const project = yield* projectService.findBySlug(req.path.slug);
      const includeArchived = searchParams(req).get("includeArchived") === "true";
      const columns = yield* columnService.findByProject(project.id);
      const swimlanes = yield* swimlaneService.findByProject(project.id, { includeArchived });
      const milestones = yield* milestoneService.findByProject(project.id, { includeArchived });
      const fieldConfig = yield* fieldConfigService.findByProject(project.id);
      const links = yield* taskLinkRepo.findByProject(project.id);
      const tasks = yield* taskService.findAllByProject(project.id, { includeArchived });
      return {
        project: yield* withRepos(project),
        columns: columns.map(formatColumn),
        swimlanes: swimlanes.map(formatSwimlane),
        milestones: milestones.map(formatMilestone),
        fieldConfig,
        links,
        tasks: tasks.map(formatTask),
      };
    }))
  )
);

const dashboardLive = HttpApiBuilder.group(LexaApi, "dashboard", (handlers) =>
  handlers.handle("getDashboard", () =>
    respond(Effect.gen(function* () {
      const service = yield* DashboardService;
      const dash = yield* service.getDashboard();
      // The shared ProjectHealth type is team-free; the wire Project carries
      // teamId (the domain project already has it from the row mapping).
      return {
        ...dash,
        projects: dash.projects.map((ph) => ({
          ...ph,
          project: { ...ph.project, teamId: (ph.project as unknown as { teamId?: string | null }).teamId ?? null },
        })),
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
        const q = searchParams(req).get("q");
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
        const q = searchParams(req);
        const limit = q.get("limit") ? clampLimit(q.get("limit")!) : undefined;
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
        yield* requireAdmin;
        const service = yield* ApiKeyService;
        const keys = yield* service.list();
        return { data: keys };
      }))
    )
    .handle("createApiKey", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ApiKeyService;
        const result = yield* service.create(req.payload.name);
        return result;
      }))
    )
    .handle("deleteApiKey", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* ApiKeyService;
        yield* service.delete(req.path.id);
        return undefined;
      }))
    )
    .handle("getRateLimit", () =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const db = yield* Sqlite;
        return {
          ...resolveRateLimitFromDbValues({
            settingsMax: getSetting(db, "rate_limit_max"),
            settingsWindowMs: getSetting(db, "rate_limit_window_ms"),
          }),
          envOverride: false,
        };
      }))
    )
    .handle("setRateLimit", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const { max, windowMs } = req.payload;
        if (max === undefined || windowMs === undefined) {
          return yield* Effect.fail(new InvalidRateLimit({ reason: "max and windowMs are required" }));
        }
        if (!Number.isInteger(max) || max < 1) {
          return yield* Effect.fail(new InvalidRateLimit({ reason: "max must be a positive integer" }));
        }
        if (!Number.isInteger(windowMs) || windowMs < 1000) {
          return yield* Effect.fail(new InvalidRateLimit({ reason: "windowMs must be an integer >= 1000" }));
        }
        const db = yield* Sqlite;
        setSetting(db, "rate_limit_max", String(max));
        setSetting(db, "rate_limit_window_ms", String(windowMs));
        syncRateLimitFromDb(db);
        return {
          ...resolveRateLimitFromDbValues({ settingsMax: String(max), settingsWindowMs: String(windowMs) }),
          envOverride: false,
        };
      }))
    )
    .handle("getGithubSettings", () =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const db = yield* Sqlite;
        return githubSettingsResponse(db);
      }))
    )
    .handle("setGithubSettings", (req) =>      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const { appId, privateKey, webhookSecret } = req.payload;
        // Present field = replace; empty string = CLEAR (delete the row → not
        // configured at runtime; env re-imports only at the next boot);
        // omitted = unchanged (appId is required in the body). Non-empty
        // values validate.
        if (appId === undefined) {
          return yield* Effect.fail(new InvalidGithubSettings({ reason: "appId is required" }));
        }
        if (appId.trim() !== "" && !/^\d+$/.test(appId.trim())) {
          return yield* Effect.fail(new InvalidGithubSettings({ reason: "appId must be a GitHub App ID (digits only)" }));
        }
        if (privateKey !== undefined && privateKey.trim() !== "" && !privateKey.includes("-----BEGIN")) {
          return yield* Effect.fail(new InvalidGithubSettings({ reason: "privateKey must be a PEM starting with -----BEGIN" }));
        }
        const db = yield* Sqlite;
        if (appId.trim() === "") deleteSetting(db, "github_app_id");
        else setSetting(db, "github_app_id", appId.trim());
        if (privateKey !== undefined) {
          if (privateKey.trim() === "") deleteSetting(db, "github_private_key");
          else setSetting(db, "github_private_key", privateKey);
        }
        if (webhookSecret !== undefined) {
          if (webhookSecret.trim() === "") deleteSetting(db, "github_webhook_secret");
          else setSetting(db, "github_webhook_secret", webhookSecret.trim());
        }
        syncGitHubConfigFromDb(db);
        resetGithubCaches();
        return githubSettingsResponse(db);
      }))
    )
    .handle("searchGithubRepos", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const params = searchParams(req);
        const q = (params.get("q") ?? "").trim();
        if (!q) return { data: [] };
        const client = yield* GitHubClient;
        const repos = yield* client.searchRepos(q);
        return { data: repos };
      }))
    )
);

const adminLive = HttpApiBuilder.group(LexaApi, "admin", (handlers) =>
  handlers
    .handle("listUsers", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* UserService;
        const users = yield* service.list();
        return { data: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, lastSeen: u.last_seen })) };
      }))
    )
    .handle("listUserProjectRoles", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
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
        yield* requireAdmin;
        const service = yield* UserProjectRoleService;
        const projectRepo = yield* ProjectRepo;
        yield* service.setRole(req.path.id, req.payload.projectId, req.payload.role);
        const project = yield* projectRepo.findById(req.payload.projectId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        );
        return { projectId: req.payload.projectId, projectSlug: project ? (project as any).slug : "unknown", role: req.payload.role };
      }))
    )
    .handle("removeUserProjectRole", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const service = yield* UserProjectRoleService;
        yield* service.removeAccess(req.path.id, req.path.projectId);
        return undefined;
      }))
    )
);

// Self-service profile: the acting user comes from the session cookie (or a
// key-bound user), resolved by the middleware into AuthIdentity.userId. Bare
// API keys have no user context — agents have no profile to edit.
const meLive = HttpApiBuilder.group(LexaApi, "me", (handlers) =>
  handlers
    .handle("updateMe", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) {
          return yield* Effect.fail(new NoUserContext());
        }
        const name = req.payload.name.trim();
        if (name.length === 0 || name.length > 80) {
          return yield* Effect.fail(new InvalidName({ reason: "Name must be 1-80 characters" }));
        }
        const service = yield* UserService;
        const user = yield* service.updateName(identity.userId, name);
        return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.created_at, lastSeen: user.last_seen };
      }))
    )
);

function withRepos(p: DomainProject): Effect.Effect<Project & { teamId: string | null }, DbError, ProjectReposRepo> {
  return Effect.gen(function* () {
    const reposRepo = yield* ProjectReposRepo;
    const repos = yield* reposRepo.listByProject(p.id);
    return { ...p, repos, teamId: (p as unknown as { teamId?: string | null }).teamId ?? null };
  });
}

function formatColumn(c: { id: string; projectId: string; name: string; position: number; color: string; wipLimit: number | null; requiredFields: string[]; githubState: "open" | "closed" | null }) {
  return c as any;
}

function formatSwimlane(s: { id: string; projectId: string; name: string; description: string; position: number }) {
  return s as any;
}

function formatMilestone(m: { id: string; projectId: string; name: string; description: string; position: number; dueAt: string | null; archivedAt: string | null; sprintCount: number; archivedSprintCount: number }) {
  return m as any;
}

function formatTask(t: { id: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: any; priority: string; type: string; assignees: string[]; position: string; githubs: any[]; createdAt: string; updatedAt: string }) {
  return t as any;
}

// The response schema requires the kind discriminator; service results are
// plain ActivityEvent (no kind). Added here, at the API boundary.
function activityPayload(events: ActivityEvent[]) {
  return events.map((a) => ({ kind: "event" as const, ...a }));
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
  db.exec("PRAGMA busy_timeout = 5000");
  const dbLayer = Layer.succeed(Sqlite, db);

  const serviceLayer = buildServiceLayer();
  const handlerLayer = Layer.mergeAll(
    healthLive, setupLive, projectsLive, columnsLive, swimlanesLive, milestonesLive, fieldConfigLive, forgeLive, taskLinksLive, tasksLive, boardLive, wikiLive, apiKeysLive, adminLive, meLive, dashboardLive,
    createTeamsLive(LexaApi), createWorkspaceLive(LexaApi), createSessionsLive(LexaApi),
  ).pipe(Layer.provide(Layer.provide(serviceLayer, Layer.mergeAll(dbLayer, LoggerLayer))), Layer.provide(dbLayer));
  const merged = Layer.mergeAll(apiLayer, handlerLayer);
  const finalLayer = Layer.provide(merged, createApiMiddleware(db, dbPath));
  const { handler } = HttpApiBuilder.toWebHandler(finalLayer as unknown as Parameters<typeof HttpApiBuilder.toWebHandler>[0]);
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
      return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Internal error" } }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  };
}

function buildServiceLayer() {
  return Layer.mergeAll(
    ProjectRepo.Default, ProjectService.Default, ProjectReposRepo.Default,
    ColumnRepo.Default, ColumnService.Default,
    SwimlaneRepo.Default, SwimlaneService.Default,
    MilestoneRepo.Default, MilestoneService.Default,
    TaskRepo.Default, TaskService.Default,
    FieldConfigRepo.Default, FieldConfigService.Default,
    ForgeRepo.Default, ForgeService.Default,
    RuntimeEventRepo.Default, RuntimeEventService.Default,
    RuntimeMachineRepo.Default, RuntimeMachineService.Default,
    SourceRepo.Default, SourceService.Default,
    TaskLinkRepo.Default, TaskLinkService.Default,
    ActivityRepo.Default, CommentRepo.Default, ActivityService.Default, CommentService.Default,
    WikiRepo.Default, WikiService.Default,
    ApiKeyRepo.Default, ApiKeyService.Default,
    UserRepo.Default, UserService.Default,
    UserProjectRoleRepo.Default, UserProjectRoleService.Default,
    WebhookEventRepo.Default,
    GitHubClient.Default, GitHubService.Default,
    DashboardService.Default,
    TeamsService.Default, WorkspaceService.Default, AuthorizationService.Default,
    WorkspaceInvitesService.Default, PasswordLinksService.Default,
  );
}

// Webhook route — OUTSIDE the HttpApi app (HttpApi reads the body before
// handlers; HMAC verification needs the RAW body). The ROUTE verifies the
// signature before parsing (createWebhookVerifier), then acks 200 immediately;
// processing runs in the background (Bun has no waitUntil — ack first, then
// fire-and-forget). Each factory builds its own runtime on the shared layers.
function buildWebhookRuntime(dbPath: string) {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return ManagedRuntime.make(
    Layer.provideMerge(
      buildServiceLayer(),
      Layer.mergeAll(Layer.succeed(Sqlite, db), LoggerLayer),
    )
  );
}

// HMAC-SHA-256 verification over the RAW body, constant-time compare — the
// route calls this BEFORE any JSON parsing or processing (401 on mismatch).
// The secret is read PER REQUEST from the mutable config holder (settings >
// env) via GitHubClient, so a PUT /api/settings/github applies to webhook
// verification immediately — no runtime rebuild needed.
export function createWebhookVerifier(dbPath: string): (rawBody: ArrayBuffer, signature: string | null) => Promise<boolean> {
  const runtime = buildWebhookRuntime(dbPath);
  return (rawBody, signature) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* GitHubClient;
        return yield* client.verifyWebhookSignature(rawBody, signature);
      })
    );
}

export function createWebhookHandler(dbPath: string): (rawBody: ArrayBuffer, deliveryId: string, event: string) => Response {
  const runtime = buildWebhookRuntime(dbPath);

  return (rawBody, deliveryId, event) => {
    const processing = Effect.gen(function* () {
      const service = yield* GitHubService;
      const payload = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
      yield* service.handleWebhook(deliveryId, event, payload as any);
    });
    runtime.runPromise(processing).catch((e) => {
      console.error(`[Webhook] processing failed delivery=${deliveryId} event=${event}:`, e);
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}
