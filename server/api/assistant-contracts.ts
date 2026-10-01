// Assistant HttpApi contracts (schemas + groups) — ADR-0003 §F.
//
// Pure Schema/HttpApiGroup definitions only: no engine imports, so this
// module is safe in the Bun module graph (the Bun handler composes these
// groups out; only `assistant-api.ts` mounts them).

import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

// Local copy of the slug path used by the project-scoped usage endpoint.
// `assistant-contracts.ts` must stay import-free of `http.ts` (pure contracts,
// safe in the Bun module graph), so the schema is declared here.
const SlugPath = Schema.Struct({ slug: Schema.String });

// ── Assistant task queue (document Generate, assistant lane) ──

const AssistantTaskSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
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
  status: Schema.Literal("queued", "running", "completed", "failed", "cancelled"),
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});

const AssistantTaskPath = Schema.Struct({ id: Schema.String });

// ── Assistant assistant tier (S3/S5/S9/S15) ──
const ProviderKindSchema = Schema.Literal("openai_compatible", "anthropic_compatible", "openai_responses");

const AssistantReasoningEffortSchema = Schema.Literal("minimal", "low", "medium", "high");

const AssistantSettingsPath = Schema.Struct({ projectId: Schema.String });

// Keys are write-only: omitted apiKey/searchApiKey keep the stored values.
const AssistantSettingsInputPayload = Schema.Struct({
  providerId: Schema.optional(Schema.NullOr(Schema.String)),
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(ProviderKindSchema),
  baseUrl: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  searchProvider: Schema.optional(Schema.NullOr(Schema.Literal("exa"))),
  searchApiKey: Schema.optional(Schema.NullOr(Schema.String)),
  urlAllowlist: Schema.optional(Schema.NullOr(Schema.String)),
  primarySupportsImages: Schema.optional(Schema.Boolean),
  visionModel: Schema.optional(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.optional(Schema.NullOr(AssistantReasoningEffortSchema)),
  writeTools: Schema.optional(Schema.Array(Schema.String)),
  fallbackModelIds: Schema.optional(Schema.Array(Schema.String)),
});

const AssistantSettingsMaskedSchema = Schema.Struct({
  projectId: Schema.String,
  providerId: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String),
  kind: Schema.optional(ProviderKindSchema),
  baseUrl: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  hasKey: Schema.optional(Schema.Boolean),
  keyMask: Schema.optional(Schema.NullOr(Schema.String)),
  searchProvider: Schema.NullOr(Schema.Literal("exa")),
  hasSearchKey: Schema.Boolean,
  urlAllowlist: Schema.NullOr(Schema.String),
  primarySupportsImages: Schema.Boolean,
  visionModel: Schema.optional(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.NullOr(AssistantReasoningEffortSchema),
  writeTools: Schema.Array(Schema.String),
  fallbackModelIds: Schema.optional(Schema.Array(Schema.String)),
});

// test/models take UNSAVED submitted values (never persist); an omitted
// apiKey falls back to the stored one so testing a saved config doesn't
// require re-entering the key.
const AssistantSettingsTestPayload = AssistantSettingsInputPayload;

const ModelListResponse = Schema.Struct({ models: Schema.Array(Schema.Struct({ id: Schema.String })) });

const AssistantAttachmentRef = Schema.Struct({
  storageKey: Schema.String,
  mimeType: Schema.String,
  name: Schema.String,
});

const CreateAssistantTaskInput = Schema.Struct({
  slug: Schema.String,
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  prompt: Schema.String,
  agentId: Schema.String,
  skillId: Schema.String,
  selection: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(AssistantAttachmentRef)),
});

const AssistantThreadPath = Schema.Struct({ documentType: Schema.Literal("task", "wiki"), documentId: Schema.String });

const AssistantChatStreamInput = Schema.Struct({
  projectId: Schema.String,
  chatId: Schema.String,
  message: Schema.String,
  agentId: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(AssistantAttachmentRef)),
  fromIndex: Schema.optional(Schema.Number),
  reasoningEffort: Schema.optional(Schema.NullOr(AssistantReasoningEffortSchema)),
});

const AssistantChatPath = Schema.Struct({ chatId: Schema.String });

const AssistantChatTranscriptSchema = Schema.Struct({
  chatId: Schema.String,
  projectId: Schema.String,
  ownerUserId: Schema.NullOr(Schema.String),
  agentId: Schema.NullOr(Schema.String),
  skillId: Schema.NullOr(Schema.String),
  messages: Schema.Array(Schema.Any),
  summary: Schema.NullOr(Schema.String),
  summarizedCount: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const MemoryEntrySchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  content: Schema.String,
  source: Schema.Literal("manual", "assistant"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const MemoryListResponse = Schema.Struct({ data: Schema.Array(MemoryEntrySchema) });
const MemoryCreatePayload = Schema.Struct({ content: Schema.String });
const MemoryProjectPath = Schema.Struct({ projectId: Schema.String });
const MemoryDeletePath = Schema.Struct({ projectId: Schema.String, memoryId: Schema.String });

const AssistantChatThreadSummarySchema = Schema.Struct({
  chatId: Schema.String,
  title: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  snippet: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const AssistantChatListResponse = Schema.Struct({ data: Schema.Array(AssistantChatThreadSummarySchema) });
const ChatMetaPayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  pinned: Schema.optional(Schema.Boolean),
});
const ChatMetaResponse = Schema.Struct({ chatId: Schema.String, title: Schema.NullOr(Schema.String), pinned: Schema.Boolean });

const assistantGroup = HttpApiGroup.make("assistant")
  .add(HttpApiEndpoint.get("getAssistantSettings", "/assistant/settings/:projectId")
    .setPath(AssistantSettingsPath).addSuccess(AssistantSettingsMaskedSchema))
  .add(HttpApiEndpoint.put("putAssistantSettings", "/assistant/settings/:projectId")
    .setPath(AssistantSettingsPath).setPayload(AssistantSettingsInputPayload).addSuccess(AssistantSettingsMaskedSchema))
  .add(HttpApiEndpoint.post("testAssistantSettings", "/assistant/settings/:projectId/test")
    .setPath(AssistantSettingsPath).setPayload(AssistantSettingsTestPayload)
    .addSuccess(Schema.Struct({ ok: Schema.Boolean, latencyMs: Schema.Number })))
  .add(HttpApiEndpoint.post("listAssistantModels", "/assistant/settings/:projectId/models")
    .setPath(AssistantSettingsPath).setPayload(AssistantSettingsTestPayload).addSuccess(ModelListResponse))
  .add(HttpApiEndpoint.post("createAssistantTask", "/assistant/tasks")
    .setPayload(CreateAssistantTaskInput).addSuccess(AssistantTaskSchema, { status: 201 }))
  .add(HttpApiEndpoint.get("getAssistantTask", "/assistant/tasks/:id")
    .setPath(AssistantTaskPath).addSuccess(AssistantTaskSchema))
  .add(HttpApiEndpoint.post("streamAssistantTask", "/assistant/tasks/:id/stream")
    .setPath(AssistantTaskPath).addSuccess(Schema.Void))
  .add(HttpApiEndpoint.post("cancelAssistantTask", "/assistant/tasks/:id/cancel")
    .setPath(AssistantTaskPath).addSuccess(Schema.Struct({ ok: Schema.Boolean })))
  .add(HttpApiEndpoint.del("resetAssistantThread", "/assistant/threads/:documentType/:documentId")
    .setPath(AssistantThreadPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("streamAssistantChat", "/assistant/chat/stream")
    .setPayload(AssistantChatStreamInput).addSuccess(Schema.Void))
  .add(HttpApiEndpoint.get("getAssistantChat", "/assistant/chat/:chatId")
    .setPath(AssistantChatPath).addSuccess(AssistantChatTranscriptSchema))
  .add(HttpApiEndpoint.del("resetAssistantChat", "/assistant/chat/:chatId")
    .setPath(AssistantChatPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.get("listAssistantChats", "/assistant/chats/:projectId")
    .setPath(MemoryProjectPath).addSuccess(AssistantChatListResponse))
  .add(HttpApiEndpoint.patch("renameAssistantChat", "/assistant/chat/:chatId")
    .setPath(AssistantChatPath).setPayload(ChatMetaPayload).addSuccess(ChatMetaResponse))
  .add(HttpApiEndpoint.get("exportAssistantChat", "/assistant/chat/:chatId/export")
    .setPath(AssistantChatPath).addSuccess(Schema.Void))
  .add(HttpApiEndpoint.get("listAssistantMemory", "/assistant/memory/:projectId")
    .setPath(MemoryProjectPath).addSuccess(MemoryListResponse))
  .add(HttpApiEndpoint.post("addAssistantMemory", "/assistant/memory/:projectId")
    .setPath(MemoryProjectPath).setPayload(MemoryCreatePayload).addSuccess(MemoryEntrySchema, { status: 201 }))
  .add(HttpApiEndpoint.del("removeAssistantMemory", "/assistant/memory/:projectId/:memoryId")
    .setPath(MemoryDeletePath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("decideAssistantApproval", "/assistant/approvals/:id/decide")
    .setPath(Schema.Struct({ id: Schema.String }))
    .setPayload(Schema.Struct({ verdict: Schema.Literal("approve", "reject") }))
    .addSuccess(Schema.Struct({ approvalId: Schema.String, batchId: Schema.String, status: Schema.String, remaining: Schema.Number })))
  .add(HttpApiEndpoint.post("resumeAssistantChat", "/assistant/chat/:chatId/resume")
    .setPath(AssistantChatPath).addSuccess(Schema.Void))
  .add(HttpApiEndpoint.post("resumeAssistantThread", "/assistant/threads/:documentType/:documentId/resume")
    .setPath(AssistantThreadPath).addSuccess(Schema.Void));

const AssistantUsageSummarySchema = Schema.Struct({
  totalTokens: Schema.Number,
  promptTokens: Schema.Number,
  completionTokens: Schema.Number,
  totalCostCents: Schema.Number,
  totalCostUsd: Schema.Number,
  avgLatencyMs: Schema.NullOr(Schema.Number),
  p50LatencyMs: Schema.NullOr(Schema.Number),
  p95LatencyMs: Schema.NullOr(Schema.Number),
  errorRate: Schema.Number,
  totalCalls: Schema.Number,
  errorCalls: Schema.Number,
});
const AssistantByDayRowSchema = Schema.Struct({
  day: Schema.String,
  tokens: Schema.Number,
  costCents: Schema.Number,
  costUsd: Schema.Number,
  avgLatencyMs: Schema.NullOr(Schema.Number),
  calls: Schema.Number,
  errorRate: Schema.Number,
});
const AssistantByModelRowSchema = Schema.Struct({
  model: Schema.String,
  tokens: Schema.Number,
  costCents: Schema.Number,
  costUsd: Schema.Number,
  avgLatencyMs: Schema.NullOr(Schema.Number),
  calls: Schema.Number,
  errorRate: Schema.Number,
});
const AssistantUsageResponseSchema = Schema.Struct({
  summary: AssistantUsageSummarySchema,
  totalCostCents: Schema.Number,
  byDay: Schema.Array(AssistantByDayRowSchema),
  byModel: Schema.Array(AssistantByModelRowSchema),
});

const AssistantPriceInputSchema = Schema.Struct({
  model: Schema.String,
  prompt_price: Schema.Number,
  completion_price: Schema.Number,
  cached_read_price: Schema.Number,
  cached_write_price: Schema.Number,
});
const AssistantPriceResponseSchema = Schema.Struct({
  model: Schema.String,
  prompt_price: Schema.Number,
  completion_price: Schema.Number,
  cached_read_price: Schema.Number,
  cached_write_price: Schema.Number,
  updated_at: Schema.String,
});

const AssistantRunRowSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  projectId: Schema.String,
  documentType: Schema.Literal("task", "wiki"),
  documentId: Schema.String,
  documentTitle: Schema.String,
  agentId: Schema.String,
  skillId: Schema.String,
  agentName: Schema.String,
  skillName: Schema.String,
  status: Schema.Literal("queued", "running", "completed", "failed", "cancelled"),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});
const AssistantRunsResponseSchema = Schema.Struct({
  data: Schema.Array(AssistantRunRowSchema),
  nextCursor: Schema.NullOr(Schema.String),
  counts: Schema.Struct({
    queued: Schema.Number,
    running: Schema.Number,
    completed: Schema.Number,
    failed: Schema.Number,
    cancelled: Schema.Number,
  }),
});

const AssistantBindingRowSchema = Schema.Struct({
  projectId: Schema.String,
  projectName: Schema.String,
  projectSlug: Schema.String,
  providerId: Schema.NullOr(Schema.String),
  providerLabel: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String),
  modelLabel: Schema.NullOr(Schema.String),
  fallbackCount: Schema.Number,
  writeToolsCount: Schema.Number,
  memoryCount: Schema.Number,
  hasSearchKey: Schema.Boolean,
  reasoningEffort: Schema.NullOr(Schema.Literal("minimal", "low", "medium", "high")),
  updatedAt: Schema.NullOr(Schema.String),
});
const AssistantBindingsResponseSchema = Schema.Struct({ data: Schema.Array(AssistantBindingRowSchema) });

const AssistantHealthResponseSchema = Schema.Struct({
  providerId: Schema.String,
  circuitState: Schema.Literal("open", "closed", "half-open"),
  failureCount: Schema.Number,
  openedAt: Schema.NullOr(Schema.String),
  lastProbeAt: Schema.NullOr(Schema.String),
  consecutiveFailures: Schema.Number,
  latencyMs: Schema.NullOr(Schema.Number),
  retryAfterSeconds: Schema.NullOr(Schema.Number),
  lastFailureCode: Schema.NullOr(Schema.String),
  lastFailureAt: Schema.NullOr(Schema.String),
  lastCheckedAt: Schema.NullOr(Schema.String),
});

const McpTransportTypeSchema = Schema.Literal("http", "sse", "stdio");
const McpServerSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  transportType: McpTransportTypeSchema,
  url: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  args: Schema.Array(Schema.String),
  hasSecret: Schema.Boolean,
  secretSource: Schema.Literal("managed", "none"),
  enabled: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
// `managedSecretsEnabled` is additive and read-only: it says whether this server
// can encrypt a managed token at all (a master key is configured), so the
// registry UI renders the managed branch from the response instead of assuming
// it. The row shape above is untouched, and the field is a capability, never key
// material.
const McpServerListResponse = Schema.Struct({
  data: Schema.Array(McpServerSchema),
  managedSecretsEnabled: Schema.Boolean,
});
// `secret` is write-only by construction: it exists on the request schemas and
// NOT on McpServerSchema, so a response can never carry it. An empty value means
// "keep the stored source" — removal is `clearSecret: true` on the update.
// 4096 chars bounds a bearer token at schema decode (400 before the service),
// so an oversized body field never reaches the crypto module.
const McpManagedSecretSchema = Schema.NullOr(Schema.String.pipe(Schema.maxLength(4096)));
// DEPRECATED: `secretRef` is accepted-and-ignored for typed-client compatibility
// (managed-only since 2026-09-28 — migration 0012 cleared every stored ref). It
// stays on the payloads so an older client's request decodes instead of 400ing;
// the handler logs one structured WARN and drops it. Never map it into a service
// call, and never return it. The 4096 cap mirrors `secret`: an ignored field is
// still a request body field, so it is bounded at schema decode like the managed
// one rather than accepting an unbounded string.
const DeprecatedMcpSecretRefSchema = Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(4096))));
const McpServerCreatePayload = Schema.Struct({
  label: Schema.String,
  transportType: McpTransportTypeSchema,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  command: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.Array(Schema.String)),
  secretRef: DeprecatedMcpSecretRefSchema,
  secret: Schema.optional(McpManagedSecretSchema),
  enabled: Schema.optional(Schema.Boolean),
});
const McpServerUpdatePayload = Schema.Struct({
  label: Schema.optional(Schema.String),
  transportType: Schema.optional(McpTransportTypeSchema),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  command: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.Array(Schema.String)),
  secretRef: DeprecatedMcpSecretRefSchema,
  secret: Schema.optional(McpManagedSecretSchema),
  clearSecret: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
});
const McpTestResponse = Schema.Struct({
  ok: Schema.Boolean,
  toolCount: Schema.Number,
  readOnlyToolCount: Schema.Number,
  latencyMs: Schema.Number,
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
});
const ProjectMcpServerSchema = Schema.Struct({
  projectId: Schema.String,
  serverId: Schema.String,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const ProjectMcpServerListResponse = Schema.Struct({ data: Schema.Array(ProjectMcpServerSchema) });
const ProjectMcpServersPutPayload = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ serverId: Schema.String, enabled: Schema.Boolean })),
});

// Jev registry. `secret` is write-only by construction: it exists on the PATCH
// payload and NOT on the response, so a response can never carry it. 4096 chars
// bounds a key at schema decode (400 before the service), so an oversized body
// field never reaches the crypto module. `keyMask` is server-provided.
const AssistantJevMaskedSchema = Schema.Struct({
  id: Schema.Literal("default"),
  baseUrl: Schema.String,
  model: Schema.String,
  enabled: Schema.Boolean,
  hasKey: Schema.Boolean,
  keyMask: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const AssistantJevConfigResponse = Schema.Struct({
  config: AssistantJevMaskedSchema,
  secretsEnabled: Schema.Boolean,
});
const JevManagedSecretSchema = Schema.NullOr(Schema.String.pipe(Schema.maxLength(4096)));
const AssistantJevPatchPayload = Schema.Struct({
  baseUrl: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  secret: Schema.optional(JevManagedSecretSchema),
  clearSecret: Schema.optional(Schema.Boolean),
});
const AssistantJevTestResponse = Schema.Struct({
  ok: Schema.Literal(true),
  latencyMs: Schema.Number,
  models: Schema.Array(Schema.String),
});
const AssistantJevProjectSchema = Schema.Struct({
  projectId: Schema.String,
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
const AssistantJevProjectPutPayload = Schema.Struct({ enabled: Schema.Boolean });
const AssistantJevProjectIdPath = Schema.Struct({ id: Schema.String });

// Jev registry: superadmin config + test at /assistant/jev, plus per-project
// opt-in keyed by project id (member read, project-admin write).
const assistantJevGroup = HttpApiGroup.make("assistantJev")
  .add(HttpApiEndpoint.get("getAssistantJev", "/assistant/jev").addSuccess(AssistantJevConfigResponse))
  .add(HttpApiEndpoint.patch("updateAssistantJev", "/assistant/jev").setPayload(AssistantJevPatchPayload).addSuccess(AssistantJevConfigResponse))
  .add(HttpApiEndpoint.post("testAssistantJev", "/assistant/jev/test").addSuccess(AssistantJevTestResponse))
  .add(HttpApiEndpoint.get("getProjectJev", "/projects/:id/assistant/jev").setPath(AssistantJevProjectIdPath).addSuccess(AssistantJevProjectSchema))
  .add(HttpApiEndpoint.put("putProjectJev", "/projects/:id/assistant/jev").setPath(AssistantJevProjectIdPath).setPayload(AssistantJevProjectPutPayload).addSuccess(AssistantJevProjectSchema));

const adminAssistantGroup = HttpApiGroup.make("adminAssistant")
  .add(HttpApiEndpoint.get("adminAssistantUsage", "/admin/assistant/usage").addSuccess(AssistantUsageResponseSchema))
  .add(HttpApiEndpoint.get("adminAssistantUsageCsv", "/admin/assistant/usage.csv").addSuccess(Schema.Void, { status: 200 }))
  .add(HttpApiEndpoint.get("adminAssistantPrices", "/admin/assistant/prices").addSuccess(Schema.Struct({ data: Schema.Array(AssistantPriceResponseSchema) })))
  .add(HttpApiEndpoint.put("adminAssistantPutPrices", "/admin/assistant/prices").setPayload(AssistantPriceInputSchema).addSuccess(AssistantPriceResponseSchema))
  .add(HttpApiEndpoint.get("adminAssistantCalls", "/admin/assistant/calls").addSuccess(Schema.Struct({ data: Schema.Array(Schema.Any) })))
  .add(HttpApiEndpoint.post("adminAssistantPriceSync", "/admin/assistant/prices/sync").addSuccess(Schema.Struct({ synced: Schema.Number, data: Schema.Array(AssistantPriceResponseSchema) })))
  .add(HttpApiEndpoint.get("adminAssistantRuns", "/admin/assistant/runs").addSuccess(AssistantRunsResponseSchema))
  .add(HttpApiEndpoint.get("adminAssistantBindings", "/admin/assistant/bindings").addSuccess(AssistantBindingsResponseSchema))
  .add(HttpApiEndpoint.get("adminAssistantProviders", "/admin/assistant/providers").addSuccess(Schema.Struct({ data: Schema.Array(Schema.Any), secretsEnabled: Schema.Boolean })))
  .add(HttpApiEndpoint.post("adminAssistantCreateProvider", "/admin/assistant/providers").setPayload(Schema.Struct({ label: Schema.String, baseUrl: Schema.String, apiKey: Schema.String })).addSuccess(Schema.Any))
  .add(HttpApiEndpoint.patch("adminAssistantUpdateProvider", "/admin/assistant/providers/:id").setPath(Schema.Struct({ id: Schema.String })).setPayload(Schema.Struct({ label: Schema.optional(Schema.String), baseUrl: Schema.optional(Schema.String), apiKey: Schema.optional(Schema.String), clearKey: Schema.optional(Schema.Boolean) })).addSuccess(Schema.Any))
  .add(HttpApiEndpoint.del("adminAssistantDeleteProvider", "/admin/assistant/providers/:id").setPath(Schema.Struct({ id: Schema.String })).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("adminAssistantTestProvider", "/admin/assistant/providers/:id/test").setPath(Schema.Struct({ id: Schema.String })).addSuccess(Schema.Struct({ ok: Schema.Boolean, latencyMs: Schema.Number })))
  .add(HttpApiEndpoint.post("adminAssistantProviderModels", "/admin/assistant/providers/:id/models").setPath(Schema.Struct({ id: Schema.String })).addSuccess(Schema.Struct({ data: Schema.Array(Schema.Any) })))
  .add(HttpApiEndpoint.patch("adminAssistantUpdateModel", "/admin/assistant/providers/:id/models/:modelId").setPath(Schema.Struct({ id: Schema.String, modelId: Schema.String })).setPayload(Schema.Struct({ enabled: Schema.optional(Schema.Boolean), priority: Schema.optional(Schema.Number) })).addSuccess(Schema.Any))
  .add(HttpApiEndpoint.post("adminAssistantReorderModels", "/admin/assistant/providers/:id/models/reorder").setPath(Schema.Struct({ id: Schema.String })).setPayload(Schema.Struct({ orderedIds: Schema.Array(Schema.String) })).addSuccess(Schema.Struct({ data: Schema.Array(Schema.Any) })))
  .add(HttpApiEndpoint.get("adminAssistantHealth", "/admin/assistant/providers/:id/health").setPath(Schema.Struct({ id: Schema.String })).addSuccess(AssistantHealthResponseSchema))
  .add(HttpApiEndpoint.post("adminAssistantProbeProvider", "/admin/assistant/providers/:id/probe").setPath(Schema.Struct({ id: Schema.String })).addSuccess(AssistantHealthResponseSchema));

const projectAssistantUsageGroup = HttpApiGroup.make("projectAssistantUsage")
  .add(HttpApiEndpoint.get("projectAssistantUsage", "/projects/:slug/assistant/usage").setPath(SlugPath).addSuccess(AssistantUsageResponseSchema));

// MCP server registry: superadmin CRUD + test at /assistant/mcp-servers, plus
// per-project availability keyed by project id (mirrors the assistant-settings
// id-keyed paths). Project reads are member-gated; the replace-set is admin-gated.
const McpServerIdPath = Schema.Struct({ id: Schema.String });
const assistantMcpGroup = HttpApiGroup.make("assistantMcp")
  .add(HttpApiEndpoint.get("listMcpServers", "/assistant/mcp-servers").addSuccess(McpServerListResponse))
  .add(HttpApiEndpoint.post("createMcpServer", "/assistant/mcp-servers").setPayload(McpServerCreatePayload).addSuccess(McpServerSchema, { status: 201 }))
  .add(HttpApiEndpoint.patch("updateMcpServer", "/assistant/mcp-servers/:id").setPath(McpServerIdPath).setPayload(McpServerUpdatePayload).addSuccess(McpServerSchema))
  .add(HttpApiEndpoint.del("deleteMcpServer", "/assistant/mcp-servers/:id").setPath(McpServerIdPath).addSuccess(Schema.Void, { status: 204 }))
  .add(HttpApiEndpoint.post("testMcpServer", "/assistant/mcp-servers/:id/test").setPath(McpServerIdPath).addSuccess(McpTestResponse))
  .add(HttpApiEndpoint.get("listProjectMcpServers", "/projects/:id/assistant/mcp-servers").setPath(McpServerIdPath).addSuccess(ProjectMcpServerListResponse))
  .add(HttpApiEndpoint.put("putProjectMcpServers", "/projects/:id/assistant/mcp-servers").setPath(McpServerIdPath).setPayload(ProjectMcpServersPutPayload).addSuccess(ProjectMcpServerListResponse));


export {
  assistantGroup,
  adminAssistantGroup,
  projectAssistantUsageGroup,
  assistantMcpGroup,
  assistantJevGroup,
};
