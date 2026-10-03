// cli/src/index.skill.test.ts — `lx skill install` dispatch + file writes,
// exercised through the real entry point as a bun subprocess (non-TTY stdin,
// so the prompt path is not taken; the numbered prompt is TTY-only).
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..");
const dirs: string[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [join(REPO_ROOT, "cli/src/index.ts"), ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
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

describe("skill dispatch", () => {
  it("skill with no subcommand prints group help and exits 0", async () => {
    const r = await runCli(["skill"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skill install");
    expect(r.stdout).toContain("--global");
  });

  it("unknown subcommand prints group help + exit 1", async () => {
    const r = await runCli(["skill", "bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown: skill bogus");
    expect(r.stdout).toContain("skill install");
  });

  it("help lists the skill section", async () => {
    const r = await runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Skill:");
    expect(r.stdout).toContain("skill install");
  });
});

describe("skill install (bun subprocess)", () => {
  it("non-TTY without a target refuses with usage + exit 1", async () => {
    const r = await runCli(["skill", "install"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("target is required");
    expect(r.stderr).toContain("Usage: lx skill install [--global | --local] [--force]");
  });

  it("--global writes the embedded SKILL.md under $HOME/.agents/skills", async () => {
    const home = freshDir("lx-skill-home-");
    const r = await runCli(["skill", "install", "--global"], { env: { HOME: home } });
    expect(r.status).toBe(0);
    const path = join(home, ".agents/skills/lexa-cli/SKILL.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("name: lexa-cli");
    expect(content).toContain("lx skill install");
    expect(r.stdout).toContain(path);
  });

  it("--local writes under the current working directory", async () => {
    const cwd = freshDir("lx-skill-cwd-");
    const r = await runCli(["skill", "install", "--local"], { cwd });
    expect(r.status).toBe(0);
    const path = join(cwd, ".agents/skills/lexa-cli/SKILL.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("name: lexa-cli");
    expect(r.stdout).toContain(path);
  });

  it("existing target without --force is refused, exit 1", async () => {
    const cwd = freshDir("lx-skill-cwd-");
    const path = join(cwd, ".agents/skills/lexa-cli/SKILL.md");
    mkdirSync(join(cwd, ".agents/skills/lexa-cli"), { recursive: true });
    writeFileSync(path, "pre-existing\n");
    const r = await runCli(["skill", "install", "--local"], { cwd });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(r.stderr).toContain("--force");
    expect(readFileSync(path, "utf-8")).toBe("pre-existing\n");
  });

  it("--force overwrites an existing target", async () => {
    const cwd = freshDir("lx-skill-cwd-");
    const path = join(cwd, ".agents/skills/lexa-cli/SKILL.md");
    mkdirSync(join(cwd, ".agents/skills/lexa-cli"), { recursive: true });
    writeFileSync(path, "pre-existing\n");
    const r = await runCli(["skill", "install", "--local", "--force"], { cwd });
    expect(r.status).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("name: lexa-cli");
  });

  it("--global and --local together is a usage error", async () => {
    const r = await runCli(["skill", "install", "--global", "--local"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx skill install");
  });
});
