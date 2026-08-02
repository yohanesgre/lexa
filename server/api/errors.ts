import { Data } from "effect";

export { UserNotFound, CannotDeleteSelf } from "../services/user.service";

export class TaskNotFound extends Data.TaggedError("TaskNotFound")<{ id: string }> {}
export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{ identifier: string }> {}
export class ColumnNotFound extends Data.TaggedError("ColumnNotFound")<{ id: string }> {}
export class SwimlaneNotFound extends Data.TaggedError("SwimlaneNotFound")<{ id: string }> {}
export class WikiPageNotFound extends Data.TaggedError("WikiPageNotFound")<{ id: string }> {}
export class WipLimitExceeded extends Data.TaggedError("WipLimitExceeded")<{ column: string; limit: number }> {}
export class SlugTaken extends Data.TaggedError("SlugTaken")<{ slug: string }> {}
export class HasChildren extends Data.TaggedError("HasChildren")<{ count: number }> {}
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
export class SourceNotFound extends Data.TaggedError("SourceNotFound")<{ id: string }> {}
export class SourceFetchError extends Data.TaggedError("SourceFetchError")<{ message: string }> {}
export class SourceUnreachable extends Data.TaggedError("SourceUnreachable")<{ url: string }> {}
export class ForgeTaskNotFound extends Data.TaggedError("ForgeTaskNotFound")<{ id: string }> {}
export class NoRuntimeOnline extends Data.TaggedError("NoRuntimeOnline")<{}> {}
export class TaskLinkNotFound extends Data.TaggedError("TaskLinkNotFound")<{ id: string }> {}
export class TaskLinkCycle extends Data.TaggedError("TaskLinkCycle")<{ message: string }> {}
export class InvalidTaskLink extends Data.TaggedError("InvalidTaskLink")<{ message: string }> {}
export { ProjectAccessDenied } from "../services/user-project-role.service";

export const errorCodeMap: Record<string, string> = {
  TaskNotFound: "TASK_NOT_FOUND",
  ProjectNotFound: "PROJECT_NOT_FOUND",
  ColumnNotFound: "COLUMN_NOT_FOUND",
  SwimlaneNotFound: "SWIMLANE_NOT_FOUND",
  WikiPageNotFound: "PAGE_NOT_FOUND",
  WipLimitExceeded: "WIP_LIMIT",
  SlugTaken: "SLUG_TAKEN",
  HasChildren: "HAS_CHILDREN",
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
  NoRuntimeOnline: "NO_RUNTIME_ONLINE",
  TaskLinkNotFound: "TASK_LINK_NOT_FOUND",
  TaskLinkCycle: "TASK_LINK_CYCLE",
  InvalidTaskLink: "INVALID_TASK_LINK",
  ProjectAccessDenied: "FORBIDDEN",
  UserNotFound: "USER_NOT_FOUND",
  CannotDeleteSelf: "CANNOT_DELETE_SELF",
  Forbidden: "FORBIDDEN",
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
      return 403;
    case "TaskNotFound":
    case "ProjectNotFound":
    case "ColumnNotFound":
    case "SwimlaneNotFound":
    case "WikiPageNotFound":
    case "SourceNotFound":
    case "ForgeTaskNotFound":
    case "TaskLinkNotFound":
      return 404;
    case "WipLimitExceeded":
    case "SlugTaken":
    case "HasChildren":
    case "GithubIssueAlreadyLinked":
    case "OptionInUse":
    case "NoRuntimeOnline":
    case "TaskLinkCycle":
      return 409;
    case "RequiredFieldMissing":
    case "NeighborNotInColumn":
    case "InvalidOption":
    case "InvalidTaskLink":
      return 422;
    case "InvalidKey":
    case "MissingAuth":
      return 401;
    case "GithubWebhookError":
      return 400;
    case "GithubApiError":
      return 502;
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
    case "SlugTaken":
      return `Slug '${error.slug}' is already taken`;
    case "HasChildren":
      return `Resource has ${error.count} children`;
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
    case "CannotDeleteSelf":
      return "Cannot modify your own account";
    case "ProjectAccessDenied":
      return `Access denied to project '${error.project}'`;
    case "ProjectAccessDenied":
      return `Access denied to project '${error.project}'`;
    case "Forbidden":
    case "GithubApiError":
    case "GithubWebhookError":
    case "DbError":
    case "ConstraintViolation":
      return typeof error.message === "string" ? error.message : "Internal server error";
    default:
      return "Internal server error";
  }
}

export function errorDetails(error: { _tag: string } & Record<string, unknown>): Record<string, unknown> {
  const { _tag, ...rest } = error;
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
