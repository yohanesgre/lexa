/**
 * Test-hygiene guard rail — `bun run check:test-hygiene` (wired into scripts/verify-gate.sh).
 *
 * Rule, budget and invariant map: docs/TESTING.md.
 *
 * Enforces the 2026-10-11 trim's rule: a test exists only if it protects a criterion, lives at the tier
 * where the effect lives, and does not restate an effect already covered elsewhere.
 *
 *   FAIL — snapshot assertions anywhere (a golden that tracks the code instead of a criterion).
 *   FAIL — a test file whose anti-pattern count exceeds its recorded allowance in
 *          scripts/test-hygiene-allow.json (the ratchet only tightens; shrinking is allowed and reported).
 *   WARN — the suite budget (files / cases / LOC) exceeds the recorded ceiling.
 *
 * To add a new anti-pattern allowance: explain the criterion it protects in the PR body — do not widen
 * the ratchet silently. To raise the budget ceiling: the report owns that decision, with a reason.
 *
 * Exit code: 0 unless at least one FAIL.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["shared", "server", "app", "cli/src"];

const ANTI_PATTERNS: Array<{ id: string; re: RegExp; what: string }> = [
  { id: "class_pin", re: /toHaveClass\(|toHaveStyle\(/g, what: "class/style pin (no criterion; assert the behavior or a semantic marker)" },
  { id: "weak_assert", re: /toBeTruthy\(\)|toBeDefined\(\)/g, what: "bare truthiness (assert the value or the transition)" },
  { id: "mock_echo", re: /toHaveBeenCalledWith\(/g, what: "mock-argument echo (proves forwarding only)" },
  { id: "source_read", re: /readFileSync\(/g, what: "source/artifact read (assert behavior; static checks belong in scripts/check-*) " },
];

const BANNED: Array<{ id: string; re: RegExp; what: string }> = [
  { id: "snapshot", re: /toMatchSnapshot\(|toMatchInlineSnapshot\(/g, what: "snapshot assertion — banned outright" },
];

type Allowance = {
  note: string;
  measuredAt: { files: number; cases: number; loc: number };
  budget: { files: number; cases: number; loc: number };
  files: Record<string, Record<string, number>>;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const allowancePath = join(ROOT, "scripts", "test-hygiene-allow.json");
const allowance: Allowance = JSON.parse(readFileSync(allowancePath, "utf8"));
const BUDGET = allowance.budget;
// A gutted allowlist (no note, no measurement stamp) must not pass silently: the caps are a ratchet
// measured at a known point, and raising one needs the criterion recorded here.
const allowanceProblems = [
  allowance.note.trim() ? "" : "note missing/empty — record what the caps mean and when they were measured",
  allowance.measuredAt.files && allowance.measuredAt.cases && allowance.measuredAt.loc
    ? ""
    : "measuredAt { files, cases, loc } missing — the caps must be tied to a measurement",
].filter(Boolean);

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
let cases = 0;
let loc = 0;
const violations: string[] = [];
const warnings: string[] = [];
const shrunk: string[] = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, "utf8");
  cases += source.split("\n").filter((line) => /^\s*(it|test)(\.(each|only|skip|todo))?\(/.test(line)).length;
  loc += source.split("\n").length;

  for (const banned of BANNED) {
    const n = (source.match(new RegExp(banned.re.source, "g")) ?? []).length;
    if (n > 0) violations.push(`${rel}: ${n}× ${banned.id} — ${banned.what}`);
  }
  const allowed = allowance.files[rel] ?? {};
  for (const pattern of ANTI_PATTERNS) {
    const measured = (source.match(new RegExp(pattern.re.source, "g")) ?? []).length;
    const cap = allowed[pattern.id] ?? 0;
    if (measured > cap) violations.push(`${rel}: ${pattern.id} ${measured} > allowed ${cap} — ${pattern.what}`);
    else if (measured < cap) shrunk.push(`${rel}: ${pattern.id} ${measured} < allowed ${cap} (tighten the allowance)`);
  }
}

for (const problem of allowanceProblems) violations.push(`scripts/test-hygiene-allow.json: ${problem}`);
if (files.length > BUDGET.files) warnings.push(`test files ${files.length} > ${BUDGET.files}`);
if (cases > BUDGET.cases) warnings.push(`test cases ${cases} > ${BUDGET.cases} (it.each rows count separately under vitest)`);
if (loc > BUDGET.loc) warnings.push(`test LOC ${loc} > ${BUDGET.loc}`);

const rows: Array<[string, string, string]> = [];
rows.push([...["suite files", files.length <= BUDGET.files ? "OK" : "WARN", `${files.length} / ${BUDGET.files}`]] as [string, string, string]);
rows.push(["suite cases", cases <= BUDGET.cases ? "OK" : "WARN", `${cases} / ${BUDGET.cases}`]);
rows.push(["suite loc", loc <= BUDGET.loc ? "OK" : "WARN", `${loc} / ${BUDGET.loc}`]);
rows.push(["banned patterns", violations.some((v) => v.includes("snapshot")) ? "FAIL" : "OK", "snapshot assertions"]);
rows.push(["anti-pattern ratchet", violations.length === 0 ? "OK" : "FAIL", `${violations.length} violation(s)`]);

const out = process.stdout;
out.write("\n# Test-hygiene guard rail\n\n");
out.write("| check | status | evidence |\n|---|---|---|\n");
for (const [check, status, evidence] of rows) out.write(`| ${check} | ${status} | ${evidence} |\n`);
if (warnings.length) out.write(`\nWARN (budget — the report owns any growth):\n${warnings.map((w) => `- ${w}`).join("\n")}\n`);
if (violations.length) out.write(`\nFAIL:\n${violations.map((v) => `- ${v}`).join("\n")}\n`);
if (shrunk.length) out.write(`\nTighten these allowances (measured below the recorded cap):\n${shrunk.slice(0, 10).map((s) => `- ${s}`).join("\n")}\n`);
out.write(
  violations.length
    ? `\nFAIL: ${violations.length} hygiene violation(s). Fix the test (name the criterion it protects) or explain the carve-out.\n`
    : "\nNo new test-hygiene violations (budget warnings are advisory).\n",
);
process.exit(violations.length ? 1 : 0);
