import { deriveChatTitle } from "../../shared/herald";
import type { Citation } from "../../shared/herald";
import type { HeraldThread } from "../repos/herald-thread.repo";
import { InvalidArgs } from "../api/errors";

export const SUMMARY_THRESHOLD_MESSAGES = 40;
export const SUMMARY_THRESHOLD_BYTES = 64 * 1024;
export const SUMMARY_WINDOW = 8;
export const DOC_IMAGE_CAPS = { maxCount: 5, maxBytesEach: 5 * 1024 * 1024 };
export const CHAT_IMAGE_CAPS = { maxCount: 3, maxTotalBytes: Math.floor(1.5 * 1024 * 1024) };
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MENTION_CAPS = { maxMentions: 5, maxPerDocumentChars: 4000, maxTotalChars: 20000 };
export function scanMentionTokens(text: string): string[] { const out: string[] = []; for (const m of text.matchAll(/(?<![A-Za-z0-9])@([A-Za-z0-9][A-Za-z0-9_-]*)/g)) out.push(m[1]!); return out; }
export interface ResolvedMention { kind: "task" | "wiki"; id: string; label: string; text: string; }
export function buildMentionContextBlock(resolved: ResolvedMention[]): string {
  if (resolved.length === 0) return "";
  const lines: string[] = ["Referenced by the user just now:"];
  let total = 0; let used = 0;
  for (const m of resolved) {
    if (used >= MENTION_CAPS.maxMentions) break;
    const text = m.text.length > MENTION_CAPS.maxPerDocumentChars ? `${m.text.slice(0, MENTION_CAPS.maxPerDocumentChars)}…` : m.text;
    const line = `- [${m.kind}] ${m.label}\n${text}`;
    if (total + line.length > MENTION_CAPS.maxTotalChars) break;
    lines.push(line); total += line.length; used += 1;
  }
  return lines.join("\n");
}
export interface StoredImageRef { type: "image-ref"; storageKey: string; mimeType: string; }
export function isStoredImageRef(part: unknown): part is StoredImageRef { return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image-ref" && typeof (part as { storageKey?: unknown }).storageKey === "string"; }
export type ThreadVerdict = { mode: "continue"; messages: unknown[]; summary: string | null; summarizedCount: number } | { mode: "fresh"; messages: unknown[]; summary: null; summarizedCount: number };
export function resolveHeraldThread(existing: HeraldThread | null, agentId: string | null, skillId: string | null): ThreadVerdict {
  if (existing && existing.agentId === agentId && existing.skillId === skillId) return { mode: "continue", messages: existing.messages, summary: existing.summary, summarizedCount: existing.summarizedCount };
  return { mode: "fresh", messages: [], summary: null, summarizedCount: 0 };
}
export function resolveChatTitle(existing: HeraldThread | null, message: string): string | null { if (existing?.title) return existing.title; return deriveChatTitle(message) || null; }
export const CHAT_SNIPPET_WINDOW = 40;
export const CHAT_CITATION_CAP = 10;
export function collectCitation(existing: Citation[], c: Citation): Citation[] {
  if (!c.url.startsWith("https://")) return existing;
  if (existing.some((x) => x.url === c.url)) return existing;
  if (existing.length >= CHAT_CITATION_CAP) return existing;
  return [...existing, c];
}
export function validateChatFromIndex(messages: unknown[], fromIndex: number): void {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > messages.length) throw new InvalidArgs({ reason: `fromIndex must be an integer between 0 and ${messages.length}` });
  if (fromIndex < messages.length) { const target = messages[fromIndex] as { role?: unknown; content?: unknown } | undefined; if (!target || target.role !== "user" || typeof target.content !== "string") throw new InvalidArgs({ reason: "edited turn must target a user message with text content" }); }
}
export function buildChatExport(t: { title: string | null; messages: unknown[] }): string {
  const lines: string[] = [`# ${t.title ?? "chat"}`];
  const citeLine = (c: { title: string | null; url: string }) => c.title ? `- [${c.title}](${c.url})` : `- <${c.url}>`;
  for (const raw of t.messages) {
    const m = raw as { role?: unknown; content?: unknown; ts?: unknown; citations?: unknown; error?: unknown; stopped?: unknown };
    if (m.role !== "user" && m.role !== "assistant") continue;
    const who = m.role === "user" ? "You" : "Herald";
    const ts = typeof m.ts === "string" && m.ts !== "" ? ` · ${m.ts}` : "";
    lines.push(""); lines.push(`**${who}**${ts}`);
    if (typeof m.content === "string") lines.push(m.content);
    else if (Array.isArray(m.content)) { for (const part of m.content) { const p = part as { type?: unknown; content?: unknown; text?: unknown }; if ((p.type === "text" || p.type === undefined) && typeof p.content === "string") lines.push(p.content); else if (typeof p.text === "string") lines.push(p.text); else lines.push("[image]"); } }
    if (Array.isArray(m.citations)) for (const c of m.citations) { const cit = c as { title?: unknown; url?: unknown }; if (typeof cit.url === "string") lines.push(citeLine({ title: typeof cit.title === "string" ? cit.title : null, url: cit.url })); }
    if (m.error && typeof m.error === "object" && typeof (m.error as { code?: unknown }).code === "string") lines.push(`[failed turn: ${(m.error as { code: string }).code}]`);
    if (m.stopped === true) lines.push("[stopped]");
  }
  return `${lines.join("\n")}\n`;
}
export function buildChatSnippet(messages: unknown[], q: string): string | null {
  const flat = messages.map((m) => (typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "")).filter((s) => s !== "").join("\n");
  if (flat === "") return null;
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - CHAT_SNIPPET_WINDOW);
  const end = Math.min(flat.length, idx + q.length + CHAT_SNIPPET_WINDOW);
  const core = flat.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < flat.length ? "…" : ""}`;
}
export function assertAttachmentCaps(refs: Array<{ mimeType: string; size: number }>, caps: { maxCount: number; maxBytesEach?: number; maxTotalBytes?: number }): void {
  if (refs.length > caps.maxCount) throw new InvalidArgs({ reason: `at most ${caps.maxCount} images per message` });
  let total = 0;
  for (const ref of refs) {
    if (!IMAGE_MIME_TYPES.includes(ref.mimeType)) throw new InvalidArgs({ reason: `unsupported image type ${ref.mimeType}` });
    if (caps.maxBytesEach !== undefined && ref.size > caps.maxBytesEach) throw new InvalidArgs({ reason: `image exceeds the ${Math.round(caps.maxBytesEach / (1024 * 1024))} MB limit` });
    total += ref.size;
  }
  if (caps.maxTotalBytes !== undefined && total > caps.maxTotalBytes) throw new InvalidArgs({ reason: `images exceed the ${Math.round(caps.maxTotalBytes / (1024 * 1024))} MB request limit` });
}
export function bytesToBase64(bytes: Uint8Array): string { let bin = ""; const CHUNK = 0x8000; for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK)); return btoa(bin); }
export async function hydrateImageParts(messages: unknown[], load: (key: string) => Promise<string | null>): Promise<import("@tanstack/ai").ModelMessage[]> {
  const out: import("@tanstack/ai").ModelMessage[] = [];
  for (const message of messages) {
    const msg = message as import("@tanstack/ai").ModelMessage;
    if (!Array.isArray(msg.content)) { out.push(msg); continue; }
    const parts: unknown[] = [];
    for (const raw of msg.content) { const candidate: unknown = raw; if (!isStoredImageRef(candidate)) { parts.push(raw); continue; } const base64 = await load(candidate.storageKey).catch(() => null); if (base64 === null) continue; parts.push({ type: "image", source: { type: "data", value: base64, mimeType: candidate.mimeType } }); }
    out.push({ ...msg, content: parts } as import("@tanstack/ai").ModelMessage);
  }
  return out;
}
export async function replaceImageRefsWithPlaceholders(messages: unknown[]): Promise<import("@tanstack/ai").ModelMessage[]> {
  const out: import("@tanstack/ai").ModelMessage[] = [];
  for (const message of messages) {
    const msg = message as import("@tanstack/ai").ModelMessage;
    if (!Array.isArray(msg.content)) { out.push(msg); continue; }
    const parts: unknown[] = [];
    for (const raw of msg.content) { const candidate: unknown = raw; if (!isStoredImageRef(candidate)) { parts.push(raw); continue; } parts.push({ type: "text", content: `[attached image: ${candidate.storageKey}]` }); }
    out.push({ ...msg, content: parts } as import("@tanstack/ai").ModelMessage);
  }
  return out;
}
export function needsSummary(messages: unknown[]): boolean { if (messages.length > SUMMARY_THRESHOLD_MESSAGES) return true; try { return JSON.stringify(messages).length > SUMMARY_THRESHOLD_BYTES; } catch { return false; } }
export function resolveReasoningEffort(rowEffort: import("../../shared/herald").HeraldReasoningEffort | null, override?: import("../../shared/herald").HeraldReasoningEffort | null): import("../../shared/herald").HeraldReasoningEffort | null { return override ?? rowEffort ?? null; }
export function modelOptionsForEffort(effort: import("../../shared/herald").HeraldReasoningEffort | null): Record<string, unknown> | undefined { return effort === null ? undefined : { reasoning_effort: effort }; }

export const HERALD_HALLUCINATION_RE = /(sudah dibuat|berhasil dibuat|successfully created|has been created|created successfully)/i;
export const HERALD_WRITE_INTENT_RE =
  /\b(bikin|buat|tambah|create|update|archive|edit|hapus)\b.*\b(milestone|sprint|task|wiki|page|comment)\b|\b(bikin|buat)\s+(milestone|sprint|task)\b|\bcreate\s+(milestone|sprint|task|wiki)\b/i;
export function hasHeraldWriteIntent(message: string): boolean {
  if (!message || !message.trim()) return false;
  return HERALD_WRITE_INTENT_RE.test(message);
}
export function modelOptionsWithWriteIntent(
  base: Record<string, unknown> | undefined,
  message: string,
  writeTools: string[]
): Record<string, unknown> | undefined {
  if (writeTools.length === 0 || !hasHeraldWriteIntent(message)) return base;
  const extra: Record<string, unknown> = { tool_choice: "required" };
  return base ? { ...base, ...extra } : extra;
}
