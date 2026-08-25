// Mobile responsiveness check.
//
// Visits every authenticated route at 375px (iPhone) and 768px (iPad portrait)
// and asserts document.documentElement.scrollWidth <= viewport width. Fails
// on any horizontal overflow at any route.
//
// Usage:
//   bun run dev:full           # in one terminal
//   bunx playwright install chromium   # one-time
//   bun run check:mobile       # in another terminal
//
// Requires a logged-in user. The script logs in as the seed admin from
// .env (LXK_ADMIN_EMAILS) using the seed password "admin1234" — adjust
// the login call if your seed differs.

import { chromium, devices } from "playwright";

const BASE = process.env.LEXA_BASE_URL ?? "http://localhost:5173";
const ADMIN_EMAIL = process.env.LXK_ADMIN_EMAILS?.split(",")[0]?.trim();
const PASSWORD = process.env.LEXA_SEED_PASSWORD ?? "admin1234";

const VIEWPORTS = [
  { name: "375px (mobile)", width: 375, height: 812 },
  { name: "768px (tablet)", width: 768, height: 1024 },
];

// Routes to check. Bare-path routes (/login, /setup, /share/*) are skipped
// when logged in. Project-scoped routes use the first project the user has.
const ROUTES = [
  { path: "/", name: "Home (project list)" },
  { path: "/hearth", name: "Hearth" },
  { path: "/settings/workspace", name: "Settings / Workspace" },
  { path: "/settings/team", name: "Settings / Team" },
  { path: "/settings/me", name: "Settings / Me" },
  { path: "/__project__", name: "Project dashboard" },
  { path: "/__project__/board", name: "Project / Board" },
  { path: "/__project__/tasks", name: "Project / Tasks" },
  { path: "/__project__/milestones", name: "Project / Milestones" },
  { path: "/__project__/swimlanes", name: "Project / Swimlanes" },
  { path: "/__project__/wiki", name: "Project / Wiki" },
  { path: "/__project__/chat", name: "Project / Chat" },
  { path: "/setup", name: "Setup wizard" },
  { path: "/__share__", name: "Public wiki share" },
];

const RESULTS = [];
let FAILED = 0;

async function login(page) {
  await page.goto(`${BASE}/login`);
  if (!ADMIN_EMAIL) {
    throw new Error("LXK_ADMIN_EMAILS not set in .env");
  }
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10_000 });
}

async function findFirstProjectSlug(page) {
  // Navigate to home and read the first project card link.
  await page.goto(`${BASE}/`);
  await page.waitForSelector("a.project-card, .project-card", { timeout: 10_000 });
  const href = await page.$eval("a.project-card", (a) => a.getAttribute("href"));
  if (!href) throw new Error("No project cards found on home — seed a project first");
  // href is like "/nimbus"
  return href.replace(/^\//, "");
}

async function checkViewport(browser, viewport, projectSlug) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await login(page);
  if (!projectSlug) projectSlug = await findFirstProjectSlug(page);

  for (const route of ROUTES) {
    let path = route.path.replace("__project__", projectSlug);
    if (path === "/__share__") {
      // Look up a public share token via the local DB; skip if none exist.
      try {
        const dbMod = await import("bun:sqlite");
        const db = new dbMod.Database("./data/lexa.db");
        const row = db.query("SELECT token FROM wiki_share_links LIMIT 1").get();
        db.close();
        if (!row) {
          RESULTS.push({ viewport: viewport.name, route: route.name, path: "/share/<token>", ok: true, skipped: true });
          continue;
        }
        path = `/share/${row.token}`;
      } catch (err) {
        RESULTS.push({ viewport: viewport.name, route: route.name, path: "/share/<token>", ok: false, error: String(err).slice(0, 200) });
        FAILED++;
        continue;
      }
    }
    const url = `${BASE}${path}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      // Wait a bit for lazy data + transitions.
      await page.waitForTimeout(500);
      const metrics = await page.evaluate(() => {
        const winW = window.innerWidth;
        const docW = document.documentElement.scrollWidth;
        const offenders = [];
        document.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.right > winW + 1 && r.width > 0) {
            offenders.push({
              tag: el.tagName,
              class: (el.className || "").toString().slice(0, 50),
              right: Math.round(r.right),
              width: Math.round(r.width),
            });
          }
        });
        return { winW, docW, sample: offenders.slice(0, 3), overflow: docW - winW };
      });
      const ok = metrics.overflow <= 1;
      RESULTS.push({
        viewport: viewport.name,
        route: route.name,
        path,
        ok,
        docW: metrics.docW,
        winW: metrics.winW,
        overflow: metrics.overflow,
        offenders: metrics.sample,
      });
      if (!ok) FAILED++;
    } catch (err) {
      RESULTS.push({
        viewport: viewport.name,
        route: route.name,
        path,
        ok: false,
        error: String(err).slice(0, 200),
      });
      FAILED++;
    }
  }
  await context.close();
}

const browser = await chromium.launch();
try {
  let slug = null;
  for (const v of VIEWPORTS) {
    await checkViewport(browser, v, slug);
    if (!slug) slug = await (async () => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await login(p);
      const s = await findFirstProjectSlug(p);
      await ctx.close();
      return s;
    })();
  }
} finally {
  await browser.close();
}

const pass = RESULTS.filter((r) => r.ok).length;
const fail = RESULTS.length - pass;
console.log(`\nMobile responsiveness check: ${pass}/${RESULTS.length} routes passed`);
if (fail > 0) {
  console.log(`\nFailures:`);
  for (const r of RESULTS.filter((r) => !r.ok)) {
    console.log(`  [${r.viewport}] ${r.route} (${r.path})`);
    if (r.error) console.log(`    error: ${r.error}`);
    else if (r.overflow != null) {
      console.log(`    documentWidth=${r.docW}, viewport=${r.winW}, overflow=${r.overflow}px`);
      for (const o of r.offenders) {
        console.log(`      <${o.tag.toLowerCase()} class="${o.class}"> right=${o.right} width=${o.width}`);
      }
    }
  }
  process.exit(1);
}
console.log("All routes pass.");
process.exit(0);
