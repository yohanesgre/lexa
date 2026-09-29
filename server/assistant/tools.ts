import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { extractText } from "unpdf";
import {
  FETCH_URL_MAX_REDIRECTS,
  FETCH_URL_PDF_CAP,
  FETCH_URL_TEXT_CAP,
  FETCH_URL_TIMEOUT_MS,
  UrlBlocked,
  validateUrl,
} from "./ssrf";
import { docToMarkdown } from "../../shared/markdown";
import type { TipTapDoc } from "../../shared/types";
import {
  jevLog,
  JEV_TOOL_TIMEOUT_MS,
  systemOne,
  type JevAnswer,
  type JevFailureCode,
  type JevQuestions,
  type JevRuntimeConfig,
  type JevUsage,
} from "./jev";

export const MAX_TOOL_ROUNDS = 12;
export const MAX_CHAT_TOOL_ROUNDS = 24;

const SNIPPET_CAP = 500;
const S3_FILE_CAP = 5 * 1024 * 1024;
const PDF_PAGE_CAP = 50;
export const WIKI_READ_CAP = 8000;
export const ALL_TASKS_CAP = 60000;
export const ALL_WIKI_CAP = 60000;

export type FetchLike = typeof fetch;

export interface TaskRef {
  id: string;
  key: string;
  title: string;
  priority: string;
  dueAt: string | null;
  archivedAt: string | null;
  markdown: string;
  columnName?: string;
  swimlaneName?: string;
  milestoneName?: string | null;
  type?: string;
  assignees?: string[];
  githubIssue?: { repo: string; number: number } | null;
}

export interface BoardColumn {
  id: string;
  name: string;
  position: number;
  wipLimit: number | null;
  githubState: "open" | "closed" | null;
  isDone: boolean;
}

export interface BoardSwimlane {
  id: string;
  name: string;
  kind: "backlog" | "sprint";
  startAt: string | null;
  dueAt: string | null;
  archived: boolean;
  milestoneId: string | null;
}

export interface BoardMilestone {
  id: string;
  name: string;
  dueAt: string | null;
  archived: boolean;
}

export interface BoardStructure {
  columns: BoardColumn[];
  swimlanes: BoardSwimlane[];
  milestones: BoardMilestone[];
}

export interface WikiSearchHit {
  title: string;
  slug: string;
  snippet: string;
}

export interface WikiPageContent {
  title: string;
  slug: string;
  content: TipTapDoc;
}

export interface BoundSkill {
  name: string;
  description: string | null;
  instructions: string | null;
}

export interface AssistantToolDeps {
  projectId: string;
  allowlist: string | null;
  searchApiKey: string | null;
  // Jev advisory config, resolved per run from the DB registry. Absent/null
  // omits `jev_assess` entirely — the service already encodes configured +
  // per-project opt-in + stored key, so presence is the whole gate.
  jevConfig?: JevRuntimeConfig | null | undefined;
  fetchImpl: FetchLike;
  storageGet: (key: string) => Promise<Uint8Array>;
  projectOwnsStorageKey: (projectId: string, key: string) => Promise<boolean>;
  findTaskByRef: (ref: string) => Promise<TaskRef | null>;
  searchTasksByTitle: (query: string, limit?: number) => Promise<TaskRef[]>;
  searchWikiPages: (query: string, limit?: number) => Promise<WikiSearchHit[]>;
  findWikiPageBySlug: (slug: string) => Promise<WikiPageContent | null>;
  listAllTasks: () => Promise<TaskRef[]>;
  listWikiPagesFull: () => Promise<WikiPageContent[]>;
  getBoardStructure: () => Promise<BoardStructure>;
  // Junction-scoped skill loader. Callers pass it ONLY when the agent has at
  // least one bound skill: present → the `get_skill` read tool is offered;
  // absent → it is omitted entirely (no bound-skill surface to discover).
  loadSkillByName?: ((name: string) => Promise<BoundSkill | null>) | undefined;
  // Chat citation collection: fired for web_search results and successful
  // fetch_url targets. The collector (service side) enforces cap/dedupe/https.
  onCitation?: (citation: { title: string | null; url: string }) => void;
}

export interface ExaResult {
  title: string;
  url: string;
  snippet: string;
}

// Thin Exa wrapper — provider field swappable without touching the tool.
export async function exaSearch(query: string, apiKey: string, fetchImpl: FetchLike): Promise<ExaResult[]> {
  const res = await fetchImpl("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, numResults: 5 }),
    signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new Error("EXA_AUTH_FAILED");
  if (!res.ok) throw new Error(`EXA_HTTP_${res.status}`);
  const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
  return (body.results ?? []).slice(0, 5).map((r) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.text ?? "").slice(0, SNIPPET_CAP),
  }));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdf = await extractText(bytes, { mergePages: false });
  const pages = pdf.text.slice(0, PDF_PAGE_CAP);
  return pages.join("\n\n").slice(0, FETCH_URL_TEXT_CAP);
}

// Manual redirect loop — every Location hop re-runs full validation
// (scheme/IP/allowlist). A redirect never bypasses the guards. The URL is
// re-validated immediately before each fetch so the DNS answer the guard
// vetted is the freshest available (Bun's fetch exposes no custom lookup to
// pin the vetted address; a narrow rebinding window remains).
export async function fetchUrlText(rawUrl: string, allowlist: string | null, fetchImpl: FetchLike): Promise<string> {
  let next = rawUrl;
  for (let hop = 0; hop <= FETCH_URL_MAX_REDIRECTS; hop++) {
    const current = await validateUrl(next, allowlist);
    const res = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      headers: { "user-agent": "Lexa-Assistant/1.0" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new UrlBlocked({ reason: "redirect without a location" });
      if (hop === FETCH_URL_MAX_REDIRECTS) throw new UrlBlocked({ reason: "too many redirects" });
      next = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/pdf")) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > FETCH_URL_PDF_CAP) throw new Error("PDF exceeds the 5 MB limit");
      return extractPdf(buf);
    }
    const text = await res.text();
    const capped = text.length > FETCH_URL_TEXT_CAP ? text.slice(0, FETCH_URL_TEXT_CAP) : text;
    return contentType.includes("text/html") ? htmlToText(capped) : capped;
  }
  throw new UrlBlocked({ reason: "too many redirects" });
}

// ── Jev advisory tool ──────────────────────────────────────────────────────
//
// Bounds are hard caps, and oversize input is REFUSED rather than truncated:
// a judgment silently computed over a clipped state is a judgment over
// something the model never sent, so the model gets a typed failure and can
// re-send a shorter state. The preflight state builder is the only lossy path:
// every field is clipped at its own cap and marked (`…`), but the total-state
// squeeze also drops a field outright, and sheds memory items from the tail,
// without a marker.

export const JEV_ASSESS_MAX_STATE_CHARS = 4000;
export const JEV_ASSESS_MAX_QUESTIONS = 8;
// Per stream invocation: buildAssistantTools runs once per buildStream, so this
// counter cannot outlive the run that created it (a resume gets a fresh one).
export const JEV_ASSESS_MAX_CALLS = 3;
export const JEV_ASSESS_BUDGET_CODE = "BUDGET_EXCEEDED";

export type JevAssessFailureCode = JevFailureCode | "STATE_TOO_LARGE" | "TOO_MANY_QUESTIONS" | "NO_QUESTIONS" | typeof JEV_ASSESS_BUDGET_CODE;

export type JevAssessResult =
  | { ok: true; answers: Record<string, JevAnswer>; usage: JevUsage }
  | { ok: false; code: JevAssessFailureCode; message: string };

const JEV_ASSESS_MESSAGES: Record<Exclude<JevAssessFailureCode, JevFailureCode>, string> = {
  STATE_TOO_LARGE: `state exceeds the ${JEV_ASSESS_MAX_STATE_CHARS}-character limit — re-send a shorter state`,
  TOO_MANY_QUESTIONS: `at most ${JEV_ASSESS_MAX_QUESTIONS} questions per call`,
  NO_QUESTIONS: "at least one question is required",
  [JEV_ASSESS_BUDGET_CODE]: `budget exhausted — at most ${JEV_ASSESS_MAX_CALLS} jev_assess calls per run`,
};

function jevFailure(code: JevAssessFailureCode, message: string): { ok: false; code: JevAssessFailureCode; message: string } {
  return { ok: false, code, message: JEV_ASSESS_MESSAGES[code as Exclude<JevAssessFailureCode, JevFailureCode>] ?? message };
}

const jevContentSchema = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
const jevNoulCriteriaSchema = z.object({ true: jevContentSchema.optional(), false: jevContentSchema.optional() });

// Mirrors the System 1 question contract: `noul` carries an optional
// true/false description pair, `choice` a map of distinct options, `score` an
// ordered level list. A malformed question never reaches the wire.
const jevQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), instructions: jevContentSchema, criteria: jevNoulCriteriaSchema.optional() }),
  z.object({ type: z.literal("choice"), instructions: jevContentSchema, criteria: z.record(z.string(), jevContentSchema.nullable()) }),
  z.object({ type: z.literal("score"), instructions: jevContentSchema, criteria: z.array(z.unknown()).min(2).max(10) }),
]);

function buildJevAssessTool(cfg: { config: JevRuntimeConfig; fetchImpl: FetchLike }) {
  let calls = 0;
  // `latencyMs` is optional in the log meta: a budget refusal is decided before
  // any request, so there is no honest latency to report and the field is
  // omitted rather than logged as 0.
  const log = (outcome: "advisory" | "failed" | "skipped", code: JevAssessFailureCode | undefined, latencyMs: number | undefined, usage: JevUsage | undefined): void =>
    jevLog("assess", {
      outcome,
      ...(code !== undefined ? { code } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(usage !== undefined ? { usage } : {}),
    });

  return toolDefinition({
    name: "jev_assess",
    description:
      "Ask Jev, a fast System 1 judgment API, for a typed second opinion on state you already have. Read-only and advisory: it cannot create, change or approve anything. Pass a compact state (<=4000 chars) and up to 8 noul/choice/score questions. Returns typed answers, or a typed failure the stream continues past. Max 3 calls per run.",
    inputSchema: z.object({
      state: z.string().min(1).describe("The context to judge, <=4000 characters"),
      questions: z.record(z.string().min(1), jevQuestionSchema).describe("Up to 8 questions keyed by a caller-chosen id"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      answers: z.record(z.string(), z.unknown()).optional(),
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
      code: z.string().optional(),
      message: z.string().optional(),
    }),
  }).server(async ({ state, questions }): Promise<JevAssessResult> => {
    const ids = Object.keys(questions);
    if (ids.length === 0) return jevFailure("NO_QUESTIONS", "");
    if (ids.length > JEV_ASSESS_MAX_QUESTIONS) return jevFailure("TOO_MANY_QUESTIONS", "");
    if (state.length > JEV_ASSESS_MAX_STATE_CHARS) return jevFailure("STATE_TOO_LARGE", "");

    if (calls >= JEV_ASSESS_MAX_CALLS) {
      log("failed", JEV_ASSESS_BUDGET_CODE, undefined, undefined);
      return jevFailure(JEV_ASSESS_BUDGET_CODE, "");
    }
    calls += 1;

    const started = Date.now();
    try {
      const res = await systemOne({
        state,
        questions: questions as JevQuestions,
        apiKey: cfg.config.apiKey,
        baseUrl: cfg.config.baseUrl,
        model: cfg.config.model,
        fetchImpl: cfg.fetchImpl,
        timeoutMs: JEV_TOOL_TIMEOUT_MS,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        log(res.code === "MISSING_KEY" ? "skipped" : "failed", res.code, latencyMs, undefined);
        return { ok: false, code: res.code, message: res.message };
      }
      log("advisory", undefined, latencyMs, res.usage);
      return { ok: true, answers: res.answers, usage: res.usage };
    } catch {
      // systemOne is total, so this is belt-and-braces: a Jev failure must
      // never throw into the assistant stream.
      log("failed", "NETWORK", Date.now() - started, undefined);
      return { ok: false, code: "NETWORK", message: "Jev request failed before a response" };
    }
  });
}

// Build the active v1 read-only toolset. web_search is included only when an
// Exa key is configured; everything else rides along unconditionally.
export function buildAssistantTools(deps: AssistantToolDeps) {
  const tools = [];

  if (deps.searchApiKey !== null && deps.searchApiKey !== "") {
    const searchApiKey = deps.searchApiKey;
    tools.push(
      toolDefinition({
        name: "web_search",
        description: "Search the web with Exa. Returns up to 5 results with title, URL and a short snippet.",
        inputSchema: z.object({ query: z.string().min(1).describe("The search query") }),
        outputSchema: z.object({
          results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
          error: z.string().optional(),
        }),
      }).server(async ({ query }) => {
        try {
          const results = await exaSearch(query, searchApiKey, deps.fetchImpl);
          for (const r of results) deps.onCitation?.({ title: r.title || null, url: r.url });
          return { results };
        } catch (e) {
          return { results: [], error: e instanceof Error ? e.message : "search failed" };
        }
      })
    );
  }

  tools.push(
    toolDefinition({
      name: "fetch_url",
      description:
        "Fetch a public http(s) URL and return its content as plain text (HTML is stripped; PDFs are extracted, max 50 pages / 5 MB). Private and reserved network addresses are blocked.",
      inputSchema: z.object({ url: z.url() }),
      outputSchema: z.object({ content: z.string(), error: z.string().optional() }),
    }).server(async ({ url }) => {
      try {
        const content = await fetchUrlText(url, deps.allowlist, deps.fetchImpl);
        try {
          const target = new URL(url);
          if (target.protocol === "https:") deps.onCitation?.({ title: target.hostname, url: target.toString() });
        } catch {
          // unreachable — fetchUrlText already validated the URL
        }
        return { content };
      } catch (e) {
        if (e instanceof UrlBlocked) return { content: "", error: `blocked: ${e.reason}` };
        return { content: "", error: e instanceof Error ? e.message : "fetch failed" };
      }
    })
  );

  tools.push(
    toolDefinition({
      name: "read_s3_file",
      description:
        "Read a file from this project's attachment storage by storage key. Returns UTF-8 text for textual files, or a binary descriptor. Cross-project reads are rejected.",
      inputSchema: z.object({ key: z.string().min(1).describe("Attachment storage key, e.g. blobs/<sha256>") }),
      outputSchema: z.object({ content: z.string(), mimeType: z.string(), error: z.string().optional() }),
    }).server(async ({ key }) => {
      try {
        if (!(await deps.projectOwnsStorageKey(deps.projectId, key))) {
          return { content: "", mimeType: "", error: "no such attachment in this project" };
        }
        const bytes = await deps.storageGet(key);
        if (bytes.byteLength > S3_FILE_CAP) return { content: "", mimeType: "", error: "file exceeds the 5 MB limit" };
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { content: decoded.slice(0, FETCH_URL_TEXT_CAP), mimeType: "text/plain" };
      } catch {
        return { content: "", mimeType: "application/octet-stream", error: "file could not be read" };
      }
    })
  );

  tools.push(
    toolDefinition({
      name: "get_task",
      description:
        "Read one task by id or by its human key (PREFIX-n, e.g. LEX-12). Returns title, priority, due date, board context and the description as markdown.",
      inputSchema: z.object({ ref: z.string().min(1).describe("Task id or PREFIX-n key") }),
      outputSchema: z.object({
        task: z
          .object(summarizeTaskShape())
          .extend({
            markdown: z.string(),
            columnName: z.string().optional(),
            swimlaneName: z.string().optional(),
            milestoneName: z.string().nullable().optional(),
            type: z.string().optional(),
            assignees: z.array(z.string()).optional(),
            githubIssue: z.object({ repo: z.string(), number: z.number() }).nullable().optional(),
          })
          .nullable(),
        error: z.string().optional(),
      }),
    }).server(async ({ ref }) => {
      const task = await deps.findTaskByRef(ref);
      return { task: task ? enrichTask(task) : null, error: task ? undefined : "task not found" };
    })
  );

  tools.push(
    toolDefinition({
      name: "search_tasks",
        description: "Search this project's tasks by title substring. Returns at most 10 matches.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.coerce.number().int().min(1).max(10).optional().catch(10) }),
      outputSchema: z.object({ tasks: z.array(z.object(summarizeTaskShape())) }),
    }).server(async ({ query, limit }) => {
      const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.min(10, Math.max(1, Math.floor(limit))) : 5;
      const effective = limit === undefined ? 10 : safeLimit;
      const tasks = await deps.searchTasksByTitle(query, effective);
      return { tasks: tasks.map(summarizeTask) };
    })
  );

  tools.push(
    toolDefinition({
      name: "search_wiki",
      description:
        "Full-text search this project's wiki pages. Returns at most 10 matches with title, slug and a highlighted snippet.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.coerce.number().int().min(1).max(10).optional().catch(5) }),
      outputSchema: z.object({
        pages: z.array(z.object({ title: z.string(), slug: z.string(), snippet: z.string() })),
      }),
    }).server(async ({ query, limit }) => {
      const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.min(10, Math.max(1, Math.floor(limit))) : 5;
      const effective = limit === undefined ? 10 : safeLimit;
      const pages = await deps.searchWikiPages(query, effective);
      return { pages };
    })
  );

  tools.push(
    toolDefinition({
      name: "read_wiki_page",
      description:
        "Read one wiki page by slug. Returns the title and the content converted to markdown (capped at ~8k characters).",
      inputSchema: z.object({ slug: z.string().min(1).describe("Wiki page slug") }),
      outputSchema: z.object({
        page: z.object({ title: z.string(), slug: z.string(), markdown: z.string() }).nullable(),
        error: z.string().optional(),
      }),
    }).server(async ({ slug }) => {
      const page = await deps.findWikiPageBySlug(slug);
      if (!page) return { page: null, error: "wiki page not found" };
      return {
        page: {
          title: page.title,
          slug: page.slug,
          markdown: docToMarkdown(page.content).slice(0, WIKI_READ_CAP),
        },
      };
    })
  );

  tools.push(
    toolDefinition({
      name: "get_all_tasks",
      description:
        "Read every task in this project, including archived ones, each with its full description as markdown. Output is capped at ~60k characters total; truncated:true means tasks were dropped.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        tasks: z.array(z.object(summarizeTaskShape()).extend({ markdown: z.string() })),
        truncated: z.boolean().optional(),
      }),
    }).server(async () => {
      const tasks: Array<ReturnType<typeof summarizeTask> & { markdown: string }> = [];
      let total = 0;
      let truncated = false;
      for (const t of await deps.listAllTasks()) {
        if (total + t.markdown.length > ALL_TASKS_CAP) {
          truncated = true;
          break;
        }
        total += t.markdown.length;
        tasks.push({ ...summarizeTask(t), markdown: t.markdown });
      }
      return truncated ? { tasks, truncated: true } : { tasks };
    })
  );

  tools.push(
    toolDefinition({
      name: "get_all_wiki_pages",
      description:
        "Read every wiki page in this project as markdown. Each page is capped at ~8k characters and the total at ~60k; truncated:true means pages were dropped.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        pages: z.array(z.object({ title: z.string(), slug: z.string(), markdown: z.string() })),
        truncated: z.boolean().optional(),
      }),
    }).server(async () => {
      const pages: Array<{ title: string; slug: string; markdown: string }> = [];
      let total = 0;
      let truncated = false;
      for (const p of await deps.listWikiPagesFull()) {
        const markdown = docToMarkdown(p.content).slice(0, WIKI_READ_CAP);
        if (total + markdown.length > ALL_WIKI_CAP) {
          truncated = true;
          break;
        }
        total += markdown.length;
        pages.push({ title: p.title, slug: p.slug, markdown });
      }
      return truncated ? { pages, truncated: true } : { pages };
    })
  );

  tools.push(
    toolDefinition({
      name: "get_board_structure",
      description:
        "Read the project's board structure: columns (with WIP limits and GitHub state mapping), swimlanes (sprints/backlog) and milestones.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        columns: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            position: z.number(),
            wipLimit: z.number().nullable(),
            githubState: z.enum(["open", "closed"]).nullable(),
            isDone: z.boolean(),
          })
        ),
        swimlanes: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(["backlog", "sprint"]),
            startAt: z.string().nullable(),
            dueAt: z.string().nullable(),
            archived: z.boolean(),
            milestoneId: z.string().nullable(),
          })
        ),
        milestones: z.array(z.object({ id: z.string(), name: z.string(), dueAt: z.string().nullable(), archived: z.boolean() })),
      }),
    }).server(async () => deps.getBoardStructure())
  );

  // Discovery path for skills the model was not told about: the catalog lists
  // the bound skills, this reads one in full. Junction-scoped by the injected
  // loader — an unbound or deleted name yields a typed error result, never a
  // throw. Offered only when the run wired a loader.
  if (deps.loadSkillByName) {
    const loadSkillByName = deps.loadSkillByName;
    tools.push(
      toolDefinition({
        name: "get_skill",
        description:
          "Read the full instructions of one skill bound to you (name from the catalog or a $name mention). Instructions are capped at ~8k characters.",
        inputSchema: z.object({ name: z.string().min(1).describe("Skill name from the catalog, or the $name you saw") }),
        outputSchema: z.object({
          name: z.string().optional(),
          description: z.string().nullable().optional(),
          instructions: z.string().optional(),
          error: z.string().optional(),
        }),
      }).server(async ({ name }) => {
        const skill = await loadSkillByName(name);
        if (!skill) return { error: `no skill bound to you matches '${name}'` };
        return {
          name: skill.name,
          description: skill.description,
          instructions: (skill.instructions ?? "").slice(0, WIKI_READ_CAP),
        };
      })
    );
  }

  // Jev is advisory-only: the second opinion the model may request on state it
  // already holds, never a mutation path. Present whenever the run resolved a
  // Jev config (new runs AND resumes) — the per-stream call budget lives in the
  // closure below, and each buildAssistantTools call is one stream invocation.
  // Pushed last, after the read toolset, so the tools that produce the state it
  // judges are read first.
  if (deps.jevConfig !== null && deps.jevConfig !== undefined) {
    tools.push(buildJevAssessTool({ config: deps.jevConfig, fetchImpl: deps.fetchImpl }));
  }

  return tools;
}

function summarizeTaskShape() {
  return {
    id: z.string(),
    key: z.string(),
    title: z.string(),
    priority: z.string(),
    dueAt: z.string().nullable(),
    archived: z.boolean(),
  };
}

function summarizeTask(t: TaskRef) {
  return { id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archived: t.archivedAt !== null };
}

function enrichTask(t: TaskRef) {
  return {
    ...summarizeTask(t),
    markdown: t.markdown,
    columnName: t.columnName,
    swimlaneName: t.swimlaneName,
    milestoneName: t.milestoneName,
    type: t.type,
    assignees: t.assignees,
    githubIssue: t.githubIssue,
  };
}

const DETAIL_CAP = 80;

// Human-readable summary of a tool call's INPUT, shown on the tool stream
// frames. Built from the validated args at call time; unknown tools or
// missing fields yield undefined (frame renders name only).
export function toolCallDetail(name: string, rawArgs: unknown): string | undefined {
  const args = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : null;
  const quoted = (prefix: string, value: string | null) => (value ? `${prefix} "${value}"` : undefined);
  const mcp = /^mcp__([a-z0-9_]+)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  let detail: string | undefined;
  switch (name) {
    case "search_wiki":
      detail = quoted("Searching wiki for", str("query"));
      break;
    case "read_wiki_page":
      detail = quoted("Reading wiki page", str("slug"));
      break;
    case "search_tasks":
      detail = quoted("Searching tasks for", str("query"));
      break;
    case "get_task": {
      const ref = str("ref");
      if (ref) detail = `Looking up task ${ref}`;
      break;
    }
    case "web_search":
      detail = quoted("Searching the web for", str("query"));
      break;
    case "fetch_url": {
      const url = str("url");
      if (url) {
        try {
          detail = `Fetching ${new URL(url).hostname}`;
        } catch {
          // invalid URL — no detail
        }
      }
      break;
    }
    case "read_s3_file":
    case "analyze_image": {
      const key = str("storageKey") ?? str("key");
      if (key) detail = `Reading attachment ${key.split("/").pop()}`;
      break;
    }
    case "get_all_tasks":
      detail = "Fetching all tasks";
      break;
    case "get_all_wiki_pages":
      detail = "Reading all wiki pages";
      break;
    case "get_board_structure":
      detail = "Reading board structure";
      break;
    case "get_skill": {
      const name = str("name");
      if (name) detail = `Reading skill ${name}`;
      break;
    }
    case "jev_assess": {
      // The state is the model's own context, not a label worth echoing, and
      // it is up to 4k characters — only the question count is shown.
      const asked = args["questions"];
      const n = typeof asked === "object" && asked !== null && !Array.isArray(asked) ? Object.keys(asked).length : 0;
      detail = n > 0 ? `Asking Jev ${n} question${n === 1 ? "" : "s"}` : "Asking Jev";
      break;
    }
  }
  if (detail === undefined) return undefined;
  return detail.length > DETAIL_CAP ? `${detail.slice(0, DETAIL_CAP - 1)}…` : detail;
}
