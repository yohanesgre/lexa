#!/usr/bin/env bun
// Semantic-hint calibration harness for the seeded dev corpus.
//
// THE QUERY SET IS A SYNTHETIC PROXY, NOT THE OWNER'S PARAPHRASE SET: the owner
// left the query form blank, so these queries were written from the seed
// corpus text before any score was seen. A pass here says the threshold
// separates these queries; it is not the owner metric.
//
// Scoring: a top-5 result counts as a hit when its kind+locator match the
// expected source OR its title equals the expected title. The seed corpus
// repeats some titles under distinct task keys (e.g. three "Fix login page CSS
// alignment" tasks), so key-only scoring would mark a correct intent a miss.
//
// Usage:
//   bun scripts/rag-eval.ts [--db PATH] [--project ID] [--sweep[=0.2,0.3,...]]
//
// Exit code is 0 whenever the evaluation ran; failed rates are printed as FAIL.
// Unusable arguments or an unopenable DB exit 1.

import { Database } from "bun:sqlite";
import { getEnv, resolveDatabasePath } from "../server/env";
import { applyEnvFile } from "../server/env-file";
import { createBunSqliteDriver } from "../server/db/drivers/bun-sqlite";
import type { EmbeddingKind } from "../server/repos/assistant-embeddings.repo";
import {
  SEMANTIC_HINT_MIN_COSINE,
  semanticHint,
  semanticSearch,
  type SemanticHit,
} from "../server/assistant/semantic";

interface ExpectedSource {
  kind: EmbeddingKind;
  /** Task key or wiki slug in the seeded corpus. */
  locator: string;
  /** Exact seeded title; equality is an equivalent hit (duplicate titles). */
  title: string;
}

interface EvalQuery {
  text: string;
  /** Absent = deliberately off-topic negative probe. */
  expected?: ExpectedSource;
}

// 15 paraphrases written from the corpus source text, then 5 off-topic
// negatives that must not clear the hint threshold.
const QUERIES: readonly EvalQuery[] = [
  {
    text: "Let people pick and crop a picture for their account",
    expected: { kind: "task", locator: "P1-14", title: "Add user profile photo upload" },
  },
  {
    text: "The sign-in form doesn't line up correctly on phones",
    expected: { kind: "task", locator: "P1-18", title: "Fix login page CSS alignment" },
  },
  {
    text: "Write a reference for the second-generation HTTP interface covering request examples and failure responses",
    expected: { kind: "task", locator: "P1-15", title: "Write API documentation for v2 endpoints" },
  },
  {
    text: "Measure page load speed against Core Web Vitals budgets",
    expected: { kind: "task", locator: "P1-16", title: "Performance audit for dashboard" },
  },
  {
    text: "Create a pre-production copy of the production cloud setup",
    expected: { kind: "task", locator: "P1-17", title: "Set up staging environment on AWS" },
  },
  {
    text: "A guide for engineers joining the team for the first time",
    expected: { kind: "task", locator: "P1-19", title: "Write onboarding docs for new contributors" },
  },
  {
    text: "Which socket transport should power instant alerts, judged on speed, download weight and runtime support?",
    expected: {
      kind: "task",
      locator: "P1-20",
      title: "Research WebSocket libraries for real-time notifications",
    },
  },
  {
    text: "Auto-deploy merged changes to a shared test server with failure alerts",
    expected: { kind: "task", locator: "P1-21", title: "Set up CI/CD pipeline for staging environment" },
  },
  {
    text: "Relocate the files behind user images to a bucket with a one-time copy job",
    expected: { kind: "task", locator: "P1-22", title: "Migrate user avatars to S3 storage" },
  },
  {
    text: "Apply the security fix for the flagged third-party package and review the rest of the manifest",
    expected: { kind: "task", locator: "P1-23", title: "Update dependency versions (security patch)" },
  },
  {
    text: "Prevent a single caller from exhausting the API for everyone",
    expected: { kind: "task", locator: "P1-53", title: "[TEST] Add rate limiting to public API" },
  },
  {
    text: "Stop a flaky end-to-end checkout run caused by cross-suite state and the real clock",
    expected: { kind: "task", locator: "P1-54", title: "🧪 [TEST] Fix flaky checkout integration test" },
  },
  {
    text: "Align the developer database image with the deployed version and repair the fresh-install race",
    expected: {
      kind: "task",
      locator: "P1-55",
      title: "[TEST] Bump local dev Postgres image to 16 and fix volume-init race",
    },
  },
  {
    text: "Let ops save the visible report slice to a file instead of copying it by hand",
    expected: { kind: "task", locator: "P1-56", title: "🧪 [TEST] Add CSV export to reports page" },
  },
  {
    text: "Spin up a throwaway site per change so designers don't need a local checkout",
    expected: { kind: "task", locator: "P1-57", title: "[TEST] Set up preview deploys for frontend changes" },
  },
  { text: "how do I bake sourdough bread" },
  { text: "what is the capital of France" },
  { text: "best hiking trails in Bali" },
  { text: "recommend a sci-fi novel" },
  { text: "what is the weather forecast for Berlin tomorrow" },
];

const DEFAULT_SWEEP = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.58, 0.6];

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

const KNOWN_FLAGS: Record<string, true> = { "--db": true, "--project": true, "--sweep": true };
for (const arg of args) {
  if (!arg.startsWith("--")) continue;
  const name = arg.split("=")[0] ?? arg;
  if (KNOWN_FLAGS[name] !== true) console.log(`warn: ignoring unknown flag ${name}`);
}

applyEnvFile();
const env = getEnv();
const dbPath = option("--db") ?? resolveDatabasePath(env);
let sqlite: Database;
try {
  sqlite = new Database(dbPath, { readonly: true });
} catch (error) {
  console.error(`FAIL cannot open DB ${dbPath}: ${String(error)}`);
  process.exit(1);
}
const db = createBunSqliteDriver(sqlite, { readonly: true });

const projects = sqlite.query("SELECT id FROM projects ORDER BY rowid").all() as { id: string }[];
const projectId = option("--project") ?? projects[0]?.id;
if (projectId === undefined) {
  console.error("FAIL no projects in DB; pass --project <id>");
  process.exit(1);
}
if (option("--project") === undefined && projects.length > 1) {
  console.log(`note: ${projects.length} projects; defaulting to ${projectId} (pass --project to override)`);
}

function matches(hit: SemanticHit, expected: ExpectedSource): boolean {
  return hit.title === expected.title || (hit.kind === expected.kind && hit.locator === expected.locator);
}

interface QueryResult {
  query: EvalQuery;
  /** True only when semanticSearch returned null (failure); [] is not a failure. */
  searchFailed: boolean;
  top: SemanticHit | null;
  /** 1-based rank of the first matching top-5 hit; null = miss. */
  rank: number | null;
  hint: string | null;
  /** semanticHint emitted the expected title. */
  hintHit: boolean;
}

function scoreText(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(3);
}

function minOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle]!;
  if (sorted.length % 2 === 1) return value;
  return (sorted[middle - 1]! + value) / 2;
}

function percent(part: number, total: number): string {
  return total === 0 ? "n/a" : `${((part / total) * 100).toFixed(1)}%`;
}

const results: QueryResult[] = [];
for (const query of QUERIES) {
  const hits = await semanticSearch(db, env, projectId, query.text, 5);
  const hint = await semanticHint(db, env, projectId, query.text);
  const expected = query.expected;
  let rank: number | null = null;
  if (expected !== undefined && hits !== null) {
    const index = hits.findIndex((hit) => matches(hit, expected));
    rank = index === -1 ? null : index + 1;
  }
  const hintHit = expected !== undefined && hint !== null && hint.includes(expected.title);
  results.push({ query, searchFailed: hits === null, top: hits?.[0] ?? null, rank, hint, hintHit });

  const score = scoreText(hits?.[0]?.score);
  if (expected === undefined) {
    console.log(`neg  rank=-    score=${score} hint=${hint === null ? "no" : "YES"}  "${query.text}"`);
  } else {
    console.log(
      `${rank === null ? "miss" : "ok  "} rank=${rank ?? "-"}    score=${score} hint=${
        hintHit ? "yes" : "no "
      }  "${query.text}" -> ${expected.title} [${expected.locator}]`
    );
  }
}

const positives = results.filter((result) => result.query.expected !== undefined);
const negatives = results.filter((result) => result.query.expected === undefined);
const topFiveHits = positives.filter((result) => result.rank !== null).length;
const hintHits = positives.filter((result) => result.hintHit).length;
const failedSearches = results.filter((result) => result.searchFailed).length;
const emptySearches = results.filter((result) => !result.searchFailed && result.top === null).length;

const hitScores = positives
  .filter((result) => result.rank !== null)
  .map((result) => result.top?.score)
  .filter((value): value is number => value !== undefined);
const missScores = positives
  .filter((result) => result.rank === null)
  .map((result) => result.top?.score)
  .filter((value): value is number => value !== undefined);
const negativeScores = negatives
  .map((result) => result.top?.score)
  .filter((value): value is number => value !== undefined);
const negativeHints = negatives.filter((result) => result.hint !== null).length;

const formatRange = (values: readonly number[]): string => {
  const min = minOf(values);
  const median = medianOf(values);
  return min === null || median === null ? "n/a" : `min ${min.toFixed(3)} median ${median.toFixed(3)} (n=${values.length})`;
};

console.log("");
console.log("summary");
console.log(`  project ${projectId}   db ${dbPath}`);
console.log(`  positives ${positives.length}   negatives ${negatives.length}   failed searches ${failedSearches}   empty results ${emptySearches}`);
if (failedSearches > 0) {
  console.log(`  FAIL ${failedSearches}/${results.length} semanticSearch calls returned null (env/credentials/provider/DB failure)`);
}
console.log(`  top-5 recall          ${topFiveHits}/${positives.length} (${percent(topFiveHits, positives.length)})`);
console.log(
  `  hint recall @${SEMANTIC_HINT_MIN_COSINE.toFixed(2)}     ${hintHits}/${positives.length} (${percent(
    hintHits,
    positives.length
  )}) via semanticHint`
);
console.log(`  top-1 score, top-5 hits  ${formatRange(hitScores)}`);
console.log(`  top-1 score, misses   ${formatRange(missScores)}`);
console.log(
  `  negatives top-1       ${formatRange(negativeScores)}; hints emitted ${negativeHints}/${negatives.length} (FAIL when > 0 at the chosen threshold)`
);

const sweepRaw = option("--sweep");
const sweepRequested = args.some((arg) => arg === "--sweep" || arg.startsWith("--sweep="));
if (sweepRequested) {
  const tokens = sweepRaw === undefined ? [] : sweepRaw.split(",");
  const dropped = tokens.filter((token) => token.trim() === "" || !Number.isFinite(Number(token.trim())));
  if (dropped.length > 0) {
    console.log(
      `warn: --sweep dropped non-numeric tokens: ${dropped.map((token) => token.trim() || "(empty)").join(", ")}`
    );
  }
  const sweep =
    sweepRaw === undefined
      ? DEFAULT_SWEEP
      : tokens
          .filter((token) => token.trim() !== "" && Number.isFinite(Number(token.trim())))
          .map((token) => Number(token.trim()));
  if (sweep.length === 0) {
    console.error(`FAIL empty --sweep list: ${sweepRaw ?? ""}`);
    process.exit(1);
  }
  console.log("");
  console.log("sweep (hint decision = top-1 score >= threshold)");
  console.log("  threshold  recall        precision      hints  negatives>=T");
  for (const candidate of sweep) {
    let trueHints = 0;
    let emitted = 0;
    let negativesCleared = 0;
    for (const result of positives) {
      const expected = result.query.expected;
      const top = result.top;
      if (expected === undefined || top === null || top.score < candidate) continue;
      emitted += 1;
      if (matches(top, expected)) trueHints += 1;
    }
    for (const result of negatives) {
      const top = result.top;
      if (top !== null && top.score >= candidate) {
        emitted += 1;
        negativesCleared += 1;
      }
    }
    console.log(
      `  ${candidate.toFixed(3)}      ${String(trueHints).padStart(2)}/${positives.length} ${percent(
        trueHints,
        positives.length
      ).padStart(6)}  ${String(trueHints).padStart(2)}/${String(emitted).padEnd(2)} ${percent(
        trueHints,
        emitted
      ).padStart(6)}  ${String(emitted).padStart(5)}  ${negativesCleared}/${negatives.length}`
    );
  }
  const maxNegative = negativeScores.length === 0 ? null : Math.max(...negativeScores);
  const minPositive = hitScores.length === 0 ? null : Math.min(...hitScores);
  if (maxNegative !== null) console.log(`  max negative top-1 ${maxNegative.toFixed(3)}`);
  if (minPositive !== null) console.log(`  min positive top-1 ${minPositive.toFixed(3)}`);
}
