import { Data } from "effect";

export { UserNotFound, CannotDeleteSelf } from "../services/user.service";

export class TaskNotFound extends Data.TaggedError("TaskNotFound")<{ id: string }> {}
export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{ identifier: string }> {}
export class ColumnNotFound extends Data.TaggedError("ColumnNotFound")<{ id: string }> {}
export class SwimlaneNotFound extends Data.TaggedError("SwimlaneNotFound")<{ id: string; availableSwimlanes?: string[] }> {}
export class MilestoneNotFound extends Data.TaggedError("MilestoneNotFound")<{ id: string; availableMilestones?: string[] }> {}
export class InvalidArgs extends Data.TaggedError("InvalidArgs")<{ reason: string }> {}
export class WikiPageNotFound extends Data.TaggedError("WikiPageNotFound")<{ id: string }> {}
export class InvalidParent extends Data.TaggedError("InvalidParent")<{ reason: "self" | "cross-project" | "cycle" }> {}
export class ShareLinkNotFound extends Data.TaggedError("ShareLinkNotFound")<{}> {}
export class WipLimitExceeded extends Data.TaggedError("WipLimitExceeded")<{ columnName: string; limit: number; current: number }> {}
export class DeadlineAfterLane extends Data.TaggedError("DeadlineAfterLane")<{
  date: string;                    // the lane's due date (YYYY-MM-DD)
  taskId?: string;                 // first offending task (lane-shrink path)
  taskTitle?: string;              // its title, for the message
}> {}
export class BacklogProtected extends Data.TaggedError("BacklogProtected")<{
  action: "archive" | "delete" | "deadline";
}> {}
export class SlugTaken extends Data.TaggedError("SlugTaken")<{ slug: string }> {}
export class HasChildren extends Data.TaggedError("HasChildren")<{ count: number }> {}
export class TaskHasChildren extends Data.TaggedError("TaskHasChildren")<{ taskId: string }> {}
export class NeighborNotInColumn extends Data.TaggedError("NeighborNotInColumn")<{ taskId: string }> {}
export class GithubIssueAlreadyLinked extends Data.TaggedError("GithubIssueAlreadyLinked")<{ taskId: string }> {}
export class RequiredFieldMissing extends Data.TaggedError("RequiredFieldMissing")<{ field: string; columnName: string }> {}
export class OptionInUse extends Data.TaggedError("OptionInUse")<{ optionId: string; label: string }> {}
export class InvalidOption extends Data.TaggedError("InvalidOption")<{ optionId?: string; message?: string }> {}
export class InvalidKey extends Data.TaggedError("InvalidKey")<{}> {}
export class MissingAuth extends Data.TaggedError("MissingAuth")<{}> {}
export class GithubApiError extends Data.TaggedError("GithubApiError")<{ message: string }> {}
export class GithubWebhookError extends Data.TaggedError("GithubWebhookError")<{ message: string }> {}
export class Forbidden extends Data.TaggedError("Forbidden")<{ message: string }> {}
export class SetupLocked extends Data.TaggedError("SetupLocked")<{}> {}
export class SearchError extends Data.TaggedError("SearchError")<{}> {}
export class SourceNotFound extends Data.TaggedError("SourceNotFound")<{ id: string }> {}
export class SourceFetchError extends Data.TaggedError("SourceFetchError")<{ message: string }> {}
export class SourceUnreachable extends Data.TaggedError("SourceUnreachable")<{ url: string }> {}
export class AssistantTaskNotFound extends Data.TaggedError("AssistantTaskNotFound")<{ id: string }> {}
export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{ id: string }> {}
export class SkillNotFound extends Data.TaggedError("SkillNotFound")<{ id: string }> {}
export class AgentBuiltinDelete extends Data.TaggedError("AgentBuiltinDelete")<{ kind: "agent" | "skill"; name: string }> {}
export class AgentEntityInUse extends Data.TaggedError("AgentEntityInUse")<{ kind: "agent" | "skill"; name: string; count: number }> {}
export class ApiKeyNotFound extends Data.TaggedError("ApiKeyNotFound")<{ id: string }> {}
export class TaskLinkNotFound extends Data.TaggedError("TaskLinkNotFound")<{ id: string }> {}
export class TaskLinkCycle extends Data.TaggedError("TaskLinkCycle")<{ message: string }> {}
export class InvalidTaskLink extends Data.TaggedError("InvalidTaskLink")<{ message: string }> {}
export class CommentNotFound extends Data.TaggedError("CommentNotFound")<{ id: number }> {}
export class CommentEditForbidden extends Data.TaggedError("CommentEditForbidden")<{ id: number }> {}
export class CommentDeleteForbidden extends Data.TaggedError("CommentDeleteForbidden")<{ id: number }> {}
export class CommentInvalid extends Data.TaggedError("CommentInvalid")<{ reason: string }> {}
export class AttachmentNotFound extends Data.TaggedError("AttachmentNotFound")<{ id: string }> {}
export class PayloadTooLarge extends Data.TaggedError("PayloadTooLarge")<{ size: number; maxBytes: number; filename?: string }> {}
export class AttachmentDeleteForbidden extends Data.TaggedError("AttachmentDeleteForbidden")<{ id: string }> {}
// Operator kill switch (LXK_DISABLE_CHAT_ATTACHMENTS=1): uploads and sends
// carrying attachments are refused regardless of the capability flag.
export class ChatAttachmentsDisabled extends Data.TaggedError("ChatAttachmentsDisabled")<{}> {}
// Operator kill switch (LXK_DISABLE_TASKS_BULK=1): the bulk task endpoint is
// refused regardless of the capability flag — no partial write.
export class TasksBulkDisabled extends Data.TaggedError("TasksBulkDisabled")<{}> {}
// A document attachment's bytes could not be turned into model-visible text
// (unreadable PDF, non-UTF-8 text). The send is blocked; the file is named.
export class AttachmentExtractionFailed extends Data.TaggedError("AttachmentExtractionFailed")<{ filename: string; reason: string }> {}
export class InvalidName extends Data.TaggedError("InvalidName")<{ reason: string }> {}
export class InvalidRateLimit extends Data.TaggedError("InvalidRateLimit")<{ reason: string }> {}
export class InvalidGithubSettings extends Data.TaggedError("InvalidGithubSettings")<{ reason: string }> {}
// LX-6 manifest connect flow. StateInvalid covers unknown, already-used,
// expired, and cancelled attempts with one code (no oracle); ExchangeFailed is
// the GitHub-side handshake; PermissionsDenied is a created App that lacks the
// required scopes; SecretWriteFailed is a Lexa-side storage failure (missing or
// invalid master key, DB error) on the encrypted write path.
export class GithubManifestStateInvalid extends Data.TaggedError("GithubManifestStateInvalid")<{}> {}
export class GithubManifestExchangeFailed extends Data.TaggedError("GithubManifestExchangeFailed")<{ message: string }> {}
export class GithubManifestPermissionsDenied extends Data.TaggedError("GithubManifestPermissionsDenied")<{}> {}
export class GithubSecretWriteFailed extends Data.TaggedError("GithubSecretWriteFailed")<{ message: string }> {}
export class NoUserContext extends Data.TaggedError("NoUserContext")<{}> {}
export class NoUserContextForbidden extends Data.TaggedError("NoUserContextForbidden")<{}> {}
export class DeviceLoginNotFound extends Data.TaggedError("DeviceLoginNotFound")<{}> {}
export class DeviceLoginExpired extends Data.TaggedError("DeviceLoginExpired")<{}> {}
export class DeviceLoginDenied extends Data.TaggedError("DeviceLoginDenied")<{}> {}
export class ProviderNotConfigured extends Data.TaggedError("ProviderNotConfigured")<{ projectId: string }> {}
export class ProviderAuthFailed extends Data.TaggedError("ProviderAuthFailed")<{
  message?: string;
  status?: number | null;
  providerMessage?: string | null;
  raw?: string | null;
  rawEvent?: string | null;
  upstreamBody?: string | null;
  retryAfter?: number | null;
  attempts?: unknown;
  errorTag?: string | null;
}> {}
export class ProviderUnreachable extends Data.TaggedError("ProviderUnreachable")<{
  message?: string;
  status?: number | null;
  providerMessage?: string | null;
  raw?: string | null;
  rawEvent?: string | null;
  upstreamBody?: string | null;
  retryAfter?: number | null;
  attempts?: unknown;
  errorTag?: string | null;
}> {}
export class AssistantGenerationFailed extends Data.TaggedError("AssistantGenerationFailed")<{
  message: string;
  status?: number | null;
  providerMessage?: string | null;
  raw?: string | null;
  rawEvent?: string | null;
  upstreamBody?: string | null;
  retryAfter?: number | null;
  attempts?: unknown;
  errorTag?: string | null;
}> {}
export class AssistantToolBudgetExceeded extends Data.TaggedError("AssistantToolBudgetExceeded")<{ rounds: number }> {}
export class AssistantTaskActive extends Data.TaggedError("AssistantTaskActive")<{}> {}
export class AssistantThreadNotFound extends Data.TaggedError("AssistantThreadNotFound")<{ documentType: string; documentId: string }> {}
export class VisionNotConfigured extends Data.TaggedError("VisionNotConfigured")<{}> {}
export class ApprovalNotFound extends Data.TaggedError("ApprovalNotFound")<{ id: string }> {}
export class ApprovalExpired extends Data.TaggedError("ApprovalExpired")<{ id: string }> {}
export class ApprovalAlreadyDecided extends Data.TaggedError("ApprovalAlreadyDecided")<{ id: string; status: string }> {}
export class ApprovalsPending extends Data.TaggedError("ApprovalsPending")<{ batchId: string; remaining: number }> {}
export class ToolDenied extends Data.TaggedError("ToolDenied")<{ message: string }> {}
export class McpServerNotFound extends Data.TaggedError("McpServerNotFound")<{ id: string }> {}
export class McpInvalidTransportConfig extends Data.TaggedError("McpInvalidTransportConfig")<{ reason: string }> {}
// Reserved, no longer emitted: local stdio MCP clients were removed (migration
// 0010 deletes the stored rows; application validation rejects the payload with
// McpInvalidTransportConfig on every runtime). The class, its MCP_STDIO_UNAVAILABLE
// code, and its 400 status stay in the catalog so an older stored code still maps
// to a real response.
export class McpStdioUnavailable extends Data.TaggedError("McpStdioUnavailable")<{}> {}
export class McpConnectFailed extends Data.TaggedError("McpConnectFailed")<{ message?: string }> {}
export class McpToolCallFailed extends Data.TaggedError("McpToolCallFailed")<{ message?: string }> {}
// Jev registry: the managed key cannot be stored because the secrets keyring is
// unavailable or malformed (mirrors the MCP managed-secret refusal).
export class SecretKeyUnavailable extends Data.TaggedError("SecretKeyUnavailable")<{ reason: string }> {}
// A Jev config payload the contract refuses (invalid base URL, model length,
// or a clear/secret conflict).
export class JevInvalidConfig extends Data.TaggedError("JevInvalidConfig")<{ reason: string }> {}
// Jev rejected the stored API key (401/403 upstream).
export class JevAuthFailed extends Data.TaggedError("JevAuthFailed")<{ message?: string }> {}
// Jev could not be reached or answered unreadably (transport/5xx).
export class JevUnreachable extends Data.TaggedError("JevUnreachable")<{ message?: string }> {}
export { ProjectAccessDenied } from "../services/user-project-role.service";

export const errorCodeMap: Record<string, string> = {
  TaskNotFound: "TASK_NOT_FOUND",
  ProjectNotFound: "PROJECT_NOT_FOUND",
  ColumnNotFound: "COLUMN_NOT_FOUND",
  SwimlaneNotFound: "SWIMLANE_NOT_FOUND",
  MilestoneNotFound: "MILESTONE_NOT_FOUND",
  InvalidArgs: "INVALID_ARGS",
  WikiPageNotFound: "PAGE_NOT_FOUND",
  InvalidParent: "INVALID_PARENT",
  ShareLinkNotFound: "SHARE_LINK_NOT_FOUND",
  WipLimitExceeded: "WIP_LIMIT",
  DeadlineAfterLane: "DEADLINE_AFTER_LANE",
  BacklogProtected: "BACKLOG_PROTECTED",
  SlugTaken: "SLUG_TAKEN",
  HasChildren: "HAS_CHILDREN",
  TaskHasChildren: "TASK_HAS_CHILDREN",
  NeighborNotInColumn: "NEIGHBOR_NOT_IN_COLUMN",
  GithubIssueAlreadyLinked: "ALREADY_LINKED",
  RequiredFieldMissing: "REQUIRED_FIELD",
  OptionInUse: "OPTION_IN_USE",
  InvalidOption: "INVALID_OPTION",
  InvalidKey: "INVALID_API_KEY",
  MissingAuth: "MISSING_AUTH",
  GithubApiError: "GITHUB_API_ERROR",
  GithubWebhookError: "GITHUB_WEBHOOK_ERROR",
  SourceNotFound: "SOURCE_NOT_FOUND",
  SourceFetchError: "SOURCE_FETCH_ERROR",
  SourceUnreachable: "SOURCE_UNREACHABLE",
  AssistantTaskNotFound: "ASSISTANT_TASK_NOT_FOUND",
  AgentNotFound: "AGENT_NOT_FOUND",
  SkillNotFound: "SKILL_NOT_FOUND",
  AgentBuiltinDelete: "AGENT_BUILTIN_DELETE",
  AgentEntityInUse: "AGENT_ENTITY_IN_USE",
  ApiKeyNotFound: "API_KEY_NOT_FOUND",
  TaskLinkNotFound: "TASK_LINK_NOT_FOUND",
  TaskLinkCycle: "TASK_LINK_CYCLE",
  InvalidTaskLink: "INVALID_TASK_LINK",
  CommentNotFound: "COMMENT_NOT_FOUND",
  CommentEditForbidden: "COMMENT_EDIT_FORBIDDEN",
  CommentDeleteForbidden: "COMMENT_DELETE_FORBIDDEN",
  CommentInvalid: "COMMENT_INVALID",
  AttachmentNotFound: "ATTACHMENT_NOT_FOUND",
  PayloadTooLarge: "PAYLOAD_TOO_LARGE",
  AttachmentDeleteForbidden: "ATTACHMENT_DELETE_FORBIDDEN",
  ChatAttachmentsDisabled: "CHAT_ATTACHMENTS_DISABLED",
  TasksBulkDisabled: "TASKS_BULK_DISABLED",
  AttachmentExtractionFailed: "ATTACHMENT_EXTRACTION_FAILED",
  InvalidName: "INVALID_NAME",
  InvalidRateLimit: "INVALID_RATE_LIMIT",
  InvalidGithubSettings: "INVALID_GITHUB_SETTINGS",
  GithubManifestStateInvalid: "GITHUB_MANIFEST_STATE_INVALID",
  GithubManifestExchangeFailed: "GITHUB_MANIFEST_EXCHANGE_FAILED",
  GithubManifestPermissionsDenied: "GITHUB_MANIFEST_PERMISSIONS_DENIED",
  GithubSecretWriteFailed: "GITHUB_SECRET_WRITE_FAILED",
  NoUserContext: "NO_USER_CONTEXT",
  NoUserContextForbidden: "NO_USER_CONTEXT",
  DeviceLoginNotFound: "DEVICE_LOGIN_NOT_FOUND",
  DeviceLoginExpired: "DEVICE_LOGIN_EXPIRED",
  DeviceLoginDenied: "DEVICE_LOGIN_DENIED",
  ProjectAccessDenied: "FORBIDDEN",
  UserNotFound: "USER_NOT_FOUND",
  CannotDeleteSelf: "CANNOT_DELETE_SELF",
  ApiKeyNameEmpty: "API_KEY_NAME_EMPTY",
  Forbidden: "FORBIDDEN",
  SetupLocked: "SETUP_LOCKED",
  SearchError: "SEARCH_ERROR",
  ProviderNotConfigured: "PROVIDER_NOT_CONFIGURED",
  ProviderAuthFailed: "PROVIDER_AUTH_FAILED",
  ProviderUnreachable: "PROVIDER_UNREACHABLE",
  AssistantGenerationFailed: "ASSISTANT_GENERATION_FAILED",
  AssistantToolBudgetExceeded: "ASSISTANT_TOOL_BUDGET_EXCEEDED",
  AssistantTaskActive: "ASSISTANT_TASK_ACTIVE",
  AssistantThreadNotFound: "ASSISTANT_THREAD_NOT_FOUND",
  VisionNotConfigured: "VISION_NOT_CONFIGURED",
  ApprovalNotFound: "APPROVAL_NOT_FOUND",
  ApprovalExpired: "APPROVAL_EXPIRED",
  ApprovalAlreadyDecided: "APPROVAL_ALREADY_DECIDED",
  ApprovalsPending: "APPROVALS_PENDING",
  ToolDenied: "TOOL_DENIED",
  McpServerNotFound: "MCP_SERVER_NOT_FOUND",
  McpInvalidTransportConfig: "MCP_INVALID_TRANSPORT_CONFIG",
  McpStdioUnavailable: "MCP_STDIO_UNAVAILABLE",
  McpConnectFailed: "MCP_CONNECT_FAILED",
  McpToolCallFailed: "MCP_TOOL_CALL_FAILED",
  SecretKeyUnavailable: "SECRET_KEY_UNAVAILABLE",
  JevInvalidConfig: "JEV_INVALID_CONFIG",
  JevAuthFailed: "JEV_AUTH_FAILED",
  JevUnreachable: "JEV_UNREACHABLE",
  RowNotFound: "NOT_FOUND",
  ConstraintViolation: "CONSTRAINT",
  DbError: "DATABASE_ERROR",
  TeamNotFound: "TEAM_NOT_FOUND",
  TeamHasProjects: "TEAM_HAS_PROJECTS",
  SoleOwner: "SOLE_OWNER",
  TeamMemberNotFound: "USER_NOT_FOUND",
  MemberNotInWorkspace: "NOT_WORKSPACE_MEMBER",
  InviteNotFound: "INVITE_NOT_FOUND",
  InviteAlreadyPending: "INVITE_PENDING",
  SessionNotFound: "SESSION_NOT_FOUND",
  TeamSlugTaken: "SLUG_TAKEN",
  WorkspaceUserNotFound: "USER_NOT_FOUND",
  PasswordLinkIssueFailed: "PASSWORD_LINK_FAILED",
};

export function errorToStatus(error: { _tag: string }): number {
  switch (error._tag) {
    case "UserNotFound":
      return 404;
    case "CannotDeleteSelf":
    case "ProjectAccessDenied":
    case "Forbidden":
    case "SetupLocked":
    case "CommentEditForbidden":
    case "CommentDeleteForbidden":
    case "AttachmentDeleteForbidden":
    case "ChatAttachmentsDisabled":
    case "TasksBulkDisabled":
    case "SoleOwner":
      return 403;
    case "PayloadTooLarge":
      return 413;
    case "TaskNotFound":
    case "ProjectNotFound":
    case "ColumnNotFound":
    case "SwimlaneNotFound":
    case "MilestoneNotFound":
    case "WikiPageNotFound":
    case "ShareLinkNotFound":
    case "SourceNotFound":
    case "AssistantTaskNotFound":
    case "AgentNotFound":
    case "SkillNotFound":
    case "ApiKeyNotFound":
    case "TaskLinkNotFound":
    case "CommentNotFound":
    case "AttachmentNotFound":
    case "TeamNotFound":
    case "TeamMemberNotFound":
    case "InviteNotFound":
    case "WorkspaceUserNotFound":
    case "SessionNotFound":
    case "AssistantThreadNotFound":
    case "ApprovalNotFound":
    case "McpServerNotFound":
    case "RowNotFound":
      return 404;
    case "WipLimitExceeded":
    case "DeadlineAfterLane":
    case "BacklogProtected":
    case "SlugTaken":
    case "TeamSlugTaken":
    case "HasChildren":
    case "TaskHasChildren":
    case "GithubIssueAlreadyLinked":
    case "OptionInUse":
    case "TaskLinkCycle":
    case "AgentEntityInUse":
    case "ProviderNotConfigured":
    case "AssistantTaskActive":
    case "VisionNotConfigured":
    case "ApprovalExpired":
    case "ApprovalAlreadyDecided":
    case "ApprovalsPending":
    case "ConstraintViolation":
    case "TeamHasProjects":
    case "InviteAlreadyPending":
      return 409;
    case "RequiredFieldMissing":
    case "NeighborNotInColumn":
    case "InvalidOption":
    case "InvalidParent":
    case "InvalidTaskLink":
    case "AgentBuiltinDelete":
    case "SearchError":
    case "ApiKeyNameEmpty":
    case "SourceUnreachable":
    case "CommentInvalid":
    case "InvalidName":
    case "InvalidArgs":
    case "InvalidRateLimit":
    case "InvalidGithubSettings":
    case "GithubManifestPermissionsDenied":
    case "MemberNotInWorkspace":
    case "AttachmentExtractionFailed":
      return 422;
    case "ToolDenied":
      return 403;
    case "McpInvalidTransportConfig":
    case "McpStdioUnavailable":
    case "SecretKeyUnavailable":
    case "JevInvalidConfig":
    case "GithubManifestStateInvalid":
      return 400;
    case "InvalidKey":
    case "MissingAuth":
      return 401;
    case "GithubWebhookError":
    case "NoUserContext":
      return 400;
    case "NoUserContextForbidden":
    case "DeviceLoginDenied":
      return 403;
    case "DeviceLoginExpired":
      return 410;
    case "DeviceLoginNotFound":
      return 404;
    case "GithubApiError":
    case "GithubManifestExchangeFailed":
    case "SourceFetchError":
    case "ProviderAuthFailed":
    case "ProviderUnreachable":
    case "AssistantGenerationFailed":
    case "AssistantToolBudgetExceeded":
    case "McpConnectFailed":
    case "McpToolCallFailed":
    case "JevAuthFailed":
    case "JevUnreachable":
      return 502;
    case "GithubSecretWriteFailed":
    case "DbError":
      return 500;
    default:
      return 500;
  }
}

export function errorMessage(error: { _tag: string } & Record<string, unknown>): string {
  switch (error._tag) {
    case "TaskNotFound":
      return `Task not found`;
    case "ProjectNotFound":
      return `Project not found`;
    case "ColumnNotFound":
      return `Column not found`;
    case "SwimlaneNotFound":
      return `Swimlane not found`;
    case "MilestoneNotFound":
      return `Milestone not found`;
    case "InvalidArgs":
      return String(error.reason ?? "Invalid arguments");
    case "WikiPageNotFound":
      return `Page not found`;
    case "InvalidParent":
      return error.reason === "self"
        ? "A page cannot be its own parent"
        : error.reason === "cross-project"
          ? "Parent page belongs to another project"
          : "Reparenting would create a cycle";
    case "ShareLinkNotFound":
      return `Share link not found`;
    case "WipLimitExceeded":
      return `Column '${error.columnName}' is at its WIP limit of ${error.limit}`;
    case "DeadlineAfterLane":
      return error.taskTitle
        ? `Task '${error.taskTitle}' has a deadline later than the lane's (lane due ${error.date})`
        : `Task deadline cannot be later than the lane's (lane due ${error.date})`;
    case "BacklogProtected":
      return `The Backlog lane is protected (${error.action} not allowed)`;
    case "SlugTaken":
      return `Slug '${error.slug}' is already taken`;
    case "HasChildren":
      return `Resource has ${error.count} children`;
    case "TaskHasChildren":
      return `Task has subtasks — delete or unlink them first`;
    case "NeighborNotInColumn":
      return `Neighbor task ${error.taskId} is not in the target column`;
    case "GithubIssueAlreadyLinked":
      return `Task already has a GitHub issue`;
    case "RequiredFieldMissing":
      return `Field '${error.field}' is required in column '${error.columnName}'`;
    case "OptionInUse":
      return `Option '${error.label}' is still used by tasks. Reassign those tasks first.`;
    case "InvalidOption":
      return typeof error.message === "string" && error.message
        ? error.message
        : `Unknown option id '${error.optionId ?? ""}'`;
    case "SourceNotFound":
      return `Source not found`;
    case "SourceFetchError":
      return typeof error.message === "string" && error.message ? error.message : "Failed to fetch source";
    case "SourceUnreachable":
      return `Cannot reach '${error.url}'`;
    case "AssistantTaskNotFound":
      return `AI task not found`;
    case "AgentNotFound":
      return `AI agent not found`;
    case "SkillNotFound":
      return `AI skill not found`;
    case "AgentBuiltinDelete":
      return `Builtin ${error.kind} '${error.name}' cannot be deleted — edit it or reset it to default instead`;
    case "AgentEntityInUse":
      return `${error.kind === "agent" ? "Agent" : "Skill"} '${error.name}' is still used by ${error.count} AI task${error.count === 1 ? "" : "s"} — reassign those tasks first`;
    case "ApiKeyNotFound":
      return `API key not found`;
    case "TaskLinkNotFound":
      return `Task link not found`;
    case "TaskLinkCycle":
      return typeof error.message === "string" && error.message ? error.message : "Task link would create a cycle";
    case "InvalidTaskLink":
      return typeof error.message === "string" && error.message ? error.message : "Invalid task link";
    case "InvalidKey":
    case "MissingAuth":
      return "Invalid or missing API key";
    case "UserNotFound":
      return "User not found";
    case "CommentNotFound":
      return "Comment not found";
    case "CommentEditForbidden":
      return "You can only edit your own comments";
    case "CommentDeleteForbidden":
      return "You can only delete your own comments (or an admin's)";
    case "CommentInvalid":
      return String(error.reason ?? "Invalid comment");
    case "AttachmentNotFound":
      return "Attachment not found";
    case "PayloadTooLarge": {
      const limit = `${Math.round(Number(error.maxBytes ?? 0) / (1024 * 1024))} MB`;
      return typeof error.filename === "string" && error.filename !== ""
        ? `File '${error.filename}' exceeds the ${limit} upload limit`
        : `Attachment exceeds the ${limit} upload limit`;
    }
    case "AttachmentDeleteForbidden":
      return "You can only delete your own attachments (or an admin's)";
    case "ChatAttachmentsDisabled":
      return "Chat attachments are disabled on this server";
    case "TasksBulkDisabled":
      return "Bulk task actions are disabled on this server";
    case "AttachmentExtractionFailed":
      return typeof error.reason === "string" && error.reason !== ""
        ? `Could not read '${error.filename}': ${error.reason}`
        : `Could not read '${error.filename}'`;
    case "InvalidName":
      return String(error.reason ?? "Invalid name");
    case "InvalidRateLimit":
      return String(error.reason ?? "Invalid rate limit");
    case "InvalidGithubSettings":
      return String(error.reason ?? "Invalid GitHub settings");
    // Fixed, cause-neutral messages: an upstream body or a storage detail is
    // never echoed to the client. The callback surface varies copy by code.
    case "GithubManifestStateInvalid":
      return "GitHub connection link is invalid or expired";
    case "GithubManifestExchangeFailed":
      return "GitHub could not complete the manifest handshake";
    case "GithubManifestPermissionsDenied":
      return "The GitHub App was created without the required permissions";
    case "GithubSecretWriteFailed":
      return "GitHub credentials could not be stored on this server";
    case "NoUserContext":
    case "NoUserContextForbidden":
      return "No user context — this endpoint needs a session or a key bound to a user";
    case "DeviceLoginNotFound":
      return "Device login request not found";
    case "DeviceLoginExpired":
      return "Device login request expired";
    case "DeviceLoginDenied":
      return "Device login request denied";
    case "ProviderNotConfigured":
      return `Assistant provider is not configured for this project — enable at least one model in Workspace → Assistant Providers`;
    case "ProviderAuthFailed":
      return typeof error.message === "string" && error.message ? error.message : "The AI provider rejected the API key";
    case "ProviderUnreachable":
      return typeof error.message === "string" && error.message ? error.message : "The AI provider could not be reached";
    case "AssistantGenerationFailed":
      return String(error.message ?? "Assistant generation failed");
    case "AssistantToolBudgetExceeded":
      return `Assistant exceeded its tool budget (${error.rounds} rounds)`;
    case "AssistantTaskActive":
      return `An Assistant task is still running for this document — reset once it finishes`;
    case "AssistantThreadNotFound":
      return `No Assistant thread exists for ${error.documentType} '${error.documentId}'`;
    case "VisionNotConfigured":
      return `Image attachments need vision — enable primary image support or configure a vision model in Settings`;
    case "ApprovalNotFound":
      return "Approval not found";
    case "ApprovalExpired":
      return "Approval expired — write not executed.";
    case "ApprovalAlreadyDecided":
      return `Approval already decided (${error.status})`;
    case "ApprovalsPending":
      return `${error.remaining} approval(s) still pending in batch '${error.batchId}' — decide them before resuming`;
    case "ToolDenied":
      return String(error.message ?? "Write denied: insufficient permissions.");
    case "McpServerNotFound":
      return "MCP server not found";
    case "McpInvalidTransportConfig":
      return String(error.reason ?? "Invalid MCP transport configuration");
    case "McpStdioUnavailable":
      return "stdio MCP clients are not supported — the registry connects to remote http/sse servers only";
    case "McpConnectFailed":
      return typeof error.message === "string" && error.message ? error.message : "Could not connect to the MCP server";
    case "McpToolCallFailed":
      return typeof error.message === "string" && error.message ? error.message : "MCP tool call failed";
    case "SecretKeyUnavailable":
      return String(error.reason ?? "Managed secrets are not configured on this server");
    case "JevInvalidConfig":
      return String(error.reason ?? "Invalid Jev configuration");
    case "JevAuthFailed":
      return typeof error.message === "string" && error.message ? error.message : "Jev rejected the API key";
    case "JevUnreachable":
      return typeof error.message === "string" && error.message ? error.message : "Jev could not be reached";
    case "RowNotFound":
      return "Resource not found";
    case "CannotDeleteSelf":
      return "Cannot modify your own account";
    case "ApiKeyNameEmpty":
      return "API key name is required";
    case "ProjectAccessDenied":
      return `Access denied to project '${error.project}'`;
    case "Forbidden":
      return "Admin role required";
    case "SoleOwner":
      return String(error.message ?? "Cannot modify the last owner — transfer ownership first");
    case "TeamHasProjects":
      return `Team still owns ${error.count} project(s) — reassign them first`;
    case "TeamNotFound":
      return "Team not found";
    case "MemberNotInWorkspace":
      return `'${error.email}' is not a workspace member — invite them via the superadmin first`;
    case "InviteNotFound":
      return "Invite not found";
    case "InviteAlreadyPending":
      return `An invite is already pending for '${error.email}'`;
    case "SessionNotFound":
      return "Session not found";
    case "SetupLocked":
      return "Setup is already complete — the wizard only runs on first install";
    case "SearchError":
      return "Search query is invalid — try simpler terms";
    case "GithubApiError":
    case "GithubWebhookError":
      return typeof error.message === "string" ? error.message : "Internal server error";
    case "DbError":
      // Raw SQLite text stays server-side (logged in http.ts respond) — never
      // leak it to clients.
      return "Database error";
    case "ConstraintViolation":
      return "Constraint violation";
    default:
      return "Internal server error";
  }
}

// Provider errors carry provider diagnostics (`raw`, `rawEvent`,
// `upstreamBody`, `attempts`) used only for server-side logs. Only the fields
// the API contract exposes cross the boundary.
const PROVIDER_ERROR_TAGS = new Set(["ProviderAuthFailed", "ProviderUnreachable", "AssistantGenerationFailed"]);
const PROVIDER_ERROR_DETAIL_KEYS = ["message", "status", "providerMessage", "retryAfter", "errorTag"] as const;

export function errorDetails(error: { _tag: string } & Record<string, unknown>): Record<string, unknown> {
  const { _tag, ...rest } = error;
  if (PROVIDER_ERROR_TAGS.has(_tag)) {
    // `message` is Error.message (non-enumerable), so the spread misses it —
    // read it off the error itself for the allowlist.
    const source: Record<string, unknown> = { ...rest, message: (error as { message?: unknown }).message };
    const details: Record<string, unknown> = {};
    for (const key of PROVIDER_ERROR_DETAIL_KEYS) {
      if (source[key] !== undefined) details[key] = source[key];
    }
    return details;
  }
  if (_tag === "DbError" || _tag === "ConstraintViolation") {
    // Scrub raw SQLite text (message/cause) from client-visible details; raw
    // detail is preserved in server logs via http.ts respond()'s rawMessage.
    return _tag === "ConstraintViolation" ? { isPositionConflict: rest.isPositionConflict ?? false } : {};
  }
  if (_tag === "WipLimitExceeded" || _tag === "RequiredFieldMissing") {
    // Effect's Data.TaggedError drops a field literally named `column` from
    // own enumerable keys (JSON/spread lose it). The internal field is
    // `columnName`; map it back to the public `column` contract here.
    const { columnName, ...rest2 } = rest;
    return { ...rest2, column: columnName };
  }
  return rest;
}

export function errorResponse(error: { _tag: string } & Record<string, unknown>): {
  error: { code: string; message: string; details: Record<string, unknown> };
} {
  return {
    error: {
      code: errorCodeMap[error._tag] ?? "INTERNAL",
      message: errorMessage(error),
      details: errorDetails(error),
    },
  };
}
