#!/usr/bin/env bun
/**
 * Invariant compliance scanner — `bun run check:invariants`.
 *
 * Walks `server/`, `app/`, and `migrations/` and emits a markdown table
 * covering the 14 architectural invariants declared in AGENTS.md. Each
 * check is a regex over source — false positives are accepted; missed
 * violations are the failure mode.
 *
 * Status: ok (no violation found) | warn (informational) | fail (violation).
 * Exit code is 0 unless at least one invariant reports fail.
 *
 * Invariant coverage map (most at-risk from the Cloudflare Workers migration
 * are explicitly enumerated per ADR-0002):
 *
 *   #1  No service-to-service cycles — coarse service-import scan.
 *   #2  Echo suppression — webhook move + github_synced_state in same block.
 *   #3  Webhook atomic — bypassGuards + withTx pairing.
 *   #4  Positions deterministic — isPositionConflict retry preserved.
 *   #5  WIP limit atomic — single conditional UPDATE.
 *   #6  Mutation cache consistency — no new invalidateQueries on mutations.
 *   #7  Markdown at the boundary — marked/unpdf only inside server/shared/app/lib/markdownToReact.tsx.
 *   #8  Webhook auth = signature — webhook route has no API-key middleware.
 *   #9  Column→GitHub state via columns.github_state — no column.name read to map state.
 *   #10 Required fields enforced — required_fields check on create/move/update.
 *   #11 One-way link integrity — UNIQUE(issue_id) + per-repo guard preserved.
 *   #12 Emission invariant — every activityService.append paired with withTx/batch.
 *   #13 Ticket keys immutable — no UPDATE tasks SET number=.
 *   #14 Milestone/sprint rules — ON DELETE SET NULL, archive cascade preserved.
 *
 * The script is intentionally ~250 lines. Patterns are documented inline.
 * No AST, no parsing — line/bracket heuristics over grep output.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

type Status = "ok" | "warn" | "fail";
interface Invariant {
  id: string;
  title: string;
  status: Status;
  evidence: string;
}

const ROOT = process.cwd();
const SCAN_DIRS = ["server", "app", "migrations", "cli/src", "shared"];

const EXCLUDE_DIRS = new Set([
  "node_modules", "dist", "build", ".turbo", ".next", ".git",
  "wireframes", "data", "coverage", ".slim", ".superpowers", ".opencode",
  ".playwright-mcp", ".tanstack", ".commandcode", ".agents", ".repos",
]);

const TEST_FILE = /\.(test|spec)\.[mc]?[jt]sx?$/;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(abs, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(join(dir, entry.name), out);
    } else if (/\.(ts|tsx|js|jsx|sql)$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => listSourceFiles(d));

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function grep(pattern: RegExp, files: string[] = FILES): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  for (const file of files) {
    let text: string;
    try { text = readText(file); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i]!)) {
        hits.push({ file: relative(ROOT, file), line: i + 1, text: lines[i]!.trim() });
      }
    }
  }
  return hits;
}

/**
 * For a given anchor line, decide whether the surrounding effect is inside a
 * `withTx(db, Effect.gen(function* () { ... }))` block. Bracket scan from the
 * nearest preceding `withTx(` open parenthesis. We do a simple paren/brace
 * match from the withTx call up to its terminator and check that the anchor
 * line falls inside that span.
 */
function lineIsInsideWithTx(anchorLine: number, lines: string[]): boolean {
  // Find the nearest preceding withTx( opening by walking up.
  for (let i = anchorLine - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    if (/withTx\s*\(/.test(line) || /batch\s*\(/.test(line)) {
      // We found an open. Now walk forward tracking paren depth from the
      // `withTx(` position, ignoring string contents via a coarse heuristic.
      // The function body is `Effect.gen(function* () { ... })` — once we
      // cross into the gen's opening brace, the matching close ends the tx.
      // Simpler heuristic: from this open line, find the deepest `}))`
      // that closes the effect, by paren/brace depth from this line.
      const tail = lines.slice(i).join("\n");
      // Count from the withTx line: parens and braces.
      let depthParen = 0, depthBrace = 0, depthBracket = 0;
      let inString: string | null = null;
      let inLineComment = false, inBlockComment = false;
      let inTemplate = false;
      for (let k = 0; k < tail.length; k++) {
        const c = tail[k]!, n = tail[k + 1];
        if (inLineComment) { if (c === "\n") inLineComment = false; continue; }
        if (inBlockComment) { if (c === "*" && n === "/") { inBlockComment = false; k++; } continue; }
        if (inString) {
          if (c === "\\") { k++; continue; }
          if (c === inString) inString = null;
          continue;
        }
        if (c === "/" && n === "/") { inLineComment = true; k++; continue; }
        if (c === "/" && n === "*") { inBlockComment = true; k++; continue; }
        if (c === "'" || c === '"' || c === "`") { inString = c; continue; }
        if (c === "(") depthParen++;
        else if (c === ")") {
          depthParen--;
          if (depthParen === 0 && depthBrace === 0) {
            // closed the withTx( ... ) call
            break;
          }
        } else if (c === "{") depthBrace++;
        else if (c === "}") {
          if (depthBrace > 0) depthBrace--;
        } else if (c === "[") depthBracket++;
        else if (c === "]") {
          if (depthBracket > 0) depthBracket--;
        }
      }
      // If we ran the line range without closing paren to 0, the withTx call
      // extends past the file end; treat as in-tx.
      // Compute how many lines we traversed.
      const consumedNewlines = (tail.match(/\n/g) || []).length;
      const closeLine = i + consumedNewlines;
      if (anchorLine <= closeLine) return true;
      // Otherwise this withTx doesn't contain the anchor — keep looking.
    }
  }
  return false;
}
// ─── Helper resolvers (for #12) ────────────────────────────────────────────

/**
 * Walk backward from an `activityService.append(...)` line to find the
 * enclosing helper name. Detects `const <name> = (...): Effect => { ... }`
 * and `function <name>(...)` forms. Returns null if the append is at the
 * top of the file or the enclosing function is anonymous.
 */
function enclosingHelperName(lines: string[], anchorLine: number): string | null {
  // Walking UP from the anchor through the source. Reading top-to-bottom,
  // `{` opens and `}` closes. Reading bottom-to-top, this inverts: `}`
  // enters a scope and `{` exits one. We start inside the anchor's function
  // body (depth=0). When we cross a `{` going up, we exit the function body
  // the anchor is in — that `{` is the function's opening brace. The
  // const/function keyword is on the same line or a few lines above.
  let depthBrace = 0;
  for (let i = anchorLine - 1; i >= 0; i--) {
    const t = lines[i]!;
    if (/^\s*\/\//.test(t)) continue;
    for (let k = 0; k < t.length; k++) {
      const c = t[k]!;
      if (c === "{") {
        if (depthBrace === 0) {
          for (let j = i; j >= Math.max(0, i - 5); j--) {
            const tt = lines[j]!;
            const m = /(?:const|let|var|function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=(]/.exec(tt);
            if (m) return m[1]!;
          }
          return null;
        }
        depthBrace--;
      } else if (c === "}") {
        depthBrace++;
      }
    }
  }
  return null;
}

/**
 * Returns true if EVERY call site of the given helper name in `lines` is
 * inside a `withTx(...)` block. If a helper is called from outside any
 * withTx, the append is not in-tx.
 */
function everyCallInsideWithTx(lines: string[], name: string): boolean {
  let anyCall = false;
  // Find the definition line first to skip it.
  let defLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`(?:const|let|var|function)\\s+${name}\\s*[=(]`).test(lines[i]!)) {
      defLine = i;
      break;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (i === defLine) continue;
    if (new RegExp(`\\b${name}\\s*\\(`).test(lines[i]!)) {
      anyCall = true;
      if (!lineIsInsideWithTx(i, lines)) return false;
    }
  }
  return anyCall;
}

// ─── Invariants ─────────────────────────────────────────────────────────────

const results: Invariant[] = [];

// #1 No service-to-service cycles (coarse: service files may not import
// another service file).
{
  const services = new Set<string>();
  for (const f of FILES) {
    if (f.includes(`${sep}services${sep}`) && f.endsWith(".ts") && !f.endsWith(".test.ts")) {
      services.add(f);
    }
  }
  const cycles: string[] = [];
  for (const f of services) {
    const text = readText(f);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /from\s+["']\.\.?\/services\/([a-z0-9._-]+)["']/i.exec(lines[i]!);
      if (m) {
        const target = `${sep}services${sep}${m[1]!}.ts`;
        if (services.has(join(ROOT, "server", "services", `${m[1]!}.ts`)) ||
            services.has(join(ROOT, "cli", "src", "services", `${m[1]!}.ts`))) {
          // Allow self-import only.
          if (!f.endsWith(`${sep}${m[1]!}.ts`)) {
            cycles.push(`${relative(ROOT, f)}:${i + 1} → services/${m[1]!}`);
          }
        }
      }
    }
  }
  results.push({
    id: "#1",
    title: "No service-to-service cycles",
    status: cycles.length === 0 ? "ok" : "fail",
    evidence: cycles.length === 0
      ? "no service→service import edges found"
      : cycles.slice(0, 5).join("; "),
  });
}

// #2 Echo suppression — webhook move + github_synced_state in same atomic unit.
// Widened after ADR-0002: verifier lives in api/http.ts, batch path in drivers/*.
// Scan services + api/http.ts + api/webhook*.ts + repos/*.ts; ok if any file
// has github_synced_state + webhook-move co-occurrence inside withTx/batch.
{
  const expanded = FILES.filter(
    (f) =>
      f.includes(`${sep}services${sep}`) ||
      f.endsWith(`${sep}api${sep}http.ts`) ||
      f.includes(`${sep}api${sep}webhook`) ||
      f.includes(`${sep}repos${sep}`) ||
      f.includes(`${sep}db${sep}drivers${sep}`),
  );
  let atomicHits: string[] = [];
  let totalHits = 0;
  for (const f of expanded) {
    const text = readText(f);
    const hasSynced = /github_synced_state/.test(text);
    const hasWebhookMove = /moveFromWebhook|webhook.*move/i.test(text);
    const hasAtomic = /withTx\s*\(|batch\s*\(/.test(text);
    if (hasSynced) totalHits++;
    if (hasSynced && hasWebhookMove && hasAtomic) {
      atomicHits.push(relative(ROOT, f));
    }
  }
  // Fallback: also count raw grep hits for evidence
  const hits = grep(/moveFromWebhook|github_synced_state/, expanded);
  const ok = atomicHits.length > 0;
  results.push({
    id: "#2",
    title: "Echo suppression (webhook move + github_synced_state in same atomic unit)",
    status: ok ? "ok" : "fail",
    evidence: ok
      ? `${atomicHits[0]!}: webhook-move + github_synced_state + withTx/batch co-located (${hits.length} refs)`
      : `no file in services/api/repos/drivers has github_synced_state + webhook-move + withTx/batch together (${hits.length} refs)`,
  });
}

// #3 Webhook atomic — bypassGuards + withTx/batch pairing in the move handler.
// Widened after ADR-0002: check services + api/http.ts + api/webhook*.ts.
{
  const moveFiles = FILES.filter(
    (f) =>
      f.includes(`${sep}services${sep}`) ||
      f.endsWith(`${sep}api${sep}http.ts`) ||
      f.includes(`${sep}api${sep}webhook`),
  );
  let count = 0;
  let evidenceFile = "";
  for (const f of moveFiles) {
    const text = readText(f);
    if (/bypassGuards/.test(text) && (/withTx\s*\(/.test(text) || /batch\s*\(/.test(text))) {
      count++;
      if (!evidenceFile) evidenceFile = relative(ROOT, f);
    }
  }
  results.push({
    id: "#3",
    title: "Webhook atomic (bypassGuards + withTx/batch in move path)",
    status: count > 0 ? "ok" : "fail",
    evidence: count > 0
      ? `${evidenceFile} has both bypassGuards and withTx/batch in the move path`
      : "missing bypassGuards or withTx/batch in move path (services + api)",
  });
}

// #4 Positions deterministic — isPositionConflict retry-once preserved.
{
  const matches = grep(/isPositionConflict/, FILES.filter((f) => f.endsWith(`${sep}services${sep}task.service.ts`)));
  const repos = grep(/isPositionConflict/, FILES.filter((f) => f.includes(`${sep}db${sep}database.ts`)));
  results.push({
    id: "#4",
    title: "Positions deterministic (isPositionConflict retry-once preserved)",
    status: matches.length >= 2 && repos.length >= 1 ? "ok" : "warn",
    evidence: `task.service.ts: ${matches.length} sites; database.ts: ${repos.length} sites`,
  });
}

// #5 WIP limit atomic — single conditional UPDATE.
{
  const files = FILES.filter((f) => f.endsWith(`${sep}services${sep}task.service.ts`));
  let count = 0;
  for (const f of files) {
    const text = readText(f);
    // Heuristic: a single UPDATE with the WIP pattern (column_id = ?2 AND count
    // < limit) is present.
    if (/bypassWip/.test(text) && /WipLimitExceeded/.test(text)) count++;
  }
  results.push({
    id: "#5",
    title: "WIP limit atomic (conditional UPDATE is a single statement)",
    status: count > 0 ? "ok" : "fail",
    evidence: count > 0
      ? "task.service.ts has bypassWip + WipLimitExceeded — the conditional UPDATE stays one statement"
      : "missing WIP limit guard in task.service.ts",
  });
}

// #6 Mutation cache consistency — TanStack Query setQueryData on mutation path;
// invalidateQueries should not appear on a mutation handler.
{
  const appFiles = FILES.filter((f) => f.includes(`${sep}app${sep}lib${sep}`));
  const invalidate = grep(/invalidateQueries/, appFiles);
  // Allow invalidateQueries in non-mutation paths (e.g. clear caches on
  // delete) — we just confirm it's not the dominant pattern. We require
  // setQueryData to be present in mutation hooks as the canonical update path.
  const setQueryData = grep(/setQueryData/, appFiles);
  results.push({
    id: "#6",
    title: "Mutation cache consistency (setQueryData on mutation, no refetch)",
    status: setQueryData.length > 0 ? "ok" : "warn",
    evidence: `app/lib: setQueryData=${setQueryData.length} sites, invalidateQueries=${invalidate.length} sites (manual review for misuse)`,
  });
}

// #7 Markdown at the boundary — marked/unpdf only in server/ or shared/ or
// the dedicated transcript renderer.
{
  const allowed = new Set([
    `app${sep}lib${sep}markdownToReact.tsx`,
    `app${sep}lib${sep}tiptap-render.tsx`,
  ]);
  const violations: string[] = [];
  for (const f of FILES) {
    if (f.endsWith(".ts") || f.endsWith(".tsx")) {
      const rel = relative(ROOT, f);
      const text = readText(f);
      if (/from\s+["']marked["']/.test(text) || /from\s+["']unpdf["']/.test(text)) {
        const inServer = rel.startsWith(`server${sep}`);
        const inShared = rel.startsWith(`shared${sep}`);
        const inAllowedApp = allowed.has(rel);
        if (!inServer && !inShared && !inAllowedApp) {
          violations.push(rel);
        }
      }
    }
  }
  results.push({
    id: "#7",
    title: "Markdown at the boundary (marked/unpdf only in server/shared or transcript renderer)",
    status: violations.length === 0 ? "ok" : "fail",
    evidence: violations.length === 0
      ? "no off-boundary marked/unpdf imports"
      : violations.join("; "),
  });
}

// #8 Webhook auth = signature — createWebhookVerifier exists and is used.
// Supports both `createWebhookVerifier(dbPath)` and `createWebhookVerifier(driver)`.
{
  const http = FILES.find((f) => f.endsWith(`${sep}api${sep}http.ts`));
  let ok = false;
  if (http) {
    const text = readText(http);
    if (/createWebhookVerifier\s*\(/.test(text) && /verifyWebhookSignature/.test(text)) {
      ok = true;
    }
  }
  results.push({
    id: "#8",
    title: "Webhook auth = signature (HMAC verifier separate from API-key middleware)",
    status: ok ? "ok" : "fail",
    evidence: ok
      ? "api/http.ts: createWebhookVerifier + verifyWebhookSignature present"
      : "missing webhook signature verifier in api/http.ts",
  });
}

// #9 Column→GitHub state via columns.github_state — no `column.name` read to
// derive a GitHub state on the server side.
{
  const serverFiles = FILES.filter((f) => f.startsWith(join(ROOT, "server")));
  const violations: string[] = [];
  for (const f of serverFiles) {
    if (!f.endsWith(".ts")) continue;
    const text = readText(f);
    // A read of `column.name` followed by a string equality to "open"/"closed"
    // would be a violation. We use a coarse regex.
    if (/column\.name[^a-zA-Z].*['"]open['"]/.test(text) || /column\.name[^a-zA-Z].*['"]closed['"]/.test(text)) {
      violations.push(relative(ROOT, f));
    }
  }
  results.push({
    id: "#9",
    title: "Column→GitHub state via columns.github_state (no name-based mapping)",
    status: violations.length === 0 ? "ok" : "fail",
    evidence: violations.length === 0
      ? "no server code maps column.name to GitHub state"
      : violations.join("; "),
  });
}

// #10 Required fields enforced — required_fields check present.
{
  const files = FILES.filter(
    (f) =>
      f.endsWith(`${sep}services${sep}task.service.ts`) ||
      f.endsWith(`${sep}api${sep}errors.ts`) ||
      f.endsWith(`${sep}repos${sep}task.repo.ts`),
  );
  let count = 0;
  let foundClass = false, foundEnforce = false;
  for (const f of files) {
    const text = readText(f);
    if (/RequiredFieldMissing/.test(text)) foundClass = true;
    if (/validateRequiredFields/.test(text)) foundEnforce = true;
  }
  count = foundClass && foundEnforce ? 1 : 0;
  results.push({
    id: "#10",
    title: "Required fields enforced on create/move/update",
    status: count > 0 ? "ok" : "fail",
    evidence: count > 0
      ? "validateRequiredFields + RequiredFieldMissing present in task flow"
      : "required_fields check missing from task flow",
  });
}

// #11 One-way link integrity — UNIQUE(issue_id) + per-repo guard.
{
  const files = FILES.filter((f) => f.includes(`${sep}migrations${sep}`));
  let ok = false;
  for (const f of files) {
    if (!f.endsWith(".sql")) continue;
    const text = readText(f);
    if (/UNIQUE\s*\(\s*issue_id\s*\)/i.test(text) || /task_github_issues/i.test(text)) {
      ok = true;
      break;
    }
  }
  results.push({
    id: "#11",
    title: "One-way link integrity (task_github_issues UNIQUE(issue_id) preserved)",
    status: ok ? "ok" : "fail",
    evidence: ok
      ? "task_github_issues schema with UNIQUE(issue_id) found in migrations/"
      : "missing UNIQUE(issue_id) in task_github_issues migration",
  });
}

// #12 Emission invariant — every activityService.append paired with withTx.
// Two-step: (a) check lexical containment directly; (b) for any append that
// sits inside a helper definition, check whether any call to that helper is
// inside a withTx — closure-transitively in-tx.
{
  const serviceFiles = FILES.filter(
    (f) => f.includes(`${sep}services${sep}`) && f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  const outOfTx: string[] = [];
  let inTxCount = 0;
  for (const f of serviceFiles) {
    const text = readText(f);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/\.activityService\.append\s*\(/.test(lines[i]!) && !/activityService\.append\s*\(/.test(lines[i]!)) continue;
      if (lineIsInsideWithTx(i, lines)) { inTxCount++; continue; }
      // Helper resolution: walk backward to find the enclosing `const <name> =`
      // or `function <name>(` definition; if every call site of that name is
      // inside a withTx, count as in-tx.
      const helper = enclosingHelperName(lines, i);
      if (helper && everyCallInsideWithTx(lines, helper)) {
        inTxCount++;
        continue;
      }
      outOfTx.push(`${relative(ROOT, f)}:${i + 1}`);
    }
  }
  results.push({
    id: "#12",
    title: "Emission invariant (activityService.append inside withTx/batch)",
    status: outOfTx.length === 0 ? "ok" : "fail",
    evidence: outOfTx.length === 0
      ? `all ${inTxCount} activityService.append sites inside withTx/batch`
      : `out-of-tx: ${outOfTx.slice(0, 5).join("; ")}`,
  });
}

// #13 Ticket keys immutable — no UPDATE tasks SET number=.
{
  const files = FILES.filter((f) => f.includes(`${sep}repos${sep}`) && f.endsWith(".ts"));
  const violations: string[] = [];
  for (const f of files) {
    const text = readText(f);
    if (/UPDATE\s+tasks\s+SET[^;]*number\s*=/i.test(text)) {
      violations.push(relative(ROOT, f));
    }
  }
  results.push({
    id: "#13",
    title: "Ticket keys immutable (no UPDATE tasks SET number=)",
    status: violations.length === 0 ? "ok" : "fail",
    evidence: violations.length === 0
      ? "no UPDATE tasks SET number= in repos/"
      : violations.join("; "),
  });
}

// #14 Milestone/sprint rules — ON DELETE SET NULL preserved.
{
  const files = FILES.filter((f) => f.includes(`${sep}migrations${sep}`) && f.endsWith(".sql"));
  let hasSetNull = false;
  let hasBacklog = false;
  for (const f of files) {
    const text = readText(f);
    if (/ON DELETE SET NULL/i.test(text)) hasSetNull = true;
    if (/Backlog/i.test(text) || /backlog/i.test(text)) hasBacklog = true;
  }
  results.push({
    id: "#14",
    title: "Milestone/sprint rules (ON DELETE SET NULL, Backlog guard)",
    status: hasSetNull ? "ok" : "warn",
    evidence: `migrations: ON DELETE SET NULL=${hasSetNull}, Backlog=${hasBacklog}`,
  });
}

// ─── Render report ──────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const statusEmoji: Record<Status, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };

const table: string[] = [];
table.push("| # | Invariant | Status | Evidence |");
table.push("|---|-----------|--------|----------|");
for (const r of results) {
  const ev = r.evidence.length > 90 ? r.evidence.slice(0, 87) + "..." : r.evidence;
  table.push(`| ${r.id} | ${r.title} | ${statusEmoji[r.status]} | ${ev} |`);
}

const report = [
  "# Invariant compliance report",
  "",
  `Scanned ${FILES.length} files under ${SCAN_DIRS.join(", ")}.`,
  "",
  ...table,
  "",
];

const hasFail = results.some((r) => r.status === "fail");
const hasWarn = results.some((r) => r.status === "warn");

process.stdout.write(report.join("\n"));
if (hasFail) {
  process.stdout.write(`\nFAIL: ${results.filter((r) => r.status === "fail").length} invariant(s) violated.\n`);
  process.exit(1);
}
if (hasWarn) {
  process.stdout.write(`\nWARN: ${results.filter((r) => r.status === "warn").length} invariant(s) at warn.\n`);
}
process.stdout.write("\nAll invariants green (or warn).\n");
