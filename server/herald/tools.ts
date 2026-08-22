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

export const MAX_TOOL_ROUNDS = 4;

const SNIPPET_CAP = 500;
const S3_FILE_CAP = 5 * 1024 * 1024;
const PDF_PAGE_CAP = 50;

export type FetchLike = typeof fetch;

export interface TaskRef {
  id: string;
  key: string;
  title: string;
  priority: string;
  dueAt: string | null;
  archivedAt: string | null;
  markdown: string;
}

export interface HeraldToolDeps {
  projectId: string;
  allowlist: string | null;
  searchApiKey: string | null;
  fetchImpl: FetchLike;
  storageGet: (key: string) => Promise<Uint8Array>;
  projectOwnsStorageKey: (projectId: string, key: string) => Promise<boolean>;
  findTaskByRef: (ref: string) => Promise<TaskRef | null>;
  searchTasksByTitle: (query: string, limit?: number) => Promise<TaskRef[]>;
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
// (scheme/IP/allowlist). A redirect never bypasses the guards.
export async function fetchUrlText(rawUrl: string, allowlist: string | null, fetchImpl: FetchLike): Promise<string> {
  let current = validateUrl(rawUrl, allowlist);
  for (let hop = 0; hop <= FETCH_URL_MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      headers: { "user-agent": "Lexa-Herald/1.0" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new UrlBlocked({ reason: "redirect without a location" });
      if (hop === FETCH_URL_MAX_REDIRECTS) throw new UrlBlocked({ reason: "too many redirects" });
      current = validateUrl(new URL(location, current).toString(), allowlist);
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

function summarizeTask(t: TaskRef) {
  return { id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archived: t.archivedAt !== null };
}

// Build the active v1 read-only toolset. web_search is included only when an
// Exa key is configured; everything else rides along unconditionally.
export function buildHeraldTools(deps: HeraldToolDeps) {
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
      inputSchema: z.object({ url: z.string().url() }),
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
        "Read one task by id or by its human key (PREFIX-n, e.g. LEX-12). Returns title, priority, due date and the description as markdown.",
      inputSchema: z.object({ ref: z.string().min(1).describe("Task id or PREFIX-n key") }),
      outputSchema: z.object({
        task: z.object(summarizeTaskShape()).extend({ markdown: z.string() }).nullable(),
        error: z.string().optional(),
      }),
    }).server(async ({ ref }) => {
      const task = await deps.findTaskByRef(ref);
      return { task: task ? { ...summarizeTask(task), markdown: task.markdown } : null, error: task ? undefined : "task not found" };
    })
  );

  tools.push(
    toolDefinition({
      name: "search_tasks",
      description: "Search this project's tasks by title substring. Returns at most 10 matches.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
      outputSchema: z.object({ tasks: z.array(z.object(summarizeTaskShape())) }),
    }).server(async ({ query, limit }) => {
      const tasks = await deps.searchTasksByTitle(query, limit ?? 10);
      return { tasks: tasks.map(summarizeTask) };
    })
  );

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
