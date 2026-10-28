// The 22-tool inbound MCP catalog. Every tool maps to one approved REST
// operation and returns that operation's persisted response. Nothing here
// touches SQL or a service directly: `dispatch` replays the authenticated route
// in-process (see rest.ts), so route-level orchestration — including GitHub
// state sync on task moves — keeps running exactly as it does for REST/UI.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpInvalidPathSegmentError, type McpRestCall, type McpRestDispatch } from "./rest";

export const MCP_SERVER_INFO = { name: "lexa", version: "1.0.0" } as const;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const ADDITIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const REPLACING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const IDEMPOTENT_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const UNCERTAIN = "The outcome is uncertain — read the current state before retrying.";

const projectSlug = z.string().min(1).describe("Project slug (from lexa_list_projects).");
const taskId = z.string().min(1).describe("Task UUID or immutable ticket key (for example NIM-12).");
const pageSlug = z.string().min(1).describe("Wiki page slug.");
const dueAt = z
  .string()
  .nullable()
  .optional()
  .describe("Date-only deadline (YYYY-MM-DD); null clears it, omitted leaves it unchanged.");
const limit = z.number().int().min(1).max(200).describe("Page size (1-200, REST default 50).");
const cursor = z.string().min(1).describe("Opaque cursor from a previous page.");

function projectPath(slug: string, suffix = ""): string {
  return `/api/projects/${encodeURIComponent(slug)}${suffix}`;
}

function withQuery(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

function readRestError(payload: unknown): { code: string; message: string; details?: unknown } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof code !== "string") return null;
  return {
    code,
    message: typeof message === "string" ? message : code,
    ...(details !== undefined ? { details } : {}),
  };
}

function statusCode(status: number): string {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 413) return "BODY_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL";
  return "INVALID_ARGS";
}

// Domain failures keep the REST code/message/details and arrive as MCP tool
// errors — never as an empty success result.
function failure(code: string, message: string, details?: unknown, note?: string): CallToolResult {
  const detailText = details !== undefined ? `\n${JSON.stringify(details)}` : "";
  const noteText = note ? `\n${note}` : "";
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}${detailText}${noteText}` }],
    structuredContent: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
  };
}

async function invoke(dispatch: McpRestDispatch, call: McpRestCall, readOnly: boolean): Promise<CallToolResult> {
  let response: Response;
  try {
    response = await dispatch(call);
  } catch (error) {
    // A rejected path segment never reaches the route stack; it is an invalid
    // tool argument, not an uncertain write.
    if (error instanceof McpInvalidPathSegmentError) {
      return failure("INVALID_ARGS", `Invalid path segment ${JSON.stringify(error.segment)}.`);
    }
    return failure(
      "INTERNAL",
      "The operation did not complete inside the server.",
      undefined,
      readOnly ? undefined : UNCERTAIN
    );
  }
  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  let parsed = text.length === 0;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  if (!response.ok) {
    const error = readRestError(payload);
    if (error) return failure(error.code, error.message, error.details);
    return failure(statusCode(response.status), `The operation failed with HTTP ${response.status}.`);
  }
  if (!parsed || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return failure(
      "INTERNAL",
      "The operation returned an unreadable response.",
      undefined,
      readOnly ? undefined : UNCERTAIN
    );
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function registerLexaTools(server: McpServer, dispatch: McpRestDispatch): void {
  // ── Discovery ──────────────────────────────────────────────────────────
  server.registerTool(
    "lexa_list_projects",
    {
      title: "List projects",
      description: "List the Lexa projects this key's owner can open, with each project's slug, ticket key prefix, and repos.",
      annotations: READ_ONLY,
    },
    () => invoke(dispatch, { method: "GET", path: "/api/projects" }, true)
  );

  server.registerTool(
    "lexa_get_project",
    {
      title: "Get project",
      description: "Read one Lexa project by slug (name, ticket key prefix, description, repos, team).",
      inputSchema: { projectSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug }) => invoke(dispatch, { method: "GET", path: projectPath(slug) }, true)
  );

  server.registerTool(
    "lexa_get_board",
    {
      title: "Get board",
      description:
        "Read the project's full unpaginated board snapshot: project, columns, swimlanes, milestones, field config, task links, and all board tasks. Board rows omit the task description; read a task for its Markdown.",
      inputSchema: {
        projectSlug,
        includeArchived: z.boolean().optional().describe("Include archived tasks and lanes (REST default false)."),
      },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug, includeArchived }) =>
      invoke(
        dispatch,
        {
          method: "GET",
          path: withQuery(projectPath(slug, "/board"), {
            includeArchived: includeArchived === true ? "true" : undefined,
          }),
        },
        true
      )
  );

  server.registerTool(
    "lexa_list_columns",
    {
      title: "List columns",
      description: "List the project's columns with WIP limits, required fields, done flags, and GitHub state mapping.",
      inputSchema: { projectSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug }) => invoke(dispatch, { method: "GET", path: projectPath(slug, "/columns") }, true)
  );

  server.registerTool(
    "lexa_list_swimlanes",
    {
      title: "List swimlanes",
      description: "List the project's swimlanes: the permanent Backlog lane plus sprints, with dates, milestone, and done/total counts.",
      inputSchema: { projectSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug }) => invoke(dispatch, { method: "GET", path: projectPath(slug, "/swimlanes") }, true)
  );

  server.registerTool(
    "lexa_list_milestones",
    {
      title: "List milestones",
      description: "List the project's milestones with sprint counts and task progress.",
      inputSchema: { projectSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug }) => invoke(dispatch, { method: "GET", path: projectPath(slug, "/milestones") }, true)
  );

  server.registerTool(
    "lexa_get_field_config",
    {
      title: "Get field config",
      description: "Read the project's priority and type options, including the option IDs tasks accept.",
      inputSchema: { projectSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug }) => invoke(dispatch, { method: "GET", path: projectPath(slug, "/field-config") }, true)
  );

  server.registerTool(
    "lexa_list_project_members",
    {
      title: "List project members",
      description: "List users holding an explicit project role on this project (the project-member projection, not every effective team member).",
      inputSchema: { projectSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug }) => invoke(dispatch, { method: "GET", path: projectPath(slug, "/members") }, true)
  );

  // ── Tasks ──────────────────────────────────────────────────────────────
  server.registerTool(
    "lexa_list_tasks",
    {
      title: "List tasks",
      description: "List the project's tasks with the existing filters and cursor pagination. Rows carry an empty description; read a task for its Markdown.",
      inputSchema: {
        projectSlug,
        columnId: z.string().min(1).optional().describe("Only tasks in this column id."),
        swimlaneId: z.string().min(1).optional().describe("Only tasks in this swimlane id."),
        assignee: z.string().min(1).optional().describe("Only tasks assigned to this user id."),
        type: z.string().min(1).optional().describe("Only tasks of this type option id."),
        limit: limit.optional(),
        cursor: cursor.optional(),
      },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug, columnId, swimlaneId, assignee, type, limit: pageLimit, cursor: pageCursor }) =>
      invoke(
        dispatch,
        {
          method: "GET",
          path: withQuery(projectPath(slug, "/tasks"), {
            columnId,
            swimlaneId,
            assignee,
            type,
            limit: pageLimit,
            cursor: pageCursor,
          }),
        },
        true
      )
  );

  server.registerTool(
    "lexa_get_task",
    {
      title: "Get task",
      description: "Read one task by UUID or ticket key, including its Markdown description, GitHub links, and archived state.",
      inputSchema: { projectSlug, id: taskId },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug, id }) =>
      invoke(dispatch, { method: "GET", path: projectPath(slug, `/tasks/${encodeURIComponent(id)}`) }, true)
  );

  server.registerTool(
    "lexa_create_task",
    {
      title: "Create task",
      description:
        "Create a task in the project with the existing defaults and guards (required fields, option IDs, deadline vs lane). Returns the persisted task and its activity rows.",
      inputSchema: {
        projectSlug,
        columnId: z.string().min(1).describe("Target column id (from lexa_list_columns)."),
        swimlaneId: z.string().min(1).optional().describe("Swimlane id; omitted = the project's Backlog lane."),
        title: z.string().describe("Task title (Markdown inline)."),
        description: z.string().optional().describe("Task description as canonical Markdown source."),
        priority: z.string().min(1).optional().describe("Priority option id; omitted = the project's first option."),
        type: z.string().min(1).optional().describe("Type option id; omitted = the project's first option."),
        parentId: z.string().min(1).optional().describe("Parent task UUID or ticket key; creates a subtask_of link."),
        assignees: z.array(z.string().min(1)).optional().describe("Assignee user ids."),
        dueAt,
      },
      annotations: ADDITIVE,
    },
    (args) => {
      const { projectSlug: slug, ...body } = args;
      return invoke(dispatch, { method: "POST", path: projectPath(slug, "/tasks"), body }, false);
    }
  );

  server.registerTool(
    "lexa_update_task",
    {
      title: "Update task",
      description:
        "Update the supplied task fields only; omitted fields keep their value and null clears a nullable one. Returns the persisted task and its activity rows.",
      inputSchema: {
        projectSlug,
        id: taskId,
        title: z.string().optional().describe("Task title."),
        description: z.string().optional().describe("Full replacement Markdown description."),
        priority: z.string().min(1).optional().describe("Priority option id."),
        type: z.string().min(1).optional().describe("Type option id."),
        assignees: z.array(z.string().min(1)).optional().describe("Full replacement assignee user ids."),
        dueAt,
      },
      annotations: REPLACING,
    },
    (args) => {
      const { projectSlug: slug, id, ...body } = args;
      return invoke(
        dispatch,
        { method: "PATCH", path: projectPath(slug, `/tasks/${encodeURIComponent(id)}`), body },
        false
      );
    }
  );

  server.registerTool(
    "lexa_move_task",
    {
      title: "Move task",
      description:
        "Move or reorder a task through the existing guarded workflow: WIP limits, required fields, neighbor checks, and deadline rules still apply. Linked issues sync GitHub state where a target column maps one. Returns the persisted task and its activity rows.",
      inputSchema: {
        projectSlug,
        id: taskId,
        columnId: z.string().min(1).describe("Target column id."),
        swimlaneId: z.string().min(1).describe("Target swimlane id (required by REST)."),
        beforeTaskId: z.string().min(1).optional().describe("Insert before this task (UUID or ticket key)."),
        afterTaskId: z.string().min(1).optional().describe("Insert after this task (UUID or ticket key)."),
        clearDueAt: z.boolean().optional().describe("Clear the card deadline in the same atomic move."),
      },
      annotations: ADDITIVE,
    },
    (args) => {
      const { projectSlug: slug, id, ...body } = args;
      return invoke(
        dispatch,
        { method: "POST", path: projectPath(slug, `/tasks/${encodeURIComponent(id)}/move`), body },
        false
      );
    }
  );

  server.registerTool(
    "lexa_archive_task",
    {
      title: "Archive task",
      description: "Archive a task without permanent deletion (idempotent). Returns the persisted task and its activity rows.",
      inputSchema: { projectSlug, id: taskId },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectSlug: slug, id }) =>
      invoke(dispatch, { method: "POST", path: projectPath(slug, `/tasks/${encodeURIComponent(id)}/archive`) }, false)
  );

  server.registerTool(
    "lexa_restore_task",
    {
      title: "Restore task",
      description: "Restore an archived task (idempotent). Returns the persisted task and its activity rows.",
      inputSchema: { projectSlug, id: taskId },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectSlug: slug, id }) =>
      invoke(dispatch, { method: "POST", path: projectPath(slug, `/tasks/${encodeURIComponent(id)}/restore`) }, false)
  );

  server.registerTool(
    "lexa_get_task_activity",
    {
      title: "Get task activity",
      description: "Read a task's activity events and comments with the existing cursor pagination (ascending).",
      inputSchema: { projectSlug, id: taskId, limit: limit.optional(), cursor: cursor.optional() },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug, id, limit: pageLimit, cursor: pageCursor }) =>
      invoke(
        dispatch,
        {
          method: "GET",
          path: withQuery(projectPath(slug, `/tasks/${encodeURIComponent(id)}/activity`), {
            limit: pageLimit,
            cursor: pageCursor,
          }),
        },
        true
      )
  );

  server.registerTool(
    "lexa_create_comment",
    {
      title: "Create comment",
      description: "Add a Markdown comment to a task, attributed to the key's owner. Returns the comment and its activity row.",
      inputSchema: {
        projectSlug,
        id: taskId,
        body: z.string().describe("Comment body as canonical Markdown source."),
      },
      annotations: ADDITIVE,
    },
    ({ projectSlug: slug, id, body }) =>
      invoke(
        dispatch,
        {
          method: "POST",
          path: projectPath(slug, `/tasks/${encodeURIComponent(id)}/comments`),
          body: { body },
        },
        false
      )
  );

  // ── Wiki ───────────────────────────────────────────────────────────────
  server.registerTool(
    "lexa_list_wiki_pages",
    {
      title: "List wiki pages",
      description: "Read the project's flat wiki metadata list (no content; parentId and hasChildren let you tree it).",
      inputSchema: { projectSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug }) => invoke(dispatch, { method: "GET", path: projectPath(slug, "/wiki") }, true)
  );

  server.registerTool(
    "lexa_get_wiki_page",
    {
      title: "Get wiki page",
      description: "Read one wiki page by slug, including its full Markdown content.",
      inputSchema: { projectSlug, pageSlug },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug, pageSlug: page }) =>
      invoke(dispatch, { method: "GET", path: projectPath(slug, `/wiki/${encodeURIComponent(page)}`) }, true)
  );

  server.registerTool(
    "lexa_search_wiki",
    {
      title: "Search wiki",
      description: "Search the selected project's wiki with the existing full-text search and return matching pages with snippets.",
      inputSchema: { projectSlug, q: z.string().min(1).describe("Full-text search query.") },
      annotations: READ_ONLY,
    },
    ({ projectSlug: slug, q }) =>
      invoke(dispatch, { method: "GET", path: withQuery(projectPath(slug, "/wiki/search"), { q }) }, true)
  );

  server.registerTool(
    "lexa_create_wiki_page",
    {
      title: "Create wiki page",
      description:
        "Create a wiki page with the existing slug and nesting rules. The page slug is `slug`; the project is `projectSlug`. Returns the persisted page.",
      inputSchema: {
        projectSlug,
        title: z.string().describe("Page title."),
        slug: z.string().optional().describe("Page slug; omitted = derived from the title."),
        content: z.string().optional().describe("Page content as canonical Markdown source."),
        parentId: z.string().nullable().optional().describe("Parent page id; null or omitted = top level."),
      },
      annotations: ADDITIVE,
    },
    (args) => {
      const { projectSlug: slug, ...body } = args;
      return invoke(dispatch, { method: "POST", path: projectPath(slug, "/wiki"), body }, false);
    }
  );

  server.registerTool(
    "lexa_update_wiki_page",
    {
      title: "Update wiki page",
      description:
        "Update the supplied wiki page fields only, through the existing validation and revision rules. Returns the persisted page.",
      inputSchema: {
        projectSlug,
        pageSlug,
        title: z.string().optional().describe("Page title."),
        slug: z.string().optional().describe("New page slug."),
        content: z.string().optional().describe("Full replacement content as canonical Markdown source."),
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe("Parent page id; null moves to top level, omitted keeps the current parent."),
        position: z.number().int().optional().describe("Sibling position integer."),
        saveType: z.enum(["autosave", "manual"]).optional().describe("Revision bucket (REST default autosave)."),
      },
      annotations: REPLACING,
    },
    (args) => {
      const { projectSlug: slug, pageSlug: page, ...body } = args;
      return invoke(
        dispatch,
        { method: "PATCH", path: projectPath(slug, `/wiki/${encodeURIComponent(page)}`), body },
        false
      );
    }
  );
}
