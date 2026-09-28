// Structured env-file loader — `.env.toml` (canonical) with one-release
// fallback to flat `.env`. Plain module: no Effect, no side effects on import
// (vitest isolation), and `node:fs` — therefore it must never be imported by
// `server/workers-entry.ts` (the Workers isolate has no filesystem).
//
// Schema: sections are presentation only; every leaf key is the env-var name
// verbatim. Depth <=2, leaf keys `^[A-Z][A-Z0-9_]*$`, scalars or scalar arrays
// (arrays join with ","). Duplicate leaf across sections is an error. Errors
// carry key+section context and never echo values.
//
// TOML codec: Bun's native `Bun.TOML` when present; otherwise a schema-sized
// fallback. The fallback exists only so vitest (node, no `Bun` global) can
// exercise this module — it implements the small `.env.toml` subset, not
// general TOML, and is deliberately not a byte-for-byte `Bun.TOML` clone (a
// parity test pins the subset behavior whenever Bun is present).

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, chmodSync, rmSync, renameSync, copyFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RUNTIME_ENV_STRING_KEYS } from "./env";

export interface EnvFileIssue {
  section: string;
  key: string;
  message: string;
}

export class EnvFileError extends Error {
  readonly issues: readonly EnvFileIssue[];
  constructor(issues: readonly EnvFileIssue[]) {
    const detail = issues.map((i) => `${i.section ? `[${i.section}] ` : ""}${i.key || "(file)"}: ${i.message}`).join("; ");
    super(detail || "env file error");
    this.name = "EnvFileError";
    this.issues = issues;
  }
}

// Keys removed from the runtime that migration must drop rather than carry.
export const DEAD_KEYS: readonly string[] = [
  "VITE_LXK_API_KEY",
  "LXK_API_KEY",
  "LXK_ACCESS_AUD",
  "LXK_ACCESS_TEAM",
  "LXK_RUNTIME_DAEMON_TOKEN",
  "LXK_RUNTIME_REPO_CAP",
  "RUNTIME_STALE_RUN_MIN",
];

// Presentation-only section order + key membership. Every RuntimeEnv key has a
// home (asserted below); non-runtime tooling keys map to `core`, unknown keys
// to `other`.
export const ENV_SECTION_ORDER = [
  "core",
  "auth",
  "urls",
  "github",
  "storage",
  "limits",
  "assistant",
  "secrets",
  "logging",
  "backups",
  "dev",
  "workers",
] as const;

const SECTION_BY_KEY = new Map<string, string>();
function section(keys: readonly string[], name: string): void {
  for (const k of keys) SECTION_BY_KEY.set(k, name);
}
section(["COMPOSE_PROJECT_NAME", "LXK_IMAGE_TAG", "CF_TUNNEL_TOKEN", "DATABASE_PATH", "PORT"], "core");
section(["LXK_ADMIN_EMAILS"], "auth");
section(["LXK_ENV", "LXK_PUBLIC_URL", "LXK_TRUSTED_ORIGINS", "LXK_TRUSTED_PROXY_CIDRS"], "urls");
section(["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET"], "github");
section(
  [
    "LXK_STORAGE_DRIVER",
    "LXK_STORAGE_FS_ROOT",
    "LXK_S3_BUCKET",
    "LXK_S3_ACCESS_KEY_ID",
    "LXK_S3_SECRET_ACCESS_KEY",
    "LXK_S3_ENDPOINT",
    "LXK_S3_REGION",
  ],
  "storage"
);
section(["LXK_MAX_BODY_MB", "LXK_MAX_UPLOAD_MB", "LXK_RATE_LIMIT_MAX", "LXK_RATE_LIMIT_WINDOW_MS"], "limits");
section(["LXK_ASSISTANT_REPO_CAP"], "assistant");
section(["LXK_SECRETS_MASTER_KEY", "LXK_SECRETS_MASTER_KEY_PREV"], "secrets");
section(["LOG_LEVEL", "TANSTACK_AI_DEBUG", "TANSTACK_AI_JSON"], "logging");
section(["LXK_BACKUP_ENABLED", "LXK_BACKUP_RETENTION"], "backups");
section(["LXK_SEED_DEV"], "dev");
section(["CRON_SECRET"], "workers");

for (const k of RUNTIME_ENV_STRING_KEYS) {
  if (!SECTION_BY_KEY.has(k)) throw new Error(`env-file: no section mapped for ${k}`);
}

// ─── TOML codec ──────────────────────────────────────────────────────────

interface TomlCodec {
  parse(text: string): Record<string, unknown>;
  stringify(value: Record<string, unknown>): string;
}

function tomlCodec(): TomlCodec {
  const g = globalThis as { Bun?: { TOML?: TomlCodec } };
  const bunToml = g.Bun?.TOML;
  if (bunToml && typeof bunToml.parse === "function" && typeof bunToml.stringify === "function") return bunToml;
  return { parse: parseTomlFallback, stringify: (v) => stringifyTomlFallback(v as Record<string, Record<string, string>>) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function coerceLeaf(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw === "string") return { ok: true, value: raw };
  if (typeof raw === "number" || typeof raw === "boolean") return { ok: true, value: String(raw) };
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        parts.push(String(item));
      } else {
        return { ok: false, message: "array values must be scalars" };
      }
    }
    return { ok: true, value: parts.join(",") };
  }
  return { ok: false, message: "unsupported value type (scalars and scalar arrays only)" };
}

export const LEAF_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

function collectValues(root: Record<string, unknown>): { values: Record<string, string>; issues: EnvFileIssue[] } {
  const values: Record<string, string> = {};
  const issues: EnvFileIssue[] = [];
  const seen = new Map<string, string>();

  const handle = (key: string, raw: unknown, sectionName: string): void => {
    if (!LEAF_KEY_RE.test(key)) {
      issues.push({ section: sectionName, key, message: "invalid key name (expected ^[A-Z][A-Z0-9_]*$)" });
      return;
    }
    const prev = seen.get(key);
    if (prev !== undefined) {
      issues.push({ section: sectionName, key, message: `duplicate key also defined in [${prev}]` });
      return;
    }
    seen.set(key, sectionName);
    const coerced = coerceLeaf(raw);
    if (!coerced.ok) {
      issues.push({ section: sectionName, key, message: coerced.message });
      return;
    }
    values[key] = coerced.value;
  };

  for (const [topKey, topVal] of Object.entries(root)) {
    if (isPlainObject(topVal)) {
      for (const [leafKey, leafVal] of Object.entries(topVal)) handle(leafKey, leafVal, topKey);
    } else {
      handle(topKey, topVal, "(root)");
    }
  }
  return { values, issues };
}

/** Parse `.env.toml` into an identity-keyed value map. Throws `EnvFileError`. */
export function parseEnvToml(text: string): Record<string, string> {
  let root: Record<string, unknown>;
  try {
    root = tomlCodec().parse(text);
  } catch {
    throw new EnvFileError([{ section: "", key: "", message: "invalid TOML syntax" }]);
  }
  if (!isPlainObject(root)) throw new EnvFileError([{ section: "", key: "", message: "invalid TOML root" }]);
  const { values, issues } = collectValues(root);
  if (issues.length > 0) throw new EnvFileError(issues);
  return values;
}

function renderEnvToml(values: Record<string, string>): string {
  const sections = new Map<string, Record<string, string>>();
  for (const name of ENV_SECTION_ORDER) sections.set(name, {});
  sections.set("other", {});
  for (const [k, v] of Object.entries(values)) {
    const target = sections.get(SECTION_BY_KEY.get(k) ?? "other") ?? sections.get("other")!;
    target[k] = v;
  }
  const doc: Record<string, Record<string, string>> = {};
  for (const [name, entries] of sections) {
    if (Object.keys(entries).length > 0) doc[name] = entries;
  }
  return tomlCodec().stringify(doc as unknown as Record<string, unknown>);
}

// ─── dotenv parse/format ─────────────────────────────────────────────────

function unescapeBasicChar(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "'":
      return "'";
    case "0":
      return "\0";
    default:
      return c;
  }
}

function scanBasicString(s: string): { closed: boolean; text: string; after: string } {
  let out = "";
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (escaped) {
      out += unescapeBasicChar(c);
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') return { closed: true, text: out, after: s.slice(i + 1) };
    out += c;
  }
  if (escaped) out += "\\";
  return { closed: false, text: out, after: "" };
}

/**
 * Parse flat dotenv text (legacy `.env`). Quoted values may span lines;
 * unquoted values end at an inline `#` comment. Throws `EnvFileError` on
 * malformed lines (line numbers only — never values).
 */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const issues: EnvFileIssue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? "").trimStart();
    if (line === "" || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) {
      issues.push({ section: "", key: "", message: `malformed dotenv line ${i + 1}` });
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      issues.push({ section: "", key: "", message: `invalid key at dotenv line ${i + 1}` });
      continue;
    }
    let rest = line.slice(eq + 1).trimStart();
    if (rest.startsWith('"')) {
      let body = rest.slice(1);
      let acc = "";
      let closed = false;
      for (;;) {
        const scan = scanBasicString(body);
        if (scan.closed) {
          acc += scan.text;
          closed = true;
          const trailing = scan.after.trim();
          if (trailing !== "" && !trailing.startsWith("#")) {
            issues.push({ section: "", key, message: `trailing content after quoted value at dotenv line ${i + 1}` });
          }
          break;
        }
        acc += scan.text + "\n";
        i++;
        if (i >= lines.length) break;
        body = lines[i] ?? "";
      }
      if (!closed) {
        issues.push({ section: "", key, message: "unterminated quoted value" });
        continue;
      }
      values[key] = acc;
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) {
        issues.push({ section: "", key, message: "unterminated quoted value" });
        continue;
      }
      const trailing = rest.slice(end + 1).trim();
      if (trailing !== "" && !trailing.startsWith("#")) {
        issues.push({ section: "", key, message: `trailing content after quoted value at dotenv line ${i + 1}` });
      }
      values[key] = rest.slice(1, end);
    } else {
      const hash = rest.indexOf("#");
      if (hash >= 0) rest = rest.slice(0, hash);
      values[key] = rest.trimEnd();
    }
  }
  if (issues.length > 0) throw new EnvFileError(issues);
  return values;
}

function formatDotenvValue(v: string): string {
  if (v === "") return "";
  if (/^[A-Za-z0-9_./:@+\-]+$/.test(v)) return v;
  const escaped = v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Render values as flat dotenv text (round-trips through `parseDotenv`). */
export function formatDotenv(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${formatDotenvValue(v)}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Render `export K='v'` lines that are safe for `eval` (single-quoted). */
export function formatShellExports(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// ─── file IO ─────────────────────────────────────────────────────────────

/** Read an env file; `.toml` paths parse as TOML, everything else as dotenv. */
export function readEnvFile(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  return /\.toml(\.|$)/.test(basename(path)) ? parseEnvToml(text) : parseDotenv(text);
}

/**
 * True when `path` exists, false when it is absent. Any other stat failure
 * (EACCES on a parent directory, ELOOP, …) throws — silently treating it as
 * absent would boot with defaults while the operator believes their file was
 * applied.
 */
function isPresent(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new EnvFileError([{ section: "", key: "", message: `cannot stat env file: ${path} (${code ?? "error"})` }]);
  }
}

/** `.env.toml` when present, else legacy `.env`, else null. */
export function resolveEnvFilePath(cwd: string = process.cwd()): string | null {
  const toml = join(cwd, ".env.toml");
  if (isPresent(toml)) return toml;
  const legacy = join(cwd, ".env");
  if (isPresent(legacy)) return legacy;
  return null;
}

/**
 * Read a resolved env file, converting any read/parse failure into an
 * `EnvFileError` that names the path (never values). A present file that cannot
 * be read or parsed must fail the caller — never fall through to defaults.
 */
function readEnvFileChecked(path: string): Record<string, string> {
  try {
    return readEnvFile(path);
  } catch (e) {
    if (e instanceof EnvFileError) {
      throw new EnvFileError([{ section: "", key: "", message: `cannot read env file: ${path}: ${e.message}` }]);
    }
    const code = (e as NodeJS.ErrnoException).code;
    throw new EnvFileError([{ section: "", key: "", message: `cannot read env file: ${path}${code ? ` (${code})` : ""}` }]);
  }
}

export interface ApplyEnvFileOptions {
  cwd?: string;
  path?: string;
  env?: Record<string, string | undefined>;
  strict?: boolean;
}

export interface ApplyEnvFileResult {
  path: string | null;
  applied: string[];
  skipped: string[];
}

/**
 * Populate the target environment from `.env.toml`/`.env`. Real environment
 * values always win — a key already defined is never overwritten. An explicit
 * `path` that does not exist always throws; `strict` additionally throws when
 * no file can be resolved at all.
 */
export function applyEnvFile(opts: ApplyEnvFileOptions = {}): ApplyEnvFileResult {
  const env = opts.env ?? process.env;
  let path: string | null;
  if (opts.path !== undefined) {
    if (!isPresent(opts.path)) {
      throw new EnvFileError([{ section: "", key: "", message: `env file not found: ${opts.path}` }]);
    }
    path = opts.path;
  } else {
    path = resolveEnvFilePath(opts.cwd ?? process.cwd());
    if (path === null) {
      if (opts.strict) throw new EnvFileError([{ section: "", key: "", message: "no .env.toml or .env found" }]);
      return { path: null, applied: [], skipped: [] };
    }
  }
  const values = readEnvFileChecked(path);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined) {
      env[k] = v;
      applied.push(k);
    } else {
      skipped.push(k);
    }
  }
  return { path, applied, skipped };
}

/** Throws when `path` is the tracked example template. Callers that write via
 * a temp file + rename MUST call this with the FINAL destination before
 * creating the temp file — `writeEnvFile` only sees the temp path there. */
export function assertEnvWriteTarget(path: string): void {
  if (basename(path) === ".env.toml.example") {
    throw new EnvFileError([{ section: "", key: "", message: "refusing to write the example template" }]);
  }
}

/** Merge `values` into the file (incoming wins) and write sectioned TOML at 0600. */
export function writeEnvFile(path: string, values: Record<string, string>): void {
  assertEnvWriteTarget(path);
  const existing = existsSync(path) ? readEnvFile(path) : {};
  const merged: Record<string, string> = { ...existing, ...values };
  const invalid = Object.keys(merged).filter((k) => !LEAF_KEY_RE.test(k));
  if (invalid.length > 0) {
    throw new EnvFileError(invalid.map((key) => ({ section: "", key, message: "invalid key name (expected ^[A-Z][A-Z0-9_]*$)" })));
  }
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderEnvToml(merged), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems without POSIX modes
  }
}

/** Redacted key summary (`KEY (N chars)`) — safe to print, never values. */
export function describeKeys(values: Record<string, string>): string[] {
  return Object.entries(values).map(([k, v]) => `${k} (${v.length} chars)`);
}

// ─── fallback TOML codec (schema subset; Bun.TOML preferred) ─────────────

function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inDouble) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

function tomlError(): Error {
  return new Error("TOML parse error");
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inDouble) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') inDouble = true;
    else if (c === "'") inSingle = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function parseTomlScalar(s: string): unknown {
  if (s === "") throw tomlError();
  if (s[0] === '"') {
    if (!s.endsWith('"') || s.length < 2) throw tomlError();
    return scanBasicString(s.slice(1, -1)).text;
  }
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) throw tomlError();
    return s.slice(1, -1);
  }
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw tomlError();
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner, ",")
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map((p) => parseTomlScalar(p));
  }
  if (s === "true") return true;
  if (s === "false") return false;
  const numeric = /^[+-]?\d[\d_]*$/;
  const float = /^[+-]?(\d[\d_]*)?\.\d[\d_]*([eE][+-]?\d+)?$/;
  const exp = /^[+-]?\d[\d_]*[eE][+-]?\d+$/;
  if (numeric.test(s) || float.test(s) || exp.test(s)) {
    const n = Number(s.replace(/_/g, ""));
    if (!Number.isFinite(n)) throw tomlError();
    return n;
  }
  throw tomlError();
}

export function parseTomlFallback(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i] ?? "").trim();
    if (line === "") continue;
    if (line.startsWith("[[")) throw tomlError();
    if (line.startsWith("[")) {
      const m = /^\[([^[\]]+)\]$/.exec(line);
      if (!m) throw tomlError();
      const name = m[1]!.trim();
      if (name === "" || name.includes(".") || /["']/.test(name)) throw tomlError();
      const existing = root[name];
      if (existing === undefined) {
        const table: Record<string, unknown> = {};
        root[name] = table;
        current = table;
      } else if (isPlainObject(existing)) {
        current = existing;
      } else {
        throw tomlError();
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) throw tomlError();
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw tomlError();
    const rest = line.slice(eq + 1).trim();
    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      const quote = rest.slice(0, 3);
      let body = rest.slice(3);
      if (!body.includes(quote)) {
        const parts = [body];
        i++;
        while (i < lines.length && !(lines[i] ?? "").includes(quote)) {
          parts.push(lines[i] ?? "");
          i++;
        }
        if (i >= lines.length) throw tomlError();
        const closing = lines[i] ?? "";
        parts.push(closing.slice(0, closing.indexOf(quote)));
        body = parts.join("\n");
      } else {
        body = body.slice(0, body.indexOf(quote));
      }
      current[key] = quote === '"""' ? scanBasicString(body).text : body;
      continue;
    }
    current[key] = parseTomlScalar(rest);
  }
  return root;
}

function escapeTomlString(v: string): string {
  let out = "";
  for (const ch of v) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " ") out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

export function stringifyTomlFallback(doc: Record<string, Record<string, string>>): string {
  const lines: string[] = [];
  for (const [name, entries] of Object.entries(doc)) {
    const keys = Object.keys(entries ?? {});
    if (keys.length === 0) continue;
    lines.push(`[${name}]`);
    for (const k of keys) lines.push(`${k} = ${escapeTomlString(entries[k] ?? "")}`);
    lines.push("");
  }
  return lines.length === 0 ? "" : `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

// ─── CLI (`bun server/env-file.ts`) ──────────────────────────────────────

type CliAction = "export-shell" | "emit-dotenv" | "check" | "print-keys" | "migrate";

interface CliOptions {
  action?: CliAction;
  path?: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
  error?: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--path": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          return { ...opts, error: "--path requires a value" };
        }
        opts.path = next;
        i++;
        break;
      }
      case "--export-shell":
        opts.action = "export-shell";
        break;
      case "--emit-dotenv":
        opts.action = "emit-dotenv";
        break;
      case "--check":
        opts.action = "check";
        break;
      case "--print-keys":
        opts.action = "print-keys";
        break;
      case "--migrate":
        opts.action = "migrate";
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

function usage(): string {
  return [
    "usage: bun server/env-file.ts [--path FILE] <command>",
    "  --export-shell   print `export K='v'` lines safe for eval",
    "  --emit-dotenv    print flat dotenv text",
    "  --check          print key names + value lengths (never values)",
    "  --print-keys     print key names only",
    "  --migrate        migrate legacy .env -> .env.toml [--dry-run] [--force]",
    "                   --force backs up an existing .env.toml before merging",
    "",
  ].join("\n");
}

interface CarriedMismatch {
  key: string;
  expectedLen: number;
  actualLen: number;
}

function compareCarried(expected: Record<string, string>, actual: Record<string, string>): CarriedMismatch[] {
  const out: CarriedMismatch[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, k)) out.push({ key: k, expectedLen: v.length, actualLen: -1 });
    else if (actual[k] !== v) out.push({ key: k, expectedLen: v.length, actualLen: (actual[k] ?? "").length });
  }
  return out;
}

function reportMismatch(mismatches: CarriedMismatch[], where: string): void {
  process.stderr.write(`migrate: ${where} mismatch (redacted):\n`);
  for (const m of mismatches) {
    process.stderr.write(`  ${m.key}: expected len=${m.expectedLen}, got ${m.actualLen < 0 ? "missing" : `len=${m.actualLen}`}\n`);
  }
}

function runMigrate(opts: CliOptions): number {
  const legacyPath = opts.path ?? ".env";
  const target = join(dirname(legacyPath), ".env.toml");
  const legacyDest = join(dirname(legacyPath), ".env.legacy");
  let legacyText: string;
  try {
    legacyText = readFileSync(legacyPath, "utf8");
  } catch {
    process.stderr.write(`migrate: ${legacyPath} not found\n`);
    return 1;
  }
  const legacy = parseDotenv(legacyText);
  const carried: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(legacy)) {
    if (DEAD_KEYS.includes(k)) dropped.push(k);
    else carried[k] = v;
  }
  process.stdout.write(`migrate: ${legacyPath} -> ${target}\n`);
  process.stdout.write(`migrate: ${Object.keys(legacy).length} key(s), dropped ${dropped.length} (${dropped.join(", ") || "none"})\n`);
  const carriedKeys = Object.keys(carried);
  if (carriedKeys.length === 0) {
    process.stderr.write("migrate: no live keys to migrate\n");
    return 1;
  }

  // Keys the loader cannot represent (lowercase, leading `_`, …) would make
  // the written file unreadable — reject up front, keys only, never values.
  const unrepresentable = carriedKeys.filter((k) => !LEAF_KEY_RE.test(k));
  if (unrepresentable.length > 0) {
    process.stderr.write(`migrate: ${unrepresentable.length} key(s) are not valid env names: ${unrepresentable.join(", ")}\n`);
    process.stderr.write("migrate: rename or drop them, then re-run — .env left untouched\n");
    return 1;
  }

  // In-memory verification: TOML round-trip + dotenv round-trip, byte-exact.
  const rendered = renderEnvToml(carried);
  const tomlBack = parseEnvToml(rendered);
  const tomlMismatch = compareCarried(carried, tomlBack);
  const dotenvMismatch = compareCarried(carried, parseDotenv(formatDotenv(carried)));
  if (tomlMismatch.length > 0 || dotenvMismatch.length > 0) {
    if (tomlMismatch.length > 0) reportMismatch(tomlMismatch, "TOML round-trip");
    if (dotenvMismatch.length > 0) reportMismatch(dotenvMismatch, "dotenv round-trip");
    process.stderr.write("migrate: verification failed — .env left untouched\n");
    return 1;
  }

  const targetExists = existsSync(target);
  if (targetExists && !opts.force) {
    process.stderr.write(`migrate: ${target} already exists — refusing to overwrite (use --force; the old file is backed up first)\n`);
    return 1;
  }

  if (opts.dryRun) {
    const backupNote = targetExists ? ` (old ${target} backed up to ${target}.bak)` : "";
    process.stdout.write(`migrate: dry-run OK — would write ${target} (0600) and rename ${legacyPath} -> ${legacyDest} (0600)${backupNote}\n`);
    return 0;
  }

  if (existsSync(legacyDest)) {
    process.stderr.write(`migrate: ${legacyDest} already exists — refusing to overwrite\n`);
    return 1;
  }

  // --force keeps the prior .env.toml recoverable so the rollback line stays
  // truthful (without the copy, `rm .env.toml` would lose pre-migration keys).
  let targetBackup: string | null = null;
  if (targetExists) {
    targetBackup = `${target}.bak`;
    if (existsSync(targetBackup)) {
      process.stderr.write(`migrate: ${targetBackup} already exists — move it aside before using --force\n`);
      return 1;
    }
    copyFileSync(target, targetBackup);
    try {
      chmodSync(targetBackup, 0o600);
    } catch {
      // best-effort on filesystems without POSIX modes
    }
  }

  const backupNote = targetBackup ? ` (old .env.toml kept at ${targetBackup})` : "";

  writeEnvFile(target, carried);
  let written: Record<string, string>;
  try {
    written = readEnvFile(target);
  } catch (e) {
    try {
      rmSync(target);
    } catch {
      // best-effort cleanup
    }
    process.stderr.write(`migrate: post-write re-read failed (${e instanceof Error ? e.message : String(e)})\n`);
    process.stderr.write(`migrate: new .env.toml deleted, .env kept${backupNote}\n`);
    return 1;
  }
  const fsMismatch = compareCarried(carried, written);
  if (fsMismatch.length > 0) {
    try {
      rmSync(target);
    } catch {
      // best-effort cleanup
    }
    reportMismatch(fsMismatch, "on-disk re-parse");
    process.stderr.write(`migrate: verification failed — new .env.toml deleted, .env kept${backupNote}\n`);
    return 1;
  }
  try {
    renameSync(legacyPath, legacyDest);
    chmodSync(legacyDest, 0o600);
  } catch {
    process.stderr.write(`migrate: wrote ${target} but could not move ${legacyPath} -> ${legacyDest}${backupNote}\n`);
    return 1;
  }
  process.stdout.write(`migrate: wrote ${target} (0600), moved ${legacyPath} -> ${legacyDest} (0600)\n`);
  if (targetBackup) {
    process.stdout.write(`rollback: rm ${target} && mv ${targetBackup} ${target} && mv ${legacyDest} ${legacyPath}\n`);
  } else {
    process.stdout.write(`rollback: rm ${target} && mv ${legacyDest} ${legacyPath}\n`);
  }
  return 0;
}

function runCli(argv: string[]): number {
  const opts = parseCliArgs(argv);
  if (opts.error) {
    process.stderr.write(`env-file: ${opts.error}\n`);
    process.stdout.write(usage());
    return 2;
  }
  if (opts.help || opts.action === undefined) {
    process.stdout.write(usage());
    return opts.help ? 0 : 2;
  }
  try {
    if (opts.action === "migrate") return runMigrate(opts);
    const path = opts.path ?? resolveEnvFilePath();
    if (path === null) {
      process.stderr.write("env-file: no .env.toml or .env found\n");
      return 1;
    }
    const values = readEnvFile(path);
    switch (opts.action) {
      case "export-shell":
        process.stdout.write(formatShellExports(values));
        return 0;
      case "emit-dotenv":
        process.stdout.write(formatDotenv(values));
        return 0;
      case "print-keys":
        process.stdout.write(Object.keys(values).map((k) => `${k}\n`).join(""));
        return 0;
      case "check":
        process.stdout.write(`env-file: ${path}\n`);
        for (const line of describeKeys(values)) process.stdout.write(`  ${line}\n`);
        process.stdout.write(`env-file: ${Object.keys(values).length} key(s)\n`);
        return 0;
    }
  } catch (e) {
    process.stderr.write(`env-file: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
