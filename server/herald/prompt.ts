import type { RepoContentEntry } from "../services/forge-repo-content";

export const IDENTITY = `You are Herald, the writing and project-management assistant inside Lexa, a self-hosted project management tool. You help with drafting, editing, summarizing, planning, and answering questions about the current project.

Your output is inserted into a document by the user. Follow the markdown contract exactly: reply with the requested content only — no preamble, no commentary, no code fences around the whole answer unless the user asked for them.`;

export const CHAT_IDENTITY = `You are Herald, the conversational assistant inside Lexa, a self-hosted project management tool. You chat with one member of the project's workspace — answer questions, help plan work, look things up with your tools when useful.

Reply conversationally in markdown. There is no insertion contract; normal prose is fine.`;

export const MARKDOWN_STYLE = `Markdown contract:
- The editor consumes GitHub-flavored markdown via a single conversion step.
- Use headings (##), bullet lists, bold/italic, tables, fenced code blocks with a language tag, and [links](https://…).
- Never emit raw HTML.
- Keep structure flat enough for a document body: start at ## when you use headings.`;

// Anthropic-only cache_control breakpoints. OpenAI-compatible providers have
// no per-prompt metadata — provider.ts strips it at the boundary.
export interface CacheablePrompt {
  content: string;
  cache_control?: { type: "ephemeral" };
}

// Memory terms are computed at stream time from the freshest document state
// (declared deviation from enqueue-time computation).
export function extractMemoryTerms(title: string, docText: string): string[] {
  const words = `${title} ${docText}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  return [...new Set(words)].slice(0, 12);
}

export function memoryBlockFromHits(hits: string[]): string | null {
  if (hits.length === 0) return null;
  return [
    "Project memory (curated facts about this project — treat as standing context):",
    ...hits.map((h) => `- ${h}`),
  ].join("\n");
}

function repoContentBlock(entries: RepoContentEntry[]): string | null {
  if (entries.length === 0) return null;
  const parts = entries.map((e) => `--- ${e.repo}:${e.path} ---\n${e.content}`);
  return `Linked repository context:\n\n${parts.join("\n\n")}`;
}

function docContextBlock(docContext: string): string | null {
  if (!docContext.trim()) return null;
  return `Current document content:\n\n${docContext}`;
}

export interface SystemPromptInput {
  identity: string;
  memoryBlock: string | null;
  agentMarkdown: string | null;
  skillMarkdown: string | null;
  repoContent?: RepoContentEntry[];
  docContext?: string;
  // Ephemeral @-mention context (chat only) — resolved at send, NEVER
  // persisted into the user message.
  mentionContext?: string;
}

// Order is cache-friendly: [0] identity+style+memory changes rarely,
// [1] agent/skill rules change rarely; repo/doc context rides last without
// a breakpoint so per-document churn never busts the cached prefix.
export function buildSystemPrompts(input: SystemPromptInput): CacheablePrompt[] {
  const segments: string[] = [input.identity, MARKDOWN_STYLE];
  if (input.memoryBlock) segments.push(input.memoryBlock);

  const prompts: CacheablePrompt[] = [
    { content: segments.join("\n\n"), cache_control: { type: "ephemeral" } },
  ];

  const rules = [input.agentMarkdown, input.skillMarkdown].filter((s): s is string => !!s && s.trim() !== "");
  prompts.push({
    content:
      rules.length > 0
        ? rules.join("\n\n")
        : "No additional behavior rules are active. Use your default judgment.",
    cache_control: { type: "ephemeral" },
  });

  const contextBlocks = [
    repoContentBlock(input.repoContent ?? []),
    docContextBlock(input.docContext ?? ""),
    input.mentionContext && input.mentionContext.trim() !== "" ? input.mentionContext : null,
  ].filter((b): b is string => b !== null);
  if (contextBlocks.length > 0) prompts.push({ content: contextBlocks.join("\n\n") });

  return prompts;
}

export interface UserMessageInput {
  instruction: string;
  summary?: string | null;
  summarizedCount?: number;
}

export function buildUserMessage(input: UserMessageInput): string {
  if (input.summary && input.summary.trim() !== "") {
    const segment = `[Conversation summary — the ${input.summarizedCount ?? 0} earlier turns below were condensed]\n${input.summary.trim()}\n[end of summary]`;
    return `${segment}\n\n${input.instruction}`;
  }
  return input.instruction;
}
