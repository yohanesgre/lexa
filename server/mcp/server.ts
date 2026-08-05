import { Effect, Layer, ManagedRuntime } from "effect";
import { LoggerLayer } from "../logging/logger";
import { ApiKeyRepo } from "../repos/api-key.repo";
import { UserRepo } from "../repos/user.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { TaskRepo } from "../repos/task.repo";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ProjectService } from "../services/project.service";
import { ColumnService } from "../services/column.service";
import { SwimlaneService } from "../services/swimlane.service";
import { TaskService } from "../services/task.service";
import { FieldConfigService } from "../services/field-config.service";
import { WikiService } from "../services/wiki.service";
import { ApiKeyService } from "../services/api-key.service";
import { UserService } from "../services/user.service";
import { UserProjectRoleService } from "../services/user-project-role.service";
import { GitHubService } from "../services/github.service";
import { initSqlite } from "../db/database";
import { errorCodeMap, errorMessage, errorDetails } from "../api/errors";
import { tool as createTask } from "./tools/create-task";
import { tool as listTasks } from "./tools/list-tasks";
import { tool as getTask } from "./tools/get-task";
import { tool as updateTask } from "./tools/update-task";
import { tool as moveTask } from "./tools/move-task";
import { tool as deleteTask } from "./tools/delete-task";
import { tool as archiveTask } from "./tools/archive-task";
import { tool as restoreTask } from "./tools/restore-task";
import { tool as getWikiPage } from "./tools/get-wiki-page";
import { tool as createWikiPage } from "./tools/create-wiki-page";
import { tool as updateWikiPage } from "./tools/update-wiki-page";
import { tool as listWikiPages } from "./tools/list-wiki-pages";
import { tool as searchWiki } from "./tools/search-wiki";
import { tool as listProjects } from "./tools/list-projects";
import { tool as getProject } from "./tools/get-project";
import { tool as getProjectStatus } from "./tools/get-project-status";
import { tool as linkGithubIssue } from "./tools/link-github-issue";
import { tool as unlinkGithubIssue } from "./tools/unlink-github-issue";
import { tool as createProject } from "./tools/create-project";
import { tool as updateProject } from "./tools/update-project";
import { tool as deleteProject } from "./tools/delete-project";
import { tool as createColumn } from "./tools/create-column";
import { tool as updateColumn } from "./tools/update-column";
import { tool as deleteColumn } from "./tools/delete-column";
import { tool as createSwimlane } from "./tools/create-swimlane";
import { tool as updateSwimlane } from "./tools/update-swimlane";
import { tool as deleteSwimlane } from "./tools/delete-swimlane";
import { tool as listApiKeys } from "./tools/list-api-keys";
import { tool as createApiKey } from "./tools/create-api-key";
import { tool as deleteApiKey } from "./tools/delete-api-key";
import { tool as listUsers } from "./tools/list-users";
import { tool as updateUserRole } from "./tools/update-user-role";
import { tool as listUserProjectRoles } from "./tools/list-user-project-roles";
import { tool as setUserProjectRole } from "./tools/set-user-project-role";
import { tool as removeUserProjectRole } from "./tools/remove-user-project-role";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { checkProjectAccess } from "./auth";
import { resolveTaskProject } from "./resolve";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
  handler: (args: any, auth?: { userId: string | null; role: string }) => Effect.Effect<any, any, any>;
}

const tools: ToolDef[] = [
  createTask,
  listTasks,
  getTask,
  updateTask,
  moveTask,
  deleteTask,
  archiveTask,
  restoreTask,
  getWikiPage,
  createWikiPage,
  updateWikiPage,
  listWikiPages,
  searchWiki,
  listProjects,
  getProject,
  getProjectStatus,
  linkGithubIssue,
  unlinkGithubIssue,
  createProject,
  updateProject,
  deleteProject,
  createColumn,
  updateColumn,
  deleteColumn,
  createSwimlane,
  updateSwimlane,
  deleteSwimlane,
  listApiKeys,
  createApiKey,
  deleteApiKey,
  listUsers,
  updateUserRole,
  listUserProjectRoles,
  setUserProjectRole,
  removeUserProjectRole,
];

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonRpcError(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseError(id: string | number | null): object {
  return jsonRpcError(id, -32700, "Parse error");
}

function methodNotFound(id: string | number | null): object {
  return jsonRpcError(id, -32601, "Method not found");
}

function buildToolError(e: unknown): object {
  const error = e as { _tag?: string; code?: string; message?: string; details?: unknown } & Record<string, unknown>;
  const tag = error._tag;
  if (typeof tag === "string" && tag) {
    const tagged = { ...error, _tag: tag };
    return {
      code: errorCodeMap[tag] ?? "INTERNAL",
      message: errorMessage(tagged),
      details: errorDetails(tagged),
    };
  }
  // Inline fail objects ({ code, message, details }) from tools — no _tag.
  return {
    code: typeof error.code === "string" ? error.code : "INTERNAL",
    message: typeof error.message === "string" ? error.message : "Internal server error",
    details: (error.details ?? {}) as Record<string, unknown>,
  };
}

export class McpServer extends Effect.Service<McpServer>()("Lexa/McpServer", {
  dependencies: [
    ApiKeyRepo.Default,
    UserRepo.Default,
    ProjectRepo.Default,
    ColumnRepo.Default,
    SwimlaneRepo.Default,
    TaskRepo.Default,
    FieldConfigRepo.Default,
    ProjectService.Default,
    ColumnService.Default,
    SwimlaneService.Default,
    TaskService.Default,
    FieldConfigService.Default,
    WikiService.Default,
    ApiKeyService.Default,
    UserService.Default,
    UserProjectRoleService.Default,
    GitHubService.Default,
  ],
  effect: Effect.gen(function* () {
    const apiKeyRepo = yield* ApiKeyRepo;

    const checkAuth = (authHeader: string) =>
      Effect.gen(function* () {
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return yield* Effect.fail("MISSING_AUTH");
        }
        const key = authHeader.slice(7);
        if (!key.startsWith("lxk_") || !/^lxk_[0-9A-Za-z]{43}$/.test(key)) {
          return yield* Effect.fail("INVALID_API_KEY");
        }
        const keyHash = yield* Effect.promise(() => sha256(key));
        const row = yield* apiKeyRepo.findByHash(keyHash).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail("INVALID_API_KEY"))
        );
        yield* apiKeyRepo.touchIfStale(row.id);
        const userRepo = yield* UserRepo;
        if (row.user_id) {
          const user = yield* userRepo.findById(row.user_id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail("INVALID_API_KEY"))
          );
          return { keyId: row.id, userId: user.id, role: user.role };
        }
        return { keyId: row.id, userId: null, role: "admin" };
      });

    const dispatch = (request: any, authContext: { keyId: string; userId: string | null; role: string }) =>
      Effect.gen(function* () {
        if (request.jsonrpc !== "2.0") {
          return jsonRpcError(request.id ?? null, -32600, "Invalid Request: jsonrpc must be \"2.0\"");
        }
        const method = request.method;
        const id = request.id ?? null;

        switch (method) {
          case "initialize":
            return {
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "lexa", version: "0.1.0" },
              },
            };

          case "notifications/initialized":
            return { jsonrpc: "2.0", id, result: {} };

          case "ping":
            return { jsonrpc: "2.0", id, result: {} };

          case "tools/list":
            return {
              jsonrpc: "2.0",
              id,
              result: {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                })),
              },
            };

          case "tools/call": {
            const toolName = request.params?.name;
            const tool = tools.find((t) => t.name === toolName);
            if (!tool) {
              return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
            }

            const args = request.params?.arguments ?? {};

            // Project-scoped authorization
            if (typeof args?.project === "string") {
              yield* checkProjectAccess(authContext.userId, authContext.role, args.project);
            }
            if (typeof args?.slug === "string" && ["get_project", "get_project_status"].includes(toolName)) {
              yield* checkProjectAccess(authContext.userId, authContext.role, args.slug);
            }
            if (typeof args?.taskId === "string" && ["get_task", "update_task", "move_task", "delete_task", "archive_task", "restore_task", "link_github_issue", "unlink_github_issue"].includes(toolName)) {
              const resolution = yield* resolveTaskProject(args.taskId).pipe(Effect.either);
              if (resolution._tag === "Left") {
                const err = buildToolError(resolution.left as any);
                return {
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: JSON.stringify(err) }],
                    isError: true,
                  },
                };
              }
              yield* checkProjectAccess(authContext.userId, authContext.role, resolution.right.slug);
            }

            const result = yield* tool.handler(args, { userId: authContext.userId, role: authContext.role }).pipe(
              Effect.catchAll((e) => {
                const err = buildToolError(e as any);
                return Effect.succeed({ isError: true, error: err });
              })
            );

            if (typeof result === "object" && result !== null && "isError" in result && (result as any).isError) {
              const err = (result as any).error;
              return {
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(err) }],
                  isError: true,
                },
              };
            }

            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
              },
            };
          }

          default:
            return methodNotFound(id);
        }
      });

    const handleRequest = (rawBody: string, authHeader: string) =>
      Effect.gen(function* () {
        const headers = { "Content-Type": "application/json" };

        const authResult = yield* checkAuth(authHeader).pipe(
          Effect.match({
            onSuccess: (ctx) => ({ ctx, error: null }),
            onFailure: (err) => ({ ctx: null, error: err as string }),
          })
        );

        if (authResult.error !== null) {
          const response: object = {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32001,
              message: authResult.error === "MISSING_AUTH" ? "Missing authorization" : "Invalid API key",
            },
          };
          return new Response(JSON.stringify(response), { status: 401, headers });
        }

        const authContext = authResult.ctx!;

        let request: any;
        try {
          request = JSON.parse(rawBody);
        } catch {
          return new Response(JSON.stringify(parseError(null)), { status: 200, headers });
        }

        if (Array.isArray(request)) {
          return new Response(JSON.stringify(jsonRpcError(null, -32600, "Batch requests are not supported")), { status: 200, headers });
        }

        if (request.jsonrpc !== "2.0") {
          return new Response(JSON.stringify(jsonRpcError(request.id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0"')), { status: 200, headers });
        }

        const response = yield* dispatch(request, authContext).pipe(
          // Unhandled tool failures (e.g. checkProjectAccess denial) must
          // surface as a tool error envelope — never a thrown rejection/500.
          Effect.catchAll((e) => {
            const err = buildToolError(e as any);
            return Effect.succeed({
              jsonrpc: "2.0",
              id: request.id ?? null,
              result: { content: [{ type: "text", text: JSON.stringify(err) }], isError: true },
            });
          })
        );
        return new Response(JSON.stringify(response), { status: 200, headers });
      });

    return { handleRequest } as const;
  }),
}) {}

const serviceLayer = Layer.mergeAll(
  ApiKeyRepo.Default,
  UserRepo.Default,
  ProjectRepo.Default,
  UserProjectRoleRepo.Default,
  ColumnRepo.Default,
  SwimlaneRepo.Default,
  TaskRepo.Default,
  FieldConfigRepo.Default,
  ProjectService.Default,
  ColumnService.Default,
  SwimlaneService.Default,
  TaskService.Default,
  FieldConfigService.Default,
  WikiService.Default,
  ApiKeyService.Default,
  UserService.Default,
  UserProjectRoleService.Default,
  GitHubService.Default,
);

function createMcpLayer(dbPath: string): Layer.Layer<McpServer> {
  return Layer.provide(
    Layer.provideMerge(McpServer.Default, serviceLayer),
    Layer.mergeAll(initSqlite(dbPath), LoggerLayer),
  );
}

export function createMcpHandler(dbPath: string): (req: Request) => Promise<Response> {
  const runtime = ManagedRuntime.make(createMcpLayer(dbPath));

  return async (req: Request) => {
    const authHeader = req.headers.get("Authorization") ?? "";
    const rawBody = await req.text();
    const program = Effect.gen(function* () {
      const server = yield* McpServer;
      yield* Effect.logInfo(`[MCP] ${extractMethod(rawBody)}`).pipe(Effect.annotateLogs(extractAnnotations(rawBody)));
      return yield* server.handleRequest(rawBody, authHeader);
    });
    return runtime.runPromise(program);
  };
}

function extractMethod(body: string): string {
  try {
    const msg = JSON.parse(body);
    if (msg.method) return `method=${msg.method}`;
    if (msg.id !== undefined && msg.result !== undefined) return "response";
    if (msg.id !== undefined && msg.error !== undefined) return `error:${msg.error.code}`;
    if (msg.method === "notifications/initialized") return "notifinit";
    return "unknown";
  } catch {
    return "parse-error";
  }
}

function extractAnnotations(body: string): Record<string, string> {
  try {
    const msg = JSON.parse(body);
    const ann: Record<string, string> = {};
    if (msg.method) ann.mcp_method = msg.method;
    if (msg.id !== undefined) ann.mcp_id = String(msg.id);
    if (msg.params && msg.params.name) ann.mcp_tool = msg.params.name;
    return ann;
  } catch {
    return {};
  }
}
