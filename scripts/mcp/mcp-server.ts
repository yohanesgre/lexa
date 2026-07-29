import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { markdownToDoc, docToMarkdown } from "../shared/markdown.ts";
import type { TipTapDoc } from "../shared/types.ts";

// ── Env file ──

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

function loadEnv() {
  const envPath = resolve(homedir(), ".config/lexa-mcp/env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length > 0 && !key.startsWith("#")) {
        process.env[key.trim()] = rest.join("=").trim();
      }
    }
  }
}
loadEnv();

// ── Config ──

const WORKER_URL = process.env.WORKER_URL || "https://lexa.example.com";
const PORT = parseInt(process.env.PORT || "9000", 10);

if (!process.env.LXK_API_KEY) {
  console.error("FATAL: LXK_API_KEY environment variable is required");
  console.error("Set it in ~/.config/lexa-mcp/env or export LXK_API_KEY=lxk_...");
  process.exit(1);
}
const API_KEY = process.env.LXK_API_KEY;

// ── Cache ──

const projectListCache = new Map<string, { data: any[]; ts: number }>();
const PROJECT_CACHE_TTL = 60_000;

const columnCache = new Map<string, Map<string, string>>(); // projectSlug → (columnId → name)
const swimlaneCache = new Map<string, Map<string, string>>(); // projectSlug → (swimlaneId → name)
const taskProjectCache = new Map<string, { projectSlug: string; task: any }>();
const MAX_TASK_CACHE = 1000;

// ── Worker call ──

interface RestError {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function isRestError(body: unknown): body is RestError {
  return typeof body === "object" && body !== null && "error" in body;
}

async function workerCall(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (method === "DELETE" && res.status === 204) return null;

  const json: unknown = await res.json();

  if (!res.ok) {
    if (isRestError(json)) {
      throw { code: json.error.code, message: json.error.message, details: json.error.details };
    }
    throw { code: "INTERNAL", message: `Worker returned ${res.status}` };
  }

  return json;
}

// ── Name resolution ──

async function resolveProject(slug: string): Promise<any> {
  let projects = projectListCache.get("_all");
  if (!projects || Date.now() - projects.ts > PROJECT_CACHE_TTL) {
    const res = await workerCall("/api/projects?limit=200", "GET");
    projects = { data: res.data ?? [], ts: Date.now() };
    projectListCache.set("_all", projects);
  }

  const p = projects.data.find((p: any) => p.slug === slug);
  if (!p) {
    throw {
      code: "PROJECT_NOT_FOUND",
      message: `Project '${slug}' not found`,
      details: { availableProjects: projects.data.map((p: any) => p.slug) },
    };
  }
  return p;
}

async function resolveColumn(projectSlug: string, columnName: string): Promise<any> {
  const columns = await workerCall(`/api/projects/${projectSlug}/columns`, "GET");
  const list: any[] = columns.data ?? [];

  const map = new Map<string, string>();
  for (const c of list) map.set(c.id, c.name);
  columnCache.set(projectSlug, map);

  const c = list.find((c: any) => c.name.toLowerCase() === columnName.toLowerCase());
  if (!c) {
    throw {
      code: "COLUMN_NOT_FOUND",
      message: `Column '${columnName}' not found in project '${projectSlug}'`,
      details: { availableColumns: list.map((c: any) => c.name) },
    };
  }
  return c;
}

async function resolveSwimlane(projectSlug: string, swimlaneName: string): Promise<any> {
  const swimlanes = await workerCall(`/api/projects/${projectSlug}/swimlanes`, "GET");
  const list: any[] = swimlanes.data ?? [];

  const map = new Map<string, string>();
  for (const s of list) map.set(s.id, s.name);
  swimlaneCache.set(projectSlug, map);

  const s = list.find((s: any) => s.name.toLowerCase() === swimlaneName.toLowerCase());
  if (!s) {
    throw {
      code: "SWIMLANE_NOT_FOUND",
      message: `Swimlane '${swimlaneName}' not found in project '${projectSlug}'`,
      details: { availableSwimlanes: list.map((s: any) => s.name) },
    };
  }
  return s;
}

async function getColumnNameMap(projectSlug: string): Promise<Map<string, string>> {
  let map = columnCache.get(projectSlug);
  if (map) return map;
  const columns = await workerCall(`/api/projects/${projectSlug}/columns`, "GET");
  const list: any[] = columns.data ?? [];
  map = new Map<string, string>();
  for (const c of list) map.set(c.id, c.name);
  columnCache.set(projectSlug, map);
  return map;
}

async function getSwimlaneNameMap(projectSlug: string): Promise<Map<string, string>> {
  let map = swimlaneCache.get(projectSlug);
  if (map) return map;
  const swimlanes = await workerCall(`/api/projects/${projectSlug}/swimlanes`, "GET");
  const list: any[] = swimlanes.data ?? [];
  map = new Map<string, string>();
  for (const s of list) map.set(s.id, s.name);
  swimlaneCache.set(projectSlug, map);
  return map;
}

const wikiSlugCache = new Map<string, Map<string, string>>(); // projectSlug → (id → slug)

async function fetchWikiSlugMap(projectSlug: string): Promise<Map<string, string>> {
  const res = await workerCall(`/api/projects/${projectSlug}/wiki?limit=200`, "GET");
  const pages: any[] = res.data ?? [];
  const map = new Map<string, string>();
  for (const p of pages) map.set(p.id, p.slug);
  wikiSlugCache.set(projectSlug, map);
  return map;
}

async function resolveParentIdToSlug(projectSlug: string, parentId: string): Promise<string | null> {
  let map = wikiSlugCache.get(projectSlug);
  if (!map) map = await fetchWikiSlugMap(projectSlug);
  return map.get(parentId) ?? null;
}

async function resolveParentSlugToId(projectSlug: string, parentSlug: string): Promise<string> {
  const page = await workerCall(`/api/projects/${projectSlug}/wiki/${parentSlug}`, "GET");
  return page.id;
}

async function resolveTaskProject(taskId: string): Promise<{ projectSlug: string; task: any }> {
  const cached = taskProjectCache.get(taskId);
  if (cached) return cached;

  let projects = projectListCache.get("_all");
  if (!projects || Date.now() - projects.ts > PROJECT_CACHE_TTL) {
    const res = await workerCall("/api/projects?limit=200", "GET");
    projects = { data: res.data ?? [], ts: Date.now() };
    projectListCache.set("_all", projects);
  }

  for (const p of projects.data) {
    try {
      const task = await workerCall(`/api/projects/${p.slug}/tasks/${taskId}`, "GET");
      if (task) {
        const entry = { projectSlug: p.slug, task };
        if (taskProjectCache.size >= MAX_TASK_CACHE) {
          const firstKey = taskProjectCache.keys().next().value;
          if (firstKey) taskProjectCache.delete(firstKey);
        }
        taskProjectCache.set(taskId, entry);
        return entry;
      }
    } catch (e: any) {
      if (e?.code === "TASK_NOT_FOUND") continue;
      throw e;
    }
  }

  throw { code: "TASK_NOT_FOUND", message: `Task '${taskId}' not found in any project` };
}

// ── Response shaping ──

function taskToSummary(
  task: any,
  columnName: string,
  swimlaneName: string | null
): any {
  return {
    id: task.id,
    title: task.title,
    column: columnName,
    swimlane: swimlaneName,
    priority: task.priority,
    type: task.type,
    assignee: task.assignee,
    githubIssue: task.github
      ? {
          number: task.github.issueNumber,
          repo: task.github.repo,
          url: task.github.url,
          outOfSync: task.github.outOfSync,
        }
      : null,
    updatedAt: task.updatedAt,
  };
}

async function taskToSummaryResolved(
  task: any,
  projectSlug: string
): Promise<any> {
  const colMap = await getColumnNameMap(projectSlug);
  const swMap = await getSwimlaneNameMap(projectSlug);
  return taskToSummary(
    task,
    colMap.get(task.columnId) ?? "unknown",
    task.swimlaneId ? (swMap.get(task.swimlaneId) ?? null) : null
  );
}

function taskToDetail(task: any, columnName: string, swimlaneName: string | null): any {
  return {
    ...taskToSummary(task, columnName, swimlaneName),
    description: docToMarkdown(task.description as TipTapDoc),
    createdAt: task.createdAt,
  };
}

async function taskToDetailResolved(
  task: any,
  projectSlug: string
): Promise<any> {
  const colMap = await getColumnNameMap(projectSlug);
  const swMap = await getSwimlaneNameMap(projectSlug);
  return taskToDetail(
    task,
    colMap.get(task.columnId) ?? "unknown",
    task.swimlaneId ? (swMap.get(task.swimlaneId) ?? null) : null
  );
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: "create_task",
    description:
      "Create a new task in a project column. Column and project are resolved by name. Description is Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug" },
        column: { type: "string", description: "Column name (case-insensitive)" },
        title: { type: "string" },
        description: { type: "string", description: "Markdown" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
        type: { type: "string", enum: ["feature", "bug", "task", "asset"] },
        assignee: { type: "string" },
        swimlane: { type: "string", description: "Swimlane name (case-insensitive)" },
      },
      required: ["project", "column", "title"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List tasks in a project, optionally filtered by column, swimlane, assignee, or type. Does NOT include descriptions — use get_task for details.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug" },
        column: { type: "string", description: "Column name (case-insensitive)" },
        swimlane: { type: "string", description: "Swimlane name (case-insensitive)" },
        assignee: { type: "string" },
        type: { type: "string", enum: ["feature", "bug", "task", "asset"] },
        limit: { type: "number", description: "Default 50, max 200" },
        cursor: { type: "string" },
      },
      required: ["project"],
    },
  },
  {
    name: "get_task",
    description: "Get a single task by ID with full description (rendered as Markdown).",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task UUID" } },
      required: ["taskId"],
    },
  },
  {
    name: "update_task",
    description:
      "Update a task's fields. Description is Markdown (full replace). Pass explicit null to clear assignee.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task UUID" },
        title: { type: "string" },
        description: { type: "string", description: "Markdown (full replace)" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
        type: { type: "string", enum: ["feature", "bug", "task", "asset"] },
        assignee: { type: "string", description: "Use null to clear" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "move_task",
    description:
      "Move a task to a different column. Column is resolved by name. Within-column reorder never fails WIP limits.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task UUID" },
        column: { type: "string", description: "Target column name (case-insensitive)" },
        beforeTaskId: { type: "string", description: "Task UUID to place this task before" },
        afterTaskId: { type: "string", description: "Task UUID to place this task after" },
      },
      required: ["taskId", "column"],
    },
  },
  {
    name: "delete_task",
    description: "Delete a task by ID.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task UUID" } },
      required: ["taskId"],
    },
  },
  {
    name: "get_wiki_page",
    description: "Get a wiki page by project slug and page slug. Content is rendered as Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug" },
        pageSlug: { type: "string", description: "Wiki page slug" },
      },
      required: ["project", "pageSlug"],
    },
  },
  {
    name: "create_wiki_page",
    description:
      "Create a new wiki page in a project. Title is required. Content is Markdown. Optionally nest under a parent page by slug.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug" },
        title: { type: "string" },
        content: { type: "string", description: "Markdown" },
        parentSlug: { type: "string", description: "Slug of parent page to nest under" },
      },
      required: ["project", "title"],
    },
  },
  {
    name: "update_wiki_page",
    description: "Update a wiki page's title and/or content. Content is Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug" },
        pageSlug: { type: "string", description: "Wiki page slug to update" },
        title: { type: "string" },
        content: { type: "string", description: "Markdown" },
      },
      required: ["project", "pageSlug"],
    },
  },
  {
    name: "list_wiki_pages",
    description: "List wiki pages in a project. Returns metadata only (no content).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug" },
        limit: { type: "number", description: "Default 50, max 200" },
        cursor: { type: "string" },
      },
      required: ["project"],
    },
  },
  {
    name: "search_wiki",
    description:
      "Full-text search across wiki pages in a project. Returns matching pages with context snippets.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug" },
        query: { type: "string" },
        limit: { type: "number", description: "Default 10, max 50" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "link_github_issue",
    description:
      "Link a task to a GitHub issue. Creates a new issue in the specified repository from the task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task UUID" },
        repo: { type: "string", description: 'Repository as "owner/name"' },
      },
      required: ["taskId", "repo"],
    },
  },
  {
    name: "unlink_github_issue",
    description:
      "Unlink a task from its GitHub issue. Does NOT close or delete the GitHub issue.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task UUID" } },
      required: ["taskId"],
    },
  },
  {
    name: "list_projects",
    description: "List all projects with name, slug, description, and task count.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_project",
    description:
      "Get project details including columns (with WIP limits and required fields) and swimlanes.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Project slug" } },
      required: ["slug"],
    },
  },
  {
    name: "get_project_status",
    description:
      "Get board health snapshot — column task counts and WIP limits. Use before planning batch moves.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Project slug" } },
      required: ["slug"],
    },
  },
];

// ── Tool handlers ──

interface MCPError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function isMCPError(e: unknown): e is MCPError {
  return typeof e === "object" && e !== null && "code" in e;
}

function errorResult(err: MCPError) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ code: err.code, message: err.message, details: err.details }) }],
    isError: true,
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, ToolHandler> = {
  // ── Projects ──

  async list_projects(_args) {
    const res = await workerCall("/api/projects?limit=200", "GET");
    const projects: any[] = res.data ?? [];
    const out = await Promise.all(
      projects.map(async (p: any) => {
        let taskCount = 0;
        try {
          const board = await workerCall(`/api/projects/${p.slug}/board`, "GET");
          taskCount = board.tasks?.length ?? 0;
        } catch {
          // taskCount stays 0
        }
        return { name: p.name, slug: p.slug, description: p.description || "", taskCount };
      })
    );
    return jsonResult({ projects: out });
  },

  async get_project(args) {
    const slug = args.slug as string;
    const [project, columnsRes, swimlanesRes] = await Promise.all([
      workerCall(`/api/projects/${slug}`, "GET"),
      workerCall(`/api/projects/${slug}/columns`, "GET"),
      workerCall(`/api/projects/${slug}/swimlanes`, "GET"),
    ]);
    return jsonResult({
      name: project.name,
      slug: project.slug,
      description: project.description || "",
      githubRepo: project.githubRepo || null,
      columns: (columnsRes.data ?? []).map((c: any) => ({
        name: c.name,
        wipLimit: c.wipLimit,
        requiredFields: c.requiredFields,
        githubState: c.githubState,
      })),
      swimlanes: (swimlanesRes.data ?? []).map((s: any) => ({ name: s.name })),
    });
  },

  async get_project_status(args) {
    const slug = args.slug as string;
    const board = await workerCall(`/api/projects/${slug}/board`, "GET");
    const columns: any[] = board.columns ?? [];
    const tasks: any[] = board.tasks ?? [];

    const counts = new Map<string, number>();
    for (const t of tasks) {
      counts.set(t.columnId, (counts.get(t.columnId) ?? 0) + 1);
    }

    return jsonResult({
      columns: columns.map((c: any) => ({
        name: c.name,
        count: counts.get(c.id) ?? 0,
        wipLimit: c.wipLimit,
      })),
      totalTasks: tasks.length,
    });
  },

  // ── Tasks ──

  async create_task(args) {
    const project = await resolveProject(args.project as string);
    const column = await resolveColumn(project.slug, args.column as string);
    let swimlaneId: string | undefined;
    if (args.swimlane) {
      const sw = await resolveSwimlane(project.slug, args.swimlane as string);
      swimlaneId = sw.id;
    }

    const body: Record<string, unknown> = {
      columnId: column.id,
      title: args.title,
      priority: args.priority || "medium",
      type: args.type || "task",
    };
    if (swimlaneId) body.swimlaneId = swimlaneId;
    if (args.description) body.description = markdownToDoc(args.description as string);
    if (args.assignee != null) body.assignee = args.assignee;

    const task = await workerCall(`/api/projects/${project.slug}/tasks`, "POST", body);

    let swimlaneName: string | null = null;
    if (task.swimlaneId) {
      const swMap = await getSwimlaneNameMap(project.slug);
      swimlaneName = swMap.get(task.swimlaneId) ?? null;
    }

    taskProjectCache.set(task.id, { projectSlug: project.slug, task });
    return jsonResult(taskToSummary(task, column.name, swimlaneName));
  },

  async list_tasks(args) {
    const project = await resolveProject(args.project as string);
    const res = await workerCall(`/api/projects/${project.slug}/board`, "GET");
    const allTasks: any[] = res.tasks ?? [];
    const allColumns: any[] = res.columns ?? [];

    // Resolve column name → id for filtering
    let targetColumnId: string | null = null;
    if (args.column) {
      const col = allColumns.find((c: any) => c.name.toLowerCase() === (args.column as string).toLowerCase());
      if (!col) throw { code: "COLUMN_NOT_FOUND", details: { availableColumns: allColumns.map((c: any) => c.name) } };
      targetColumnId = col.id;
    }

    // Resolve swimlane name → id for filtering
    let targetSwimlaneId: string | null = null;
    if (args.swimlane) {
      const sws: any[] = res.swimlanes ?? [];
      const sw = sws.find((s: any) => s.name.toLowerCase() === (args.swimlane as string).toLowerCase());
      if (!sw) throw { code: "SWIMLANE_NOT_FOUND", details: { availableSwimlanes: sws.map((s: any) => s.name) } };
      targetSwimlaneId = sw.id;
    }

    // Filter and map
    let filtered = allTasks;
    if (targetColumnId) filtered = filtered.filter((t: any) => t.columnId === targetColumnId);
    if (targetSwimlaneId) filtered = filtered.filter((t: any) => t.swimlaneId === targetSwimlaneId);
    if (args.assignee) filtered = filtered.filter((t: any) => t.assignee === args.assignee);
    if (args.type) filtered = filtered.filter((t: any) => t.type === args.type);

    const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200);
    const cursorIdx = args.cursor ? parseInt(String(args.cursor), 10) || 0 : 0;
    const page = filtered.slice(cursorIdx, cursorIdx + limit);

    const summaries = await Promise.all(
      page.map((t: any) => {
        taskProjectCache.set(t.id, { projectSlug: project.slug, task: t });
        return taskToSummaryResolved(t, project.slug);
      })
    );

    const nextCursor = (cursorIdx + limit < filtered.length) ? String(cursorIdx + limit) : null;
    return jsonResult({ tasks: summaries, nextCursor });
  },

  async get_task(args) {
    const taskId = args.taskId as string;
    const { projectSlug, task } = await resolveTaskProject(taskId);
    return jsonResult(await taskToDetailResolved(task, projectSlug));
  },

  async update_task(args) {
    const taskId = args.taskId as string;
    const { projectSlug } = await resolveTaskProject(taskId);

    const body: Record<string, unknown> = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.description !== undefined) body.description = markdownToDoc(args.description as string);
    if (args.priority !== undefined) body.priority = args.priority;
    if (args.type !== undefined) body.type = args.type;
    if (args.assignee !== undefined) body.assignee = args.assignee;

    const task = await workerCall(`/api/projects/${projectSlug}/tasks/${taskId}`, "PATCH", body);
    taskProjectCache.set(task.id, { projectSlug, task });
    return jsonResult(await taskToDetailResolved(task, projectSlug));
  },

  async move_task(args) {
    const taskId = args.taskId as string;
    const { projectSlug } = await resolveTaskProject(taskId);
    const column = await resolveColumn(projectSlug, args.column as string);

    const body: Record<string, unknown> = { columnId: column.id };
    if (args.beforeTaskId) body.beforeTaskId = args.beforeTaskId;
    if (args.afterTaskId) body.afterTaskId = args.afterTaskId;

    const task = await workerCall(
      `/api/projects/${projectSlug}/tasks/${taskId}/move`,
      "POST",
      body
    );
    taskProjectCache.set(task.id, { projectSlug, task });

    let swimlaneName: string | null = null;
    if (task.swimlaneId) {
      const swMap = await getSwimlaneNameMap(projectSlug);
      swimlaneName = swMap.get(task.swimlaneId) ?? null;
    }

    return jsonResult(taskToSummary(task, column.name, swimlaneName));
  },

  async delete_task(args) {
    const taskId = args.taskId as string;
    const { projectSlug } = await resolveTaskProject(taskId);
    await workerCall(`/api/projects/${projectSlug}/tasks/${taskId}`, "DELETE");
    taskProjectCache.delete(taskId);
    return jsonResult({ deleted: true });
  },

  // ── Wiki ──

  async get_wiki_page(args) {
    const project = await resolveProject(args.project as string);
    const pageSlug = args.pageSlug as string;
    const page = await workerCall(`/api/projects/${project.slug}/wiki/${pageSlug}`, "GET");
    const parentSlug = page.parentId
      ? await resolveParentIdToSlug(project.slug, page.parentId)
      : null;
    return jsonResult({
      title: page.title,
      slug: page.slug,
      content: docToMarkdown(page.content as TipTapDoc),
      parentSlug,
      updatedAt: page.updatedAt,
    });
  },

  async create_wiki_page(args) {
    const project = await resolveProject(args.project as string);
    const body: Record<string, unknown> = { title: args.title };
    if (args.content) body.content = markdownToDoc(args.content as string);
    if (args.parentSlug) {
      body.parentId = await resolveParentSlugToId(project.slug, args.parentSlug as string);
    }

    const page = await workerCall(`/api/projects/${project.slug}/wiki`, "POST", body);
    wikiSlugCache.delete(project.slug); // invalidate cache — new page added
    const parentSlug = page.parentId
      ? await resolveParentIdToSlug(project.slug, page.parentId)
      : null;
    return jsonResult({
      title: page.title,
      slug: page.slug,
      parentSlug,
      updatedAt: page.updatedAt,
    });
  },

  async update_wiki_page(args) {
    const project = await resolveProject(args.project as string);
    const pageSlug = args.pageSlug as string;
    const body: Record<string, unknown> = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.content !== undefined) body.content = markdownToDoc(args.content as string);

    const page = await workerCall(
      `/api/projects/${project.slug}/wiki/${pageSlug}`,
      "PATCH",
      body
    );
    wikiSlugCache.delete(project.slug); // invalidate — slug/parent may have changed
    const parentSlug = page.parentId
      ? await resolveParentIdToSlug(project.slug, page.parentId)
      : null;
    return jsonResult({
      title: page.title,
      slug: page.slug,
      parentSlug,
      updatedAt: page.updatedAt,
    });
  },

  async list_wiki_pages(args) {
    const project = await resolveProject(args.project as string);
    const params = new URLSearchParams();
    if (args.limit != null) params.set("limit", String(args.limit));
    if (args.cursor) params.set("cursor", String(args.cursor));
    const qs = params.toString();
    const res = await workerCall(
      `/api/projects/${project.slug}/wiki${qs ? "?" + qs : ""}`,
      "GET"
    );
    const pages: any[] = res.data ?? [];
    const slugMap = await fetchWikiSlugMap(project.slug);
    return jsonResult({
      pages: pages.map((p: any) => ({
        title: p.title,
        slug: p.slug,
        parentSlug: p.parentId ? (slugMap.get(p.parentId) ?? null) : null,
        updatedAt: p.updatedAt,
      })),
      nextCursor: res.nextCursor ?? null,
    });
  },

  async search_wiki(args) {
    const project = await resolveProject(args.project as string);
    const query = args.query as string;
    const limit = (args.limit as number) || 10;
    const res = await workerCall(
      `/api/projects/${project.slug}/wiki/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      "GET"
    );
    const results: any[] = res.data ?? [];
    return jsonResult({
      results: results.map((r: any) => ({
        title: r.title,
        slug: r.slug,
        snippet: r.snippet,
      })),
    });
  },

  // ── GitHub (stubs) ──

  async link_github_issue(_args) {
    return errorResult({
      code: "NOT_IMPLEMENTED",
      message: "GitHub issue linking is not yet implemented in the local MCP server. Use the REST API directly.",
    });
  },

  async unlink_github_issue(_args) {
    return errorResult({
      code: "NOT_IMPLEMENTED",
      message: "GitHub issue unlinking is not yet implemented in the local MCP server. Use the REST API directly.",
    });
  },
};

// ── JSON-RPC handler ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function respond(
  res: ServerResponse,
  id: string | number | null | undefined,
  result: unknown
) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

function respondError(
  res: ServerResponse,
  id: string | number | null | undefined,
  code: number,
  message: string
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

async function handleJsonRpc(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer
) {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(body.toString("utf-8"));
  } catch {
    respondError(res, null, -32700, "Parse error");
    return;
  }

  if (request.jsonrpc !== "2.0") {
    respondError(res, request.id, -32600, "Invalid Request");
    return;
  }

  try {
    switch (request.method) {
      case "initialize":
        respond(res, request.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "lexa", version: "0.1.0" },
        });
        break;

      case "notifications/initialized":
        respond(res, request.id, {});
        break;

      case "ping":
        respond(res, request.id, {});
        break;

      case "tools/list":
        respond(res, request.id, { tools: TOOLS });
        break;

      case "tools/call": {
        const params = request.params ?? {};
        const toolName = params.name as string;
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

        const handler = handlers[toolName];
        if (!handler) {
          respond(res, request.id, {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          });
          break;
        }

        try {
          const result = await handler(toolArgs);
          respond(res, request.id, result);
        } catch (e: unknown) {
          if (isMCPError(e)) {
            respond(res, request.id, errorResult(e));
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            respond(res, request.id, errorResult({ code: "INTERNAL", message: msg }));
          }
        }
        break;
      }

      default:
        respondError(res, request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    respondError(res, request.id, -32603, msg);
  }
}

// ── HTTP server ──

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`${ts} ${req.method} ${req.url}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check (public — no auth)
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Auth check for /mcp
  if (req.url !== "/mcp" && !req.url?.startsWith("/mcp?")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const auth = req.headers["authorization"];
import { timingSafeEqual } from "node:crypto";

// ...

  if (!auth || !timingSafeEqual(Buffer.from(auth), Buffer.from(`Bearer ${API_KEY}`))) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    await handleJsonRpc(req, res, body);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ── Startup / shutdown ──

function shutdown() {
  console.log("\nShutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.log("Forcing exit");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`Lexa local MCP server listening on port ${PORT}`);
  console.log(`Worker URL: ${WORKER_URL}`);
  console.log(`Auth: Bearer ${API_KEY.substring(0, 8)}...`);
  console.log(`MCP endpoint: POST http://localhost:${PORT}/mcp`);
  console.log(`Health check: GET http://localhost:${PORT}/health`);
});
