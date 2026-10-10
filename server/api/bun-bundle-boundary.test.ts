import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0005 D7 bundle boundary. This walk covers each entry's EAGER (static)
// module graph. Lazy `import()` targets are separate chunks and are NOT
// followed: the Bun host mounts `server/api/assistant-api.ts` with
// `await import(...)` at handler-build time (proven at runtime by
// `http-bun-assistant-present.test.ts`), and `summarize.ts` lazily imports the
// DO-only model factory. So the eager Bun entry must reach no DO package
// (`agents`, `workers-ai-provider`, `@ai-sdk/*`, `@cloudflare/ai-chat`) and no
// DO module; the Workers entry eagerly reaches them (non-vacuous).
//
// Mechanism: a static import-graph walk from the Bun entry over relative
// specifiers, collecting every bare package specifier reachable transitively.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Static `import`/`export ... from` and bare `import "x"` only — never
// `import(...)` (lazy chunks are out of the eager boundary) and never
// `import type` / `export type` (a type-only edge is erased by the bundler, so
// following it would be a false positive, e.g. `summarize.ts` → `model-factory`).
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s(?!type\b)[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

const FORBIDDEN = [/^agents$/, /^@ai-sdk(\/|$)/, /^workers-ai-provider$/, /^@cloudflare\/ai-chat(\/|$)/];

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const base = spec.startsWith("/") ? resolve(ROOT, spec.slice(1)) : resolve(dirname(fromFile), spec);
  // Try the literal path first, then the TS resolution suffixes. Never gate on
  // `extname`: a specifier like `./x.service` reports `.service`, not `.ts`.
  const candidates = [base, base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")];
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
      const spec = match[1] ?? match[2];
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
  // The lazily-mounted assistant chunk is a second Bun root: it loads on Bun at
  // handler-build time, so its EAGER graph must be DO-package-free too.
  const assistant = walkGraph(resolve(ROOT, "server/api/assistant-api.ts"));

  it("Bun entry eagerly reaches no DO package (agents / @ai-sdk / workers-ai-provider / @cloudflare/ai-chat)", () => {
    const forbidden = [...bun.bare].filter((s) => FORBIDDEN.some((re) => re.test(s)));
    expect(forbidden).toEqual([]);
  });

  it("Bun entry eagerly reaches no DO module (agent / runner / model-factory)", () => {
    expect([...bun.files].some((f) => f.endsWith("/server/assistant/agent.ts"))).toBe(false);
    expect([...bun.files].some((f) => f.endsWith("/server/assistant/runner.ts"))).toBe(false);
    expect([...bun.files].some((f) => f.endsWith("/server/assistant/model-factory.ts"))).toBe(false);
    // Non-vacuous: the eager base graph is substantial.
    expect(bun.files.size).toBeGreaterThan(50);
  });

  it("the lazily-mounted assistant chunk's eager graph is DO-package-free", () => {
    const forbidden = [...assistant.bare].filter((s) => FORBIDDEN.some((re) => re.test(s)));
    expect(forbidden).toEqual([]);
    expect([...assistant.files].some((f) => f.endsWith("/server/assistant/model-factory.ts"))).toBe(false);
    expect(assistant.files.size).toBeGreaterThan(50);
  });

  it("Workers entry eagerly reaches the DO modules + a DO package (non-vacuous)", () => {
    expect([...workers.files].some((f) => f.endsWith("/server/assistant/agent.ts"))).toBe(true);
    expect([...workers.files].some((f) => f.endsWith("/server/assistant/model-factory.ts"))).toBe(true);
    expect([...workers.bare].some((s) => FORBIDDEN.some((re) => re.test(s)))).toBe(true);
  });

  it("Workers entry reaches the delegation runner facet; the Bun entry never does", () => {
    expect([...workers.files].some((f) => f.endsWith("/server/assistant/runner.ts"))).toBe(true);
    expect([...bun.files].some((f) => f.endsWith("/server/assistant/runner.ts"))).toBe(false);
  });
});
