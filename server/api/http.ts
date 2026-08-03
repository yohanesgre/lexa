import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpMiddleware, HttpServerResponse } from "@effect/platform";
import { Cause, Effect, Layer, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LoggerLayer } from "../logging/logger";
import { Sqlite } from "../db/database";
import { Database } from "bun:sqlite";
import { getSetting, setSetting } from "../db/settings";
import { ProjectNotFound, WikiPageNotFound, MachineNotFound, Forbidden, SetupLocked, errorResponse, errorToStatus } from "./errors";
import { resolveApiKeyIdentity } from "./auth-key";
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

// ── Setup wizard (first-run bootstrap, API-key exempt) ──
const SetupStatusSchema = Schema.Struct({
  configured: Schema.Boolean,
  needsAdmin: Schema.Boolean,
  hasApiKey: Schema.Boolean,
  hasProjects: Schema.Boolean,
  hasUsers: Schema.Boolean,
});
const SetupAdminInput = Schema.Struct({ email: Schema.String });
const SetupApiKeyResponse = Schema.Struct({ key: Schema.String });
const SetupSeedResponse = Schema.Struct({ seeded: Schema.Boolean });
const SetupOkResponse = Schema.Struct({ ok: Schema.Boolean });

const setupGroup = HttpApiGroup.make("setup")
  .add(HttpApiEndpoint.get("status", "/setup/status").addSuccess(SetupStatusSchema))
  .add(HttpApiEndpoint.post("setAdmin", "/setup/admin").setPayload(SetupAdminInput).addSuccess(SetupOkResponse))
  .add(HttpApiEndpoint.post("createApiKey", "/setup/api-key").addSuccess(SetupApiKeyResponse))
  .add(HttpApiEndpoint.post("seed", "/setup/seed").addSuccess(SetupSeedResponse))
  .add(HttpApiEndpoint.post("complete", "/setup/complete").addSuccess(SetupOkResponse));

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
  agent: Schema.String,
  model: Schema.String,
  printLogs: Schema.Boolean,
  logLevel: Schema.Literal("", "DEBUG", "INFO", "WARN", "ERROR"),
  extraArgs: Schema.Array(Schema.String),
  modelsCatalog: Schema.Array(RuntimeModelSchema),
  agentsCatalog: Schema.Array(RuntimeAgentSchema),
  status: Schema.Literal("online", "offline"),
  mcpConnected: Schema.Boolean,
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
// .agents/<skill>/SKILL.md (files-only delivery, no host store).
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
  lastSeen: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const MachineListResponse = Schema.Struct({ data: Schema.Array(MachineSchema) });
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
  // Daemon-verified Lexa MCP connectivity (initialize+ping vs /mcp). Older
  // daemons never send it → treated as false (blocked from Forge tasks).
  mcpConnected: Schema.optionalWith(Schema.Boolean, { default: () => false }),
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
  createdAt: Schema.String,
});
const ForgeTaskLogListResponse = Schema.Struct({ data: Schema.Array(ForgeTaskLogSchema) });
const AppendLogInput = Schema.Struct({ message: Schema.String });

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

const TaskLinkPath = Schema.Struct({ slug: Schema.String, id: Schema.String });

const taskLinksGroup = HttpApiGroup.make("task-links")
  .add(HttpApiEndpoint.get("listTaskLinks", "/projects/:slug/tasks/:id/links")
    .setPath(TaskLinkPath).addSuccess(TaskLinkListResponse))
  .add(HttpApiEndpoint.post("addTaskLink", "/projects/:slug/tasks/:id/links")
    .setPath(TaskLinkPath).setPayload(AddTaskLinkInput).addSuccess(TaskLinkSchema, { status: 201 }))
  .add(HttpApiEndpoint.del("removeTaskLink", "/projects/:slug/tasks/:id/links/:linkId")
    .setPath(Schema.Struct({ slug: Schema.String, id: Schema.String, linkId: Schema.String }))
    .addSuccess(Schema.UndefinedOr(Schema.Void)))
  .add(HttpApiEndpoint.get("searchTasks", "/projects/:slug/tasks/search")
    .setPath(SlugPath).addSuccess(TaskSearchResponse));

const forgeGroup = HttpApiGroup.make("forge")
  .add(HttpApiEndpoint.post("registerRuntime", "/forge/runtimes/register")
    .setPayload(RegisterRuntimeInput).addSuccess(RuntimeSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateRuntime", "/forge/runtimes/:id")
    .setPath(RuntimeIdPath).setPayload(UpdateRuntimeInput).addSuccess(RuntimeSchema))
  .add(HttpApiEndpoint.del("removeRuntime", "/forge/runtimes/:id")
    .setPath(RuntimeIdPath).addSuccess(Schema.Undefined, { status: 204 }))
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
    .setPayload(MachineHeartbeatInput).addSuccess(MachineSchema))
  .add(HttpApiEndpoint.get("listMachines", "/forge/machines")
    .addSuccess(MachineListResponse))
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
    .setPath(ForgeAgentPath).addSuccess(Schema.UndefinedOr(Schema.Void)))
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
    .setPath(ForgeSkillPath).addSuccess(Schema.UndefinedOr(Schema.Void)))
  .add(HttpApiEndpoint.post("resetForgeSkill", "/forge/skills/:id/reset")
    .setPath(ForgeSkillPath).addSuccess(ForgeSkillSchema))
  .add(HttpApiEndpoint.get("listSources", "/projects/:slug/documents/:type/:id/sources")
    .setPath(DocumentPath).addSuccess(SourceListResponse))
  .add(HttpApiEndpoint.post("addSource", "/projects/:slug/documents/:type/:id/sources")
    .setPath(DocumentPath).setPayload(AddSourceInput).addSuccess(SourceSchema, { status: 201 }))
  .add(HttpApiEndpoint.del("removeSource", "/projects/:slug/documents/:type/:id/sources/:sourceId")
    .setPath(Schema.Struct({ slug: Schema.String, type: Schema.Literal("task", "wiki"), id: Schema.String, sourceId: Schema.String }))
    .addSuccess(Schema.UndefinedOr(Schema.Void)));

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
  priority: Schema.String,        // priority_options.id
  type: Schema.String,            // type_options.id
  assignees: Schema.Array(Schema.String),
  position: Schema.String,
  githubs: Schema.Array(GithubIssueSchema),
  archivedAt: Schema.NullOr(Schema.String),
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
  priority: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  assignees: Schema.optional(Schema.Array(Schema.String)),
});

const UpdateTaskPayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.Any),
  priority: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
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
  fieldConfig: FieldConfigSchema,
  links: Schema.Array(TaskLinkSchema),
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
    .setPath(TaskPath)  .addSuccess(Schema.Undefined, { status: 204 }))
  .add(HttpApiEndpoint.post("archiveTask", "/projects/:slug/tasks/:id/archive")
    .setPath(TaskPath).addSuccess(TaskSchema))
  .add(HttpApiEndpoint.post("restoreTask", "/projects/:slug/tasks/:id/restore")
    .setPath(TaskPath).addSuccess(TaskSchema));

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
  .add(setupGroup)
  .add(projectsGroup)
  .add(columnsGroup)
  .add(swimlanesGroup)
  .add(fieldConfigGroup)
  .add(forgeGroup)
  .add(taskLinksGroup)
  .add(tasksGroup)
  .add(boardGroup)
  .add(wikiGroup)
  .add(dashboardGroup)
  .add(apiKeysGroup)
  .add(adminGroup)
  .prefix("/api");

const apiLayer = HttpApiBuilder.api(LexaApi);

// The HttpApi platform rewrites req.request.url to a host-less relative path
// (fromWeb → removeHost). originalUrl keeps the full URL, so parse query params
// from that instead of calling `new URL(req.request.url)` (which throws).
const searchParams = (req: { request: { originalUrl: string } }): URLSearchParams =>
  new URL(req.request.originalUrl).searchParams;

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

// Admin-only gate: resolves the caller from the Authorization header (same
// role rule as the MCP surface — keys without a user are admin) and fails
// with 403 FORBIDDEN unless they are an admin.
let apiDbPath: string | null = null;
const requireAdmin = (req: { request: { headers: Record<string, string> } }) =>
  Effect.gen(function* () {
    const identity = resolveApiKeyIdentity(req.request.headers["authorization"] ?? "", apiDbPath ?? "");
    if (!identity || identity.role !== "admin") {
      return yield* Effect.fail(new Forbidden({ message: "Admin role required" }));
    }
    return identity;
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
  const adminEmails = [...(process.env.LXK_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean), ...(getSetting(db, "admin_emails") || "").split(",").map((s) => s.trim()).filter(Boolean)];
  const setupComplete = getSetting(db, "setup_complete") === "1";
  return {
    configured: setupComplete || (apiKeyCount > 0 && adminEmails.length > 0),
    needsAdmin: adminEmails.length === 0,
    hasApiKey: apiKeyCount > 0,
    hasProjects: projectCount > 0,
    hasUsers: userCount > 0,
  };
}

// The wizard is only for first install: once setup is complete (flag set by
// /setup/complete) or real projects exist, the mutating endpoints lock.
// setAdmin is wizard-only (Settings manages admins via env/API-key admin),
// so this does not break post-install flows.
function setupLocked(db: Database): boolean {
  return getSetting(db, "setup_complete") === "1" ||
    ((db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c > 0);
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
        if (setupLocked(db)) return yield* Effect.fail(new SetupLocked());
        const existing = getSetting(db, "admin_emails") || "";
        const emails = [...new Set([...existing.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean), req.payload.email.trim().toLowerCase()])];
        setSetting(db, "admin_emails", emails.join(","));
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
        return { data: projects.map(formatProject), nextCursor: null };
      }))
    )
    .handle("create", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
        const swimlaneService = yield* SwimlaneService;
        const swimlane = yield* swimlaneService.update(req.path.id, {
          name: req.payload.name, description: req.payload.description, position: req.payload.position,
        });
        return formatSwimlane(swimlane);
      }))
    )
    .handle("deleteSwimlane", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const swimlaneService = yield* SwimlaneService;
        yield* swimlaneService.delete(req.path.id);
        return undefined;
      }))
    )
);

const fieldConfigLive = HttpApiBuilder.group(LexaApi, "field-config", (handlers) =>
  handlers
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
        yield* requireAdmin(req);
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
          agent: req.payload.agent ?? "",
          model: req.payload.model ?? "",
          hostname: req.payload.hostname ?? "",
        });
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
        const machineService = yield* RuntimeMachineService;
        const eventService = yield* RuntimeEventService;
        const runtime = yield* service.getRuntimeConfig(req.path.id);
        if (!runtime.machineId) {
          return yield* new MachineNotFound({ id: "" });
        }
        yield* machineService.requireOnline(runtime.machineId);
        yield* eventService.createRemove({ machineId: runtime.machineId, agentCli: runtime.provider });
        yield* service.removeRuntime(req.path.id);
        return undefined;
      }))
    )
    .handle("heartbeat", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        yield* service.heartbeat(
          req.payload.runtimeId,
          req.payload.mcpConnected
        );
        return { ok: true as const };
      }))
    )
    .handle("claimTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const task = yield* service.claimNext(req.payload.runtimeId);
        if (!task) return { task: null, provider: "opencode" as const, agent: "", model: "", printLogs: false, logLevel: "", extraArgs: [], prompt: "", agentMarkdown: "", skillMarkdown: "" };
        const runtime = yield* service.getRuntimeConfig(req.payload.runtimeId);
        // Server-authoritative prompt (resolves linked sources, enforces
        // output rules). If source resolution fails, fall back to the
        // daemon's local minimal build rather than blocking the claim.
        const prompt = yield* service.buildPromptForTask(task).pipe(
          Effect.catchAll(() => Effect.succeed(""))
        );
        // Claim-carried rule files: the daemon writes these into the run dir
        // as AGENTS.md + .agents/<skill>/SKILL.md before spawning the CLI.
        const { agentMarkdown, skillMarkdown } = yield* service.resolveRules(task).pipe(
          Effect.map((r) => ({ agentMarkdown: r.agent.instructions, skillMarkdown: r.skill.instructions })),
          Effect.catchAll(() => Effect.succeed({ agentMarkdown: "", skillMarkdown: "" }))
        );
        return { task, provider: runtime.provider, agent: runtime.agent, model: runtime.model, printLogs: runtime.printLogs, logLevel: runtime.logLevel, extraArgs: runtime.extraArgs, prompt, agentMarkdown, skillMarkdown };
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
        return yield* service.claimForMachine(req.payload.machineId);
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
        const machine = yield* machineService.heartbeat({
          id: req.payload.id,
          hostname: req.payload.hostname ?? "",
        });
        if (req.payload.runtimes) {
          yield* forgeService.syncCatalogs(req.payload.id, req.payload.runtimes.map((catalog) => ({
            runtimeId: catalog.runtimeId,
            agentCli: catalog.agentCli,
            models: [...catalog.models],
            agents: [...catalog.agents],
          })));
        }
        return machine;
      }))
    )
    .handle("listMachines", () =>
      respond(Effect.gen(function* () {
        const service = yield* RuntimeMachineService;
        const machines = yield* service.list();
        return { data: machines };
      }))
    )
    .handle("listRuntimes", () =>
      respond(Effect.gen(function* () {
        const service = yield* ForgeService;
        const runtimes = yield* service.listRuntimes();
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
        return yield* service.appendLog(req.path.id, req.payload.message);
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
        yield* requireAdmin(req);
        const service = yield* ForgeService;
        return yield* service.createAgent(req.payload);
      }))
    )
    .handle("updateForgeAgent", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* ForgeService;
        return yield* service.updateAgent(req.path.id, req.payload);
      }))
    )
    .handle("deleteForgeAgent", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* ForgeService;
        yield* service.deleteAgent(req.path.id);
        return undefined;
      }))
    )
    .handle("replaceAgentSkills", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* ForgeService;
        return yield* service.replaceAgentSkills(req.path.id, [...req.payload.skillIds]);
      }))
    )
    .handle("resetForgeAgent", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
        const service = yield* ForgeService;
        return yield* service.createSkill(req.payload);
      }))
    )
    .handle("updateForgeSkill", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* ForgeService;
        return yield* service.updateSkill(req.path.id, req.payload);
      }))
    )
    .handle("deleteForgeSkill", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* ForgeService;
        yield* service.deleteSkill(req.path.id);
        return undefined;
      }))
    )
    .handle("resetForgeSkill", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
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
        const project = yield* projectService.findBySlug(req.path.slug);
        const source = yield* service.add({
          projectId: project.id,
          documentType: req.path.type,
          documentId: req.path.id,
          kind: req.payload.kind,
          ref: req.payload.ref,
        });
        return source;
      }))
    )
    .handle("removeSource", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* SourceService;
        yield* service.remove(req.path.sourceId);
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
        const project = yield* projectService.findBySlug(req.path.slug);
        const link = yield* service.add({
          projectId: project.id,
          fromTaskId: req.path.id,
          toTaskId: req.payload.toTaskId,
          relation: req.payload.relation,
        });
        return link;
      }))
    )
    .handle("removeTaskLink", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* TaskLinkService;
        yield* service.remove(req.path.linkId);
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
        const project = yield* projectService.findBySlug(req.path.slug);
        const task = yield* taskService.create({
          projectId: project.id, columnId: req.payload.columnId,
          swimlaneId: req.payload.swimlaneId, title: req.payload.title,
          description: req.payload.description, priority: req.payload.priority,
          type: req.payload.type, parentId: req.payload.parentId,
          assignees: req.payload.assignees ? [...req.payload.assignees] : undefined,
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
          assignees: req.payload.assignees ? [...req.payload.assignees] : undefined,
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
    .handle("archiveTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const task = yield* taskService.archive(req.path.id);
        return formatTask(task);
      }))
    )
    .handle("restoreTask", (req) =>
      respond(Effect.gen(function* () {
        const taskService = yield* TaskService;
        const task = yield* taskService.restore(req.path.id);
        return formatTask(task);
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
      const fieldConfigService = yield* FieldConfigService;
      const taskLinkRepo = yield* TaskLinkRepo;
      const project = yield* projectService.findBySlug(req.path.slug);
      const columns = yield* columnService.findByProject(project.id);
      const swimlanes = yield* swimlaneService.findByProject(project.id);
      const fieldConfig = yield* fieldConfigService.findByProject(project.id);
      const links = yield* taskLinkRepo.findByProject(project.id);
      const includeArchived = searchParams(req).get("includeArchived") === "true";
      const tasks = yield* taskService.findAllByProject(project.id, { includeArchived });
      return {
        project: formatProject(project),
        columns: columns.map(formatColumn),
        swimlanes: swimlanes.map(formatSwimlane),
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
        yield* requireAdmin(req);
        const service = yield* ApiKeyService;
        const keys = yield* service.list();
        return { data: keys };
      }))
    )
    .handle("createApiKey", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* ApiKeyService;
        const result = yield* service.create(req.payload.name);
        return result;
      }))
    )
    .handle("deleteApiKey", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* ApiKeyService;
        yield* service.delete(req.path.id);
        return undefined;
      }))
    )
);

const adminLive = HttpApiBuilder.group(LexaApi, "admin", (handlers) =>
  handlers
    .handle("listUsers", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
        const service = yield* UserService;
        const users = yield* service.list();
        return { data: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, lastSeen: u.last_seen })) };
      }))
    )
    .handle("updateUserRole", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
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
        yield* requireAdmin(req);
        const service = yield* UserProjectRoleService;
        yield* service.setRole(req.path.id, req.payload.projectId, req.payload.role);
        return { projectId: req.payload.projectId, projectSlug: req.payload.projectId, role: req.payload.role };
      }))
    )
    .handle("removeUserProjectRole", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin(req);
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
  apiDbPath = dbPath;
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const dbLayer = Layer.succeed(Sqlite, db);

  const serviceLayer = Layer.mergeAll(
    ProjectRepo.Default, ProjectService.Default,
    ColumnRepo.Default, ColumnService.Default,
    SwimlaneRepo.Default, SwimlaneService.Default,
    TaskRepo.Default, TaskService.Default,
    FieldConfigRepo.Default, FieldConfigService.Default,
    ForgeRepo.Default, ForgeService.Default,
    RuntimeEventRepo.Default, RuntimeEventService.Default,
    RuntimeMachineRepo.Default, RuntimeMachineService.Default,
    SourceRepo.Default, SourceService.Default,
    TaskLinkRepo.Default, TaskLinkService.Default,
    WikiRepo.Default, WikiService.Default,
    ApiKeyRepo.Default, ApiKeyService.Default,
    UserRepo.Default, UserService.Default,
    UserProjectRoleRepo.Default, UserProjectRoleService.Default,
    DashboardService.Default,
  );
  const handlerLayer = Layer.mergeAll(
    healthLive, setupLive, projectsLive, columnsLive, swimlanesLive, fieldConfigLive, forgeLive, taskLinksLive, tasksLive, boardLive, wikiLive, apiKeysLive, adminLive, dashboardLive,
  ).pipe(Layer.provide(Layer.provide(serviceLayer, Layer.mergeAll(dbLayer, LoggerLayer))), Layer.provide(dbLayer));
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
