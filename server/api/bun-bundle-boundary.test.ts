import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0005 D7 bundle boundary: the assistant tier (TanStack AI, in-process) now
// runs on BOTH flavors, so the Bun entry legitimately reaches
// `@tanstack/ai*` and `server/api/assistant-api.ts`. The DO executor stays off
// the Bun path: the Bun entry must still never reach `agents`,
// `workers-ai-provider`, `@cloudflare/ai-chat`, or `@ai-sdk/*`, nor the DO
// modules (`assistant/agent.ts`, `assistant/runner.ts`).
//
// Mechanism: a static import-graph walk from the Bun entry over relative
// specifiers, collecting every bare package specifier reachable transitively.
// The Workers entry is walked too, as a non-vacuous sanity check that the
// boundary actually differs.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const FORBIDDEN = [/^agents$/, /^@ai-sdk(\/|$)/, /^workers-ai-provider$/, /^@cloudflare\/ai-chat(\/|$)/];

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const base = spec.startsWith("/") ? resolve(ROOT, spec.slice(1)) : resolve(dirname(fromFile), spec);
  const candidates = extname(base)
    ? [base]
    : [base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

interface WalkResult {
  files: Set<string>;
  bare: Set<string>;
}

function walkGraph(entryFile: string): WalkResult {
  const files = new Set<string>();
  const bare = new Set<string>();
  const stack = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(src)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const resolved = resolveRelative(file, spec);
      if (resolved) stack.push(resolved);
      else bare.add(spec);
    }
  }
  return { files, bare };
}

describe("Bun bundle boundary (ADR-0005 D7)", () => {
  const bun = walkGraph(resolve(ROOT, "server/entry.ts"));
  const workers = walkGraph(resolve(ROOT, "server/workers-entry.ts"));

  it("Bun entry reaches no DO package (agents / @ai-sdk / workers-ai-provider / @cloudflare/ai-chat)", () => {
    const forbidden = [...bun.bare].filter((s) => FORBIDDEN.some((re) => re.test(s)));
    expect(forbidden).toEqual([]);
  });

  it("Bun entry reaches the in-process assistant module graph but not the DO modules", () => {
    expect([...bun.files].some((f) => f.endsWith("/server/api/assistant-api.ts"))).toBe(true);
    expect([...bun.files].some((f) => f.endsWith("/server/assistant/agent.ts"))).toBe(false);
    expect([...bun.files].some((f) => f.endsWith("/server/assistant/runner.ts"))).toBe(false);
  });

  it("Workers entry does reach the assistant module graph (non-vacuous)", () => {
    expect([...workers.files].some((f) => f.endsWith("/server/api/assistant-api.ts"))).toBe(true);
    expect([...workers.bare].some((s) => /^@tanstack\/ai(\/|$)/.test(s))).toBe(true);
  });

  it("Workers entry reaches the delegation runner facet; the Bun entry never does", () => {
    expect([...workers.files].some((f) => f.endsWith("/server/assistant/runner.ts"))).toBe(true);
    expect([...bun.files].some((f) => f.endsWith("/server/assistant/runner.ts"))).toBe(false);
  });
});
