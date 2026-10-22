import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1Driver } from "../server/db/drivers/d1";
import { d1DatabaseToD1Like } from "../server/api/workers-ports";
import type { DbDriver } from "../server/db/driver";
import { createBunSqliteDriver } from "../server/db/drivers/bun-sqlite";
import { readWranglerConfig } from "./lib/cf-deploy";
import {
  applyMarkdownUpgrade,
  auditMarkdownUpgrade,
  parseMarkdownAudit,
  type MarkdownAuditReport,
} from "../server/db/markdown-upgrade";

const BACKUP_FORMAT = "lexa-markdown-backup/v1";

type Target = {
  id: string;
  flavor: "sqlite" | "d1-local" | "d1-remote";
  database: DbDriver;
  close(): Promise<void> | void;
};
type ParsedArgs = {
  action: "audit" | "apply";
  sqlite?: string | undefined;
  d1Config?: string | undefined;
  databaseName?: string | undefined;
  databaseId?: string | undefined;
  local: boolean;
  remote: boolean;
  persistTo?: string | undefined;
  report?: string | undefined;
  audit?: string | undefined;
  backupManifest?: string | undefined;
  batchSize: number;
};
type BackupManifest = {
  format: string;
  target_id: string;
  created_at: string;
  artifact: { kind: "sqlite-snapshot" | "d1-export"; path: string; sha256: string };
  restore_tested: boolean;
  restore_tested_at: string;
  restored_to_target_id: string;
  includes_blobs: boolean;
};
type WranglerProxyEnv = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [action, ...rest] = argv;
  if (action !== "audit" && action !== "apply") {
    fail("usage: bun run scripts/migrate-markdown.ts <audit|apply> (--sqlite PATH | --d1-config PATH --database-name NAME --local --persist-to PATH | --d1-config PATH --database-name NAME --remote --database-id ID) [options]");
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valued: Readonly<Record<string, true>> = {
    "--sqlite": true, "--d1-config": true, "--database-name": true,
    "--database-id": true, "--persist-to": true, "--report": true,
    "--audit": true, "--backup-manifest": true, "--batch-size": true,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === "--local" || flag === "--remote") {
      if (flags.has(flag)) fail(`duplicate option ${flag}`);
      flags.add(flag);
      continue;
    }
    if (valued[flag] !== true) fail(`unknown option ${flag}`);
    if (values.has(flag)) fail(`duplicate option ${flag}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const batchSizeRaw = values.get("--batch-size");
  const batchSize = batchSizeRaw === undefined ? 25 : Number(batchSizeRaw);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) fail("--batch-size must be an integer from 1 through 50");
  return {
    action,
    sqlite: values.get("--sqlite"),
    d1Config: values.get("--d1-config"),
    databaseName: values.get("--database-name"),
    databaseId: values.get("--database-id"),
    local: flags.has("--local"),
    remote: flags.has("--remote"),
    persistTo: values.get("--persist-to"),
    report: values.get("--report"),
    audit: values.get("--audit"),
    backupManifest: values.get("--backup-manifest"),
    batchSize,
  };
}

function configuredD1(configPath: string): {
  binding: string;
  name: string;
  id: string;
  compatibilityDate: string;
} {
  const config: unknown = readWranglerConfig(configPath);
  if (typeof config !== "object" || config === null || !("d1_databases" in config) ||
      !Array.isArray(config.d1_databases)) fail("Wrangler config has no d1_databases bindings");
  const binding: unknown = config.d1_databases[0];
  if (typeof binding !== "object" || binding === null ||
      !("binding" in binding) || typeof binding.binding !== "string" || !binding.binding ||
      !("database_name" in binding) || typeof binding.database_name !== "string" || !binding.database_name ||
      !("database_id" in binding) || typeof binding.database_id !== "string" || !binding.database_id) {
    fail("First Wrangler D1 binding must declare binding, database_name and database_id");
  }
  if (!("compatibility_date" in config) || typeof config.compatibility_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date)) {
    fail("Wrangler config must declare a valid compatibility_date");
  }
  return {
    binding: binding.binding,
    name: binding.database_name,
    id: binding.database_id,
    compatibilityDate: config.compatibility_date,
  };
}

async function openTarget(args: ParsedArgs): Promise<Target> {
  if (args.sqlite && args.d1Config) fail("choose exactly one database target");
  if (args.sqlite) {
    if (args.local || args.remote || args.databaseName || args.databaseId || args.persistTo) fail("D1 options cannot be used with --sqlite");
    const path = await realpath(resolve(args.sqlite));
    const file = Bun.file(path);
    if (!(await file.exists())) fail(`SQLite database does not exist: ${path}`);
    const readonly = args.action === "audit";
    const native = new Database(path, { readonly, readwrite: !readonly });
    return { id: `sqlite:${path}`, flavor: "sqlite", database: createBunSqliteDriver(native, { readonly }), close: async () => native.close() };
  }
  if (!args.d1Config || !args.databaseName) fail("D1 requires --d1-config and --database-name");
  if (args.local === args.remote) fail("D1 requires exactly one of --local or --remote");
  const configPath = await realpath(resolve(args.d1Config));
  const configured = configuredD1(configPath);
  if (configured.name !== args.databaseName) fail(`--database-name must match first Wrangler D1 binding (${configured.name})`);
  if (args.local) {
    if (args.databaseId) fail("--database-id is only valid with --remote");
    if (!args.persistTo) fail("local D1 requires explicit --persist-to");
  } else {
    if (!args.databaseId) fail("remote D1 requires explicit --database-id");
    if (configured.id !== args.databaseId) fail("--database-id does not match the Wrangler config binding");
  }

  const proxyDirectory = await mkdtemp(join(tmpdir(), "lexa-markdown-d1-"));
  const proxyConfigPath = join(proxyDirectory, "wrangler.json");
  try {
    await Bun.write(proxyConfigPath, JSON.stringify({
      name: "lexa-markdown-upgrade",
      compatibility_date: configured.compatibilityDate,
      d1_databases: [{
        binding: configured.binding,
        database_name: configured.name,
        database_id: configured.id,
        remote: args.remote,
      }],
    }));
    const proxy = await getPlatformProxy<WranglerProxyEnv>({
      configPath: proxyConfigPath,
      persist: args.local ? { path: join(resolve(args.persistTo!), "v3") } : false,
      remoteBindings: args.remote,
    });
    try {
      const binding = proxy.env[configured.binding];
      if (typeof binding !== "object" || binding === null ||
          !("prepare" in binding) || typeof binding.prepare !== "function" ||
          !("batch" in binding) || typeof binding.batch !== "function") {
        fail(`Wrangler proxy did not provide selected D1 binding ${configured.binding}`);
      }
      return {
        id: args.local
          ? `d1-local:${configPath}:${configured.name}:${resolve(args.persistTo!)}`
          : `d1-remote:${args.databaseId}`,
        flavor: args.local ? "d1-local" : "d1-remote",
        database: createD1Driver(d1DatabaseToD1Like(binding as D1Database)),
        close: async () => {
          try { await proxy.dispose(); }
          finally { await rm(proxyDirectory, { recursive: true, force: true }); }
        },
      };
    } catch (error) {
      await proxy.dispose();
      throw error;
    }
  } catch (error) {
    await rm(proxyDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`backup artifact does not exist: ${path}`);
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = file.stream().getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hasher.update(chunk.value);
  }
  return hasher.digest("hex");
}

async function verifyBackupManifest(path: string, target: Target): Promise<void> {
  let manifest: BackupManifest;
  try { manifest = await Bun.file(resolve(path)).json() as BackupManifest; }
  catch { fail("backup manifest is missing or invalid JSON"); }
  if (manifest.format !== BACKUP_FORMAT || manifest.target_id !== target.id) fail("backup manifest format/target does not match selected database");
  if (manifest.restore_tested !== true || manifest.includes_blobs !== true ||
      !Number.isFinite(Date.parse(manifest.created_at)) || !Number.isFinite(Date.parse(manifest.restore_tested_at)) ||
      typeof manifest.restored_to_target_id !== "string" || !manifest.restored_to_target_id || manifest.restored_to_target_id === target.id) {
    fail("backup manifest must prove a restore-tested database and blob backup on a separate target");
  }
  const kind = manifest.artifact?.kind;
  const validKind = target.flavor === "sqlite" ? kind === "sqlite-snapshot"
    : kind === "d1-export" || target.flavor === "d1-local" && kind === "sqlite-snapshot";
  if (!validKind || !manifest.artifact.path || !/^[0-9a-f]{64}$/.test(manifest.artifact.sha256)) {
    fail("Backup artifact must have a SHA-256 and be a D1 export or a SQLite snapshot (SQLite/local D1 only)");
  }
  const artifactPath = await realpath(resolve(manifest.artifact.path));
  const actualHash = await sha256File(artifactPath);
  if (actualHash !== manifest.artifact.sha256) fail("backup artifact SHA-256 does not match manifest");
}

function requiredPath(value: string | undefined, option: string): string {
  if (!value) fail(`${option} is required`);
  return resolve(value);
}

async function writeAudit(path: string, report: MarkdownAuditReport): Promise<void> {
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.action === "audit" && (!args.report || args.audit || args.backupManifest)) fail("audit requires --report and does not accept --audit/--backup-manifest");
  if (args.action === "apply" && (!args.audit || !args.backupManifest || args.report)) fail("apply requires --audit and --backup-manifest and does not accept --report");
  const target = await openTarget(args);
  try {
    if (args.action === "audit") {
      const report = await auditMarkdownUpgrade(target.database, target.id);
      await writeAudit(requiredPath(args.report, "--report"), report);
      console.log(`Audit: ${report.records.length} source fields, ${report.blockers.length} blockers; report ${resolve(args.report!)}`);
      if (report.blockers.length > 0) process.exitCode = 2;
      return;
    }
    await verifyBackupManifest(requiredPath(args.backupManifest, "--backup-manifest"), target);
    let reportValue: unknown;
    try { reportValue = await Bun.file(requiredPath(args.audit, "--audit")).json(); }
    catch { fail("audit report is missing or invalid JSON"); }
    const report = parseMarkdownAudit(reportValue);
    const result = await applyMarkdownUpgrade(target.database, report, target.id, args.batchSize);
    console.log(result.alreadyMarkdown ? "Apply: database already markdown-v1; no conversion performed" : `Apply: ${result.updated} source fields journaled; documents.format=markdown-v1`);
  } finally {
    await target.close();
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
