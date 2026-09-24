import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "./db/migrate";
import { fetchSharedTreeServer } from "../app/lib/share.server";
import { extractSnippet, shareHeadMeta, type SharedTree } from "../app/lib/share";
import { injectEntryScript } from "./workers-entry";

// A full handler-level render test (calling the TanStack Start handler) cannot
// run under vitest: @tanstack/react-start/server pulls Vite-virtual modules
// (#tanstack-router-entry etc.) that only exist inside the vite build — see
// server/workers-shims/start-server.ts. This file is the layered equivalent:
// the D1/SQLite share lookup, the server-rendered head meta, and the Workers
// per-response HTML patch. The Bun serving gate (non-share → shell, /share/*
// → SSR) is covered by the W3 smoke against a built server, since
// server/entry.ts boots a Bun.serve at import time and is not importable here.

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

const ROOT_DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello share" }] }],
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-share-ssr-"));
  const dbPath = join(dir, "lexa.db");
  runMigrations(dbPath, MIGRATIONS);
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u1','u1@test.dev','User One')").run();
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare(
    `INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position) VALUES
       ('w-root','p1','Root Page','home',?,'hello share',NULL,0),
       ('w-child','p1','Child Page','child',?,'','w-root',0)`
  ).run(JSON.stringify(ROOT_DOC), JSON.stringify({ type: "doc", content: [] }));
  db.prepare("INSERT INTO wiki_share_links (id, page_id, token, expires_at, created_by) VALUES ('l1','w-root','tok-live',NULL,'u1')").run();
  db.prepare("INSERT INTO wiki_share_links (id, page_id, token, expires_at, created_by) VALUES ('l2','w-root','tok-expired','2000-01-01T00:00:00.000Z','u1')").run();
  db.close();
  // fetchSharedTreeServer builds its runtime lazily on first call, from this env.
  process.env.DATABASE_PATH = dbPath;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("share SSR data (fetchSharedTreeServer)", () => {
  it("resolves a live token to the shared subtree — same shape as the API payload", async () => {
    const tree = await fetchSharedTreeServer("tok-live");
    expect(tree?.root.title).toBe("Root Page");
    expect(tree?.root.slug).toBe("home");
    expect(tree?.root.children.map((c) => c.title)).toEqual(["Child Page"]);
  });

  it("returns null for expired and unknown tokens (no oracle)", async () => {
    expect(await fetchSharedTreeServer("tok-expired")).toBeNull();
    expect(await fetchSharedTreeServer("nope")).toBeNull();
  });
});

describe("share head meta (server-rendered OG)", () => {
  it("emits title + description + og:title + og:description + robots for a tree", () => {
    const tree: SharedTree = {
      root: {
        id: "w1",
        title: "API Reference",
        slug: "home",
        content: ROOT_DOC,
        updatedAt: "2026-08-21T10:00:00.000Z",
        children: [],
      },
    };
    const meta = shareHeadMeta(tree);
    expect(meta).toContainEqual({ title: "API Reference" });
    expect(meta).toContainEqual({ name: "description", content: "hello share" });
    expect(meta).toContainEqual({ property: "og:title", content: "API Reference" });
    expect(meta).toContainEqual({ property: "og:description", content: "hello share" });
    expect(meta).toContainEqual({ name: "robots", content: "noindex" });
  });

  it("falls back to the generic title/description when the tree is null", () => {
    const meta = shareHeadMeta(null);
    expect(meta).toContainEqual({ title: "Lexa shared page" });
    expect(meta).toContainEqual({ property: "og:description", content: "Shared via Lexa" });
  });

  it("extractSnippet walks text nodes, truncates at 160, and returns null for empty docs", () => {
    const long = "x".repeat(200);
    const longTree: SharedTree = {
      root: {
        id: "w1", title: "T", slug: "t",
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: long }] }] },
        updatedAt: "2026-08-21T10:00:00.000Z", children: [],
      },
    };
    const snippet = extractSnippet(longTree);
    expect(snippet).toBe(`${long.slice(0, 157)}...`);
    const emptyTree: SharedTree = {
      root: { id: "w2", title: "E", slug: "e", content: { type: "doc", content: [] }, updatedAt: "2026-08-21T10:00:00.000Z", children: [] },
    };
    expect(extractSnippet(emptyTree)).toBeNull();
    expect(extractSnippet(null)).toBeNull();
  });
});

describe("workers per-response SSR patch", () => {
  it("patches two different HTML documents independently (no module-global reuse)", () => {
    const a = '<html><body><script>self.__TSR={src:"/assets/index-AAA.js"}</script></body></html>';
    const b = '<html><body><script>self.__TSR={src:"/assets/index-BBB.js"}</script></body></html>';
    const pa = injectEntryScript(a);
    const pb = injectEntryScript(b);
    expect(pa).toContain('src="/assets/index-AAA.js"');
    expect(pb).toContain('src="/assets/index-BBB.js"');
    expect(pa).not.toEqual(pb);
    // Re-patching A after B still yields A's document — nothing cached globally.
    expect(injectEntryScript(a)).toEqual(pa);
  });

  it("leaves an HTML document that already has a module script unchanged", () => {
    const withModule = '<html><head><script type="module" src="/assets/index-AAA.js"></script></head></html>';
    expect(injectEntryScript(withModule)).toBe(withModule);
  });
});

describe("share route model (server-render enabled)", () => {
  // Cheap regression guard for the rendering model: a real render test needs the
  // vite build, so pin the ssr flags across every route file. Comments are
  // stripped first so a comment mentioning `ssr: false` cannot skew the match.
  it("every route declares ssr:false except root (ssr:true) and /share/$token (inherits)", () => {
    const routeDir = fileURLToPath(new URL("../app/routes", import.meta.url));
    const files = walkRouteFiles(routeDir);
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      const base = basename(file);
      if (base === "__root.tsx") {
        expect(code, `${base} must declare ssr:true`).toMatch(/^\s*ssr:\s*true,/m);
      } else if (base === "share.$token.tsx") {
        expect(code, `${base} must inherit SSR (no ssr:false)`).not.toMatch(/^\s*ssr:\s*false/m);
      } else {
        expect(code, `${base} must declare ssr:false`).toMatch(/^\s*ssr:\s*false/m);
      }
    }
  });
});

// Full-line `//` comments and block comments are removed; the `ssr` declaration
// itself is never on a comment line.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRouteFiles(path));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(path);
  }
  return out;
}
