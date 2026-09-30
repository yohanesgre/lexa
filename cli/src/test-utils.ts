import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..");

const isolationDirs: string[] = [];

export function freshLexaDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lexa-index-lexa-"));
  isolationDirs.push(d);
  return d;
}

export function cleanupIsolationDirs(): void {
  for (const d of isolationDirs) rmSync(d, { recursive: true, force: true });
  isolationDirs.length = 0;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["cli/src/index.ts", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, LEXA_DIR: env.LEXA_DIR ?? freshLexaDir() },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli subprocess timed out: ${args.join(" ")}`));
    }, 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
