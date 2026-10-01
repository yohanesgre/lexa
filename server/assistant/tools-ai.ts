// DO-side AI SDK tool definitions (ADR-0003 §B.5, P3/WS3).
//
// The DO owns only the model-facing surface (name, description, input schema)
// and the transport call; every tool executes in the Worker through the
// internal routes so project data, keys and storage stay behind the HMAC
// boundary (`tools.ts` / `write-tools.ts` remain the Worker-side authority):
//
//   read tool  → POST /api/internal/assistant/tool
//   write tool → POST /api/internal/assistant/write-tool   (pending-write row)
//
// Read-tool results are returned verbatim; a transport failure is surfaced as
// `{ error }` so the model can recover, mirroring the Worker tools' own
// domain-error outputs. Write tools return the Worker's proposal result
// (`{ proposed, approvalId, error }`); the model never mutates anything.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { TipTapDoc } from "../../shared/types";
import { ASSISTANT_WRITE_TOOL_NAMES, MAX_BULK_TASK_REFS } from "./write-tool-names";

export const READ_TOOL_NAMES = [
  "web_search",
  "fetch_url",
  "read_s3_file",
  "get_task",
  "search_tasks",
  "search_wiki",
  "read_wiki_page",
  "get_all_tasks",
  "get_all_wiki_pages",
  "get_board_structure",
  "get_skill",
  "analyze_image",
  "jev_assess",
] as const;

export type AssistantReadToolName = (typeof READ_TOOL_NAMES)[number];

/** Read-tool execution result from the Worker internal route. */
export interface ReadToolResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Write-proposal result from the Worker internal route. */
export type WriteToolResponse =
  | { ok: true; proposed: true; approvalId: string; seq: number }
  | { ok: false; proposed: false; error: string };

export interface AssistantToolTransport {
  /** Execute one read tool in the Worker. Never rejects for a domain failure. */
  read(name: string, args: Record<string, unknown>): Promise<ReadToolResponse>;
  /** Persist one write proposal in the Worker; the turn suspends on success. */
  propose(name: string, args: Record<string, unknown>): Promise<WriteToolResponse>;
}

const tipTapDoc = z
  .looseObject({
    type: z.literal("doc"),
    content: z.array(z.looseObject({ type: z.string() })).optional(),
  }) as unknown as z.ZodType<TipTapDoc, TipTapDoc>;

const taskRefsSchema = z
  .object({
    ref: z.string().min(1).describe("Task id or PREFIX-n key (one task)").optional(),
    refs: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BULK_TASK_REFS)
      .describe(`Task ids or PREFIX-n keys — pass many tasks in one call (max ${MAX_BULK_TASK_REFS})`)
      .optional(),
  })
  .refine((v) => (v.ref === undefined) !== (v.refs === undefined), {
    message: "provide exactly one of 'ref' or 'refs'",
  });

const WRITE_TOOL_SPECS: Record<
  (typeof ASSISTANT_WRITE_TOOL_NAMES)[number],
  { description: string; inputSchema: z.ZodType<unknown> }
> = {
  create_task: {
    description:
      "Propose creating a task in this project. The write is NOT applied until the user approves it. The task lands in the project's first column (or the given sprint/parent).",
    inputSchema: z.object({
      title: z.string().min(1).max(300),
      description: tipTapDoc.optional(),
      priorityId: z.string().optional(),
      typeId: z.string().optional(),
      dueAt: z.string().optional(),
      assigneeIds: z.array(z.string()).optional(),
      parentId: z.string().optional(),
      milestoneId: z.string().optional(),
      sprintId: z.string().optional(),
    }),
  },
  update_task: {
    description:
      "Propose updating a task's title/description/priority/type/due date/assignees. Only provided fields change. Requires user approval.",
    inputSchema: z.object({
      ref: z.string().min(1).describe("Task id or PREFIX-n key"),
      title: z.string().min(1).max(300).optional(),
      description: tipTapDoc.optional(),
      priorityId: z.string().optional(),
      typeId: z.string().optional(),
      dueAt: z.string().nullable().optional(),
      assigneeIds: z.array(z.string()).optional(),
    }),
  },
  move_task: {
    description:
      "Move task to another column and/or swimlane (fellow column / sprint). Provide toColumnId for column move, toSwimlaneId for swimlane move, both together allowed. Optionally before/after a neighbor in the target column. Requires user approval.",
    inputSchema: z.object({
      ref: z.string().min(1).describe("Task id or PREFIX-n key"),
      toColumnId: z.string().min(1),
      toSwimlaneId: z.string().optional(),
      beforeTaskId: z.string().optional(),
      afterTaskId: z.string().optional(),
    }),
  },
  archive_task: {
    description: `Propose archiving a task. Pass \`refs\` to act on many tasks in one call (max ${MAX_BULK_TASK_REFS}) — prefer this over repeated calls. Requires user approval.`,
    inputSchema: taskRefsSchema,
  },
  restore_task: {
    description: `Propose restoring a task. Pass \`refs\` to act on many tasks in one call (max ${MAX_BULK_TASK_REFS}) — prefer this over repeated calls. Requires user approval.`,
    inputSchema: taskRefsSchema,
  },
  delete_task: {
    description: `Propose deleting a task (hard delete — fails if it has subtasks). Pass \`refs\` to act on many tasks in one call (max ${MAX_BULK_TASK_REFS}) — prefer this over repeated calls. Requires user approval.`,
    inputSchema: taskRefsSchema,
  },
  add_comment: {
    description: "Propose adding a comment to a task. Body is a TipTap doc (≤64KB). Requires user approval.",
    inputSchema: z.object({ ref: z.string().min(1).describe("Task id or PREFIX-n key"), body: tipTapDoc }),
  },
  create_wiki_page: {
    description: "Propose creating a wiki page (slug must be free). Content is a TipTap doc. Requires user approval.",
    inputSchema: z.object({
      slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase kebab-case slug"),
      title: z.string().min(1).max(300),
      content: tipTapDoc,
      parentId: z.string().optional(),
    }),
  },
  edit_wiki_page: {
    description: "Propose editing a wiki page's title and/or content. Requires user approval.",
    inputSchema: z.object({
      slug: z.string().min(1),
      title: z.string().min(1).max(300).optional(),
      content: tipTapDoc,
    }),
  },
  delete_wiki_page: {
    description: "Propose deleting a wiki page (fails if it has children). Requires user approval.",
    inputSchema: z.object({ slug: z.string().min(1) }),
  },
  create_milestone: {
    description: 'Propose creating a milestone. Omit optional dueAt if not provided; never send "None" string. Requires user approval.',
    inputSchema: z.object({ name: z.string().min(1).max(200), dueAt: z.string().optional().nullable() }),
  },
  update_milestone: {
    description: "Propose updating a milestone's name and/or due date. Requires user approval.",
    inputSchema: z.object({
      milestoneId: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      dueAt: z.string().nullable().optional(),
    }),
  },
  archive_milestone: {
    description: "Propose archiving a milestone (its sprints archive with it). Requires user approval.",
    inputSchema: z.object({ milestoneId: z.string().min(1) }),
  },
  delete_milestone: {
    description: "Propose deleting a milestone (fails if it has sprints). Requires user approval.",
    inputSchema: z.object({ milestoneId: z.string().min(1) }),
  },
  create_sprint: {
    description: "Propose creating a sprint lane (optionally under a milestone). Requires user approval.",
    inputSchema: z.object({
      milestoneId: z.string().optional(),
      name: z.string().min(1).max(200),
      startAt: z.string().optional(),
      dueAt: z.string().optional(),
    }),
  },
  update_sprint: {
    description: "Propose updating a sprint lane's name and/or dates. Requires user approval.",
    inputSchema: z.object({
      swimlaneId: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      startAt: z.string().nullable().optional(),
      dueAt: z.string().nullable().optional(),
    }),
  },
  archive_sprint: {
    description: "Propose archiving a sprint lane (its live tasks archive with it; Backlog cannot be archived). Requires user approval.",
    inputSchema: z.object({ swimlaneId: z.string().min(1) }),
  },
  delete_sprint: {
    description: "Propose deleting a sprint lane (fails if it has tasks; Backlog cannot be deleted). Requires user approval.",
    inputSchema: z.object({ swimlaneId: z.string().min(1) }),
  },
  move_swimlane: {
    description: "Propose moving a swimlane (sprint) to another milestone, or to Backlog/unassigned when milestoneId is null. Requires user approval.",
    inputSchema: z.object({ swimlaneId: z.string().min(1), milestoneId: z.string().nullable() }),
  },
};

const READ_TOOL_SPECS: Record<
  AssistantReadToolName,
  { description: string; inputSchema: z.ZodType<unknown> }
> = {
  web_search: {
    description: "Search the web with Exa. Returns up to 5 results with title, URL and a short snippet.",
    inputSchema: z.object({ query: z.string().min(1).describe("The search query") }),
  },
  fetch_url: {
    description:
      "Fetch a public http(s) URL and return its content as plain text (HTML is stripped; PDFs are extracted, max 50 pages / 5 MB). Private and reserved network addresses are blocked.",
    inputSchema: z.object({ url: z.url() }),
  },
  read_s3_file: {
    description:
      "Read a file from this project's attachment storage by storage key. Returns UTF-8 text for textual files, or a binary descriptor. Cross-project reads are rejected.",
    inputSchema: z.object({ key: z.string().min(1).describe("Attachment storage key, e.g. blobs/<sha256>") }),
  },
  get_task: {
    description:
      "Read one task by id or by its human key (PREFIX-n, e.g. LEX-12). Returns title, priority, due date, board context and the description as markdown.",
    inputSchema: z.object({ ref: z.string().min(1).describe("Task id or PREFIX-n key") }),
  },
  search_tasks: {
    description: "Search this project's tasks by title substring. Returns at most 10 matches.",
    inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
  },
  search_wiki: {
    description:
      "Full-text search this project's wiki pages. Returns at most 10 matches with title, slug and a highlighted snippet.",
    inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
  },
  read_wiki_page: {
    description:
      "Read one wiki page by slug. Returns the title and the content converted to markdown (capped at ~8k characters).",
    inputSchema: z.object({ slug: z.string().min(1).describe("Wiki page slug") }),
  },
  get_all_tasks: {
    description:
      "Read every task in this project, including archived ones, each with its full description as markdown. Output is capped at ~60k characters total; truncated:true means tasks were dropped.",
    inputSchema: z.object({}),
  },
  get_all_wiki_pages: {
    description:
      "Read every wiki page in this project as markdown. Each page is capped at ~8k characters and the total at ~60k; truncated:true means pages were dropped.",
    inputSchema: z.object({}),
  },
  get_board_structure: {
    description:
      "Read the project's board structure: columns (with WIP limits and GitHub state mapping), swimlanes (sprints/backlog) and milestones.",
    inputSchema: z.object({}),
  },
  get_skill: {
    description:
      "Read the full instructions of one skill bound to you (name from the catalog or a $name mention). Instructions are capped at ~8k characters.",
    inputSchema: z.object({ name: z.string().min(1).describe("Skill name from the catalog, or the $name you saw") }),
  },
  analyze_image: {
    description:
      "Describe an attached image. Call this once per attached image before answering; the user cannot see images directly.",
    inputSchema: z.object({
      storageKey: z.string().min(1).describe("Storage key of the attached image"),
      question: z.string().min(1).describe("What to extract from the image for the user's request"),
    }),
  },
  jev_assess: {
    description:
      "Ask Jev, a fast System 1 judgment API, for a typed second opinion on state you already have. Read-only and advisory: it cannot create, change or approve anything. Pass a compact state (<=4000 chars) and up to 8 noul/choice/score questions. Returns typed answers, or a typed failure the stream continues past. Max 3 calls per run.",
    inputSchema: z.object({
      state: z.string().min(1).describe("The context to judge, <=4000 characters"),
      questions: z.record(
        z.string().min(1),
        z.looseObject({ type: z.enum(["noul", "choice", "score"]) })
      ),
    }),
  },
};

function readResult(response: ReadToolResponse): unknown {
  if (response.ok) return response.result ?? {};
  return { error: response.error ?? "tool failed" };
}

/**
 * Build the read ToolSet. `available` gates the optional tools exactly as the
 * Worker service does (Exa key, bound skills, vision, Jev config); the caller
 * resolves those booleans once per turn.
 */
export function buildReadTools(opts: {
  transport: AssistantToolTransport;
  available: ReadonlySet<string>;
}): ToolSet {
  const tools: ToolSet = {};
  for (const name of READ_TOOL_NAMES) {
    if (!opts.available.has(name)) continue;
    const spec = READ_TOOL_SPECS[name];
    tools[name] = tool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (args: unknown) => opts.transport.read(name, (args ?? {}) as Record<string, unknown>).then(readResult),
    });
  }
  return tools;
}

/** Build the write ToolSet from the enabled names (`parseWriteTools` output). */
export function buildWriteTools(opts: {
  transport: AssistantToolTransport;
  enabled: readonly string[];
}): ToolSet {
  const tools: ToolSet = {};
  for (const name of ASSISTANT_WRITE_TOOL_NAMES) {
    if (!opts.enabled.includes(name)) continue;
    const spec = WRITE_TOOL_SPECS[name];
    tools[name] = tool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (args: unknown) => opts.transport.propose(name, (args ?? {}) as Record<string, unknown>),
    });
  }
  return tools;
}

export const WRITE_TOOL_NAMES = ASSISTANT_WRITE_TOOL_NAMES;
