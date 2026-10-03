// lx skill install — write the embedded lexa-cli SKILL.md into a harness skill
// directory (global ~/.agents/skills or the project's ./.agents/skills).
import { Effect } from "effect";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promptLogin } from "./index";
// @ts-expect-error -- bun/vite inline .md as text under `with { type: "text" }`
import SKILL_MD from "../skill/lexa-cli/SKILL.md" with { type: "text" };

const USAGE = "  Usage: lx skill install [--global | --local] [--force]";

type Target = "global" | "local";

function skillTarget(target: Target): string {
  const base = target === "global" ? join(homedir(), ".agents/skills") : join(process.cwd(), ".agents/skills");
  return join(base, "lexa-cli", "SKILL.md");
}

async function promptTarget(): Promise<Target> {
  for (;;) {
    const answer = await promptLogin(
      "  Install the lexa-cli skill where?\n    1) Global (~/.agents/skills)   2) Local (./.agents/skills)\n  Choice [1/2]: "
    );
    if (answer === null) {
      console.error("  No choice made.");
      process.exit(1);
    }
    if (answer === "1") return "global";
    if (answer === "2") return "local";
    console.log("  Please enter 1 or 2.");
  }
}

export function cmdSkillInstall(flags: Record<string, string | boolean>): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const global = flags.global !== undefined;
    const local = flags.local !== undefined;
    const force = flags.force !== undefined;
    if (global && local) {
      console.error(USAGE);
      process.exit(1);
    }
    let target: Target;
    if (global) target = "global";
    else if (local) target = "local";
    else if (process.stdin.isTTY) {
      target = yield* Effect.promise(() => promptTarget());
    } else {
      console.error("  A target is required when stdin is not a TTY.");
      console.error(USAGE);
      process.exit(1);
    }
    const path = skillTarget(target);
    if (existsSync(path) && !force) {
      console.error(`  ${path} already exists. Pass --force to overwrite.`);
      process.exit(1);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SKILL_MD);
    console.log(`Installed lexa-cli skill to ${path}`);
    console.log("  Harnesses auto-discover ~/.agents/skills (global) and ./.agents/skills (project).");
  });
}
