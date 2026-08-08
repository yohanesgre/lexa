import { Data } from "effect";

export { UserNotFound, CannotDeleteSelf, LastAdminDemote } from "../services/user.service";

export class TaskNotFound extends Data.TaggedError("TaskNotFound")<{ id: string }> {}
export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{ identifier: string }> {}
export class ColumnNotFound extends Data.TaggedError("ColumnNotFound")<{ id: string }> {}
export class SwimlaneNotFound extends Data.TaggedError("SwimlaneNotFound")<{ id: string; availableSwimlanes?: string[] }> {}
export class WikiPageNotFound extends Data.TaggedError("WikiPageNotFound")<{ id: string }> {}
export class WipLimitExceeded extends Data.TaggedError("WipLimitExceeded")<{ column: string; limit: number; current: number }> {}
export class DeadlineAfterLane extends Data.TaggedError("DeadlineAfterLane")<{
  date: string;                    // the lane's due date (YYYY-MM-DD)
  taskId?: string;                 // first offending task (lane-shrink path)
}> {}
export class BacklogProtected extends Data.TaggedError("BacklogProtected")<{
  action: "archive" | "delete" | "deadline";
}> {}
export class SlugTaken extends Data.TaggedError("SlugTaken")<{ slug: string }> {}
export class HasChildren extends Data.TaggedError("HasChildren")<{ count: number }> {}
export class TaskHasChildren extends Data.TaggedError("TaskHasChildren")<{ taskId: string }> {}
export class NeighborNotInColumn extends Data.TaggedError("NeighborNotInColumn")<{ taskId: string }> {}
export class GithubIssueAlreadyLinked extends Data.TaggedError("GithubIssueAlreadyLinked")<{ taskId: string }> {}
export class RequiredFieldMissing extends Data.TaggedError("RequiredFieldMissing")<{ field: string; column: string }> {}
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
export class ForgeTaskNotFound extends Data.TaggedError("ForgeTaskNotFound")<{ id: string }> {}
export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{ id: string }> {}
export class SkillNotFound extends Data.TaggedError("SkillNotFound")<{ id: string }> {}
export class ForgeBuiltinDelete extends Data.TaggedError("ForgeBuiltinDelete")<{ kind: "agent" | "skill"; name: string }> {}
export class ForgeEntityInUse extends Data.TaggedError("ForgeEntityInUse")<{ kind: "agent" | "skill"; name: string; count: number }> {}
export class RuntimeNotFound extends Data.TaggedError("RuntimeNotFound")<{ id: string }> {}
export class RuntimeEventNotFound extends Data.TaggedError("RuntimeEventNotFound")<{ id: string }> {}
export class MachineNotFound extends Data.TaggedError("MachineNotFound")<{ id: string }> {}
export class MachineIdTaken extends Data.TaggedError("MachineIdTaken")<{ id: string; reason: "hostname" | "legacy" | "secret_mismatch" }> {}
export class MachineSecretMismatch extends Data.TaggedError("MachineSecretMismatch")<{}> {}
export class ApiKeyNotFound extends Data.TaggedError("ApiKeyNotFound")<{ id: string }> {}
export class NoRuntimeOnline extends Data.TaggedError("NoRuntimeOnline")<{}> {}
export class TaskLinkNotFound extends Data.TaggedError("TaskLinkNotFound")<{ id: string }> {}
export class TaskLinkCycle extends Data.TaggedError("TaskLinkCycle")<{ message: string }> {}
export class InvalidTaskLink extends Data.TaggedError("InvalidTaskLink")<{ message: string }> {}
export class CommentNotFound extends Data.TaggedError("CommentNotFound")<{ id: number }> {}
export class CommentEditForbidden extends Data.TaggedError("CommentEditForbidden")<{ id: number }> {}
export class CommentDeleteForbidden extends Data.TaggedError("CommentDeleteForbidden")<{ id: number }> {}
export class CommentInvalid extends Data.TaggedError("CommentInvalid")<{ reason: string }> {}
export class InvalidName extends Data.TaggedError("InvalidName")<{ reason: string }> {}
export class NoUserContext extends Data.TaggedError("NoUserContext")<{}> {}
export { ProjectAccessDenied } from "../services/user-project-role.service";

export const errorCodeMap: Record<string, string> = {
  TaskNotFound: "TASK_NOT_FOUND",
  ProjectNotFound: "PROJECT_NOT_FOUND",
  ColumnNotFound: "COLUMN_NOT_FOUND",
  SwimlaneNotFound: "SWIMLANE_NOT_FOUND",
  WikiPageNotFound: "PAGE_NOT_FOUND",
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
  ForgeTaskNotFound: "FORGE_TASK_NOT_FOUND",
  AgentNotFound: "AGENT_NOT_FOUND",
  SkillNotFound: "SKILL_NOT_FOUND",
  ForgeBuiltinDelete: "FORGE_BUILTIN_DELETE",
  ForgeEntityInUse: "FORGE_ENTITY_IN_USE",
  RuntimeNotFound: "RUNTIME_NOT_FOUND",
  RuntimeEventNotFound: "RUNTIME_EVENT_NOT_FOUND",
  MachineNotFound: "MACHINE_NOT_FOUND",
  MachineIdTaken: "MACHINE_ID_TAKEN",
  MachineSecretMismatch: "FORBIDDEN",
  ApiKeyNotFound: "API_KEY_NOT_FOUND",
  NoRuntimeOnline: "NO_RUNTIME_ONLINE",
  TaskLinkNotFound: "TASK_LINK_NOT_FOUND",
  TaskLinkCycle: "TASK_LINK_CYCLE",
  InvalidTaskLink: "INVALID_TASK_LINK",
  CommentNotFound: "COMMENT_NOT_FOUND",
  CommentEditForbidden: "COMMENT_EDIT_FORBIDDEN",
  CommentDeleteForbidden: "COMMENT_DELETE_FORBIDDEN",
  CommentInvalid: "COMMENT_INVALID",
  InvalidName: "INVALID_NAME",
  NoUserContext: "NO_USER_CONTEXT",
  ProjectAccessDenied: "FORBIDDEN",
  UserNotFound: "USER_NOT_FOUND",
  CannotDeleteSelf: "CANNOT_DELETE_SELF",
  LastAdminDemote: "LAST_ADMIN_DEMOTE",
  ApiKeyNameEmpty: "API_KEY_NAME_EMPTY",
  Forbidden: "FORBIDDEN",
  SetupLocked: "SETUP_LOCKED",
  SearchError: "SEARCH_ERROR",
  ConstraintViolation: "CONSTRAINT",
  DbError: "DATABASE_ERROR",
};

export function errorToStatus(error: { _tag: string }): number {
  switch (error._tag) {
    case "UserNotFound":
      return 404;
    case "CannotDeleteSelf":
    case "ProjectAccessDenied":
    case "Forbidden":
    case "SetupLocked":
    case "MachineSecretMismatch":
    case "CommentEditForbidden":
    case "CommentDeleteForbidden":
      return 403;
    case "TaskNotFound":
    case "ProjectNotFound":
    case "ColumnNotFound":
    case "SwimlaneNotFound":
    case "WikiPageNotFound":
    case "SourceNotFound":
    case "ForgeTaskNotFound":
    case "AgentNotFound":
    case "SkillNotFound":
    case "RuntimeNotFound":
    case "RuntimeEventNotFound":
    case "MachineNotFound":
    case "ApiKeyNotFound":
    case "TaskLinkNotFound":
    case "CommentNotFound":
      return 404;
    case "WipLimitExceeded":
    case "DeadlineAfterLane":
    case "BacklogProtected":
    case "SlugTaken":
    case "HasChildren":
    case "TaskHasChildren":
    case "GithubIssueAlreadyLinked":
    case "OptionInUse":
    case "NoRuntimeOnline":
    case "TaskLinkCycle":
    case "ForgeEntityInUse":
    case "ConstraintViolation":
    case "LastAdminDemote":
    case "MachineIdTaken":
      return 409;
    case "RequiredFieldMissing":
    case "NeighborNotInColumn":
    case "InvalidOption":
    case "InvalidTaskLink":
    case "ForgeBuiltinDelete":
    case "SearchError":
    case "ApiKeyNameEmpty":
    case "SourceUnreachable":
    case "CommentInvalid":
    case "InvalidName":
      return 422;
    case "InvalidKey":
    case "MissingAuth":
      return 401;
    case "GithubWebhookError":
    case "NoUserContext":
      return 400;
    case "GithubApiError":
    case "SourceFetchError":
      return 502;
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
    case "WikiPageNotFound":
      return `Page not found`;
    case "WipLimitExceeded":
      return `Column '${error.column}' is at its WIP limit of ${error.limit}`;
    case "DeadlineAfterLane":
      return `Task deadline cannot be later than the lane's (lane due ${error.date})`;
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
      return `Field '${error.field}' is required in column '${error.column}'`;
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
    case "ForgeTaskNotFound":
      return `Forge task not found`;
    case "AgentNotFound":
      return `Forge agent not found`;
    case "SkillNotFound":
      return `Forge skill not found`;
    case "ForgeBuiltinDelete":
      return `Builtin ${error.kind} '${error.name}' cannot be deleted — edit it or reset it to default instead`;
    case "ForgeEntityInUse":
      return `${error.kind === "agent" ? "Agent" : "Skill"} '${error.name}' is still used by ${error.count} forge task${error.count === 1 ? "" : "s"} — reassign those tasks first`;
    case "RuntimeNotFound":
      return `Runtime not found`;
    case "RuntimeEventNotFound":
      return `Runtime setup event not found`;
    case "MachineNotFound":
      return `Machine not found`;
    case "MachineIdTaken":
      return error.reason === "hostname"
        ? `Machine id '${error.id}' is already registered to another host`
        : `Machine id '${error.id}' has no matching secret — remove it and re-register`;
    case "MachineSecretMismatch":
      return "machine secret mismatch";
    case "ApiKeyNotFound":
      return `API key not found`;
    case "NoRuntimeOnline":
      return `No Forge runtime is online. Start the daemon (bun run forge:daemon) and try again.`;
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
    case "InvalidName":
      return String(error.reason ?? "Invalid name");
    case "NoUserContext":
      return "No user context — this endpoint requires the x-lxk-user header";
    case "CannotDeleteSelf":
      return "Cannot modify your own account";
    case "LastAdminDemote":
      return "Cannot demote the last admin";
    case "ApiKeyNameEmpty":
      return "API key name is required";
    case "ProjectAccessDenied":
      return `Access denied to project '${error.project}'`;
    case "Forbidden":
      return "Admin role required";
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

export function errorDetails(error: { _tag: string } & Record<string, unknown>): Record<string, unknown> {
  const { _tag, ...rest } = error;
  if (_tag === "DbError" || _tag === "ConstraintViolation") {
    // Scrub raw SQLite text (message/cause) from client-visible details; raw
    // detail is preserved in server logs via http.ts respond()'s rawMessage.
    return _tag === "ConstraintViolation" ? { isPositionConflict: rest.isPositionConflict ?? false } : {};
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
