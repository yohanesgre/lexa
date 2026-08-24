import { Effect } from "effect";
import { Sqlite } from "../db/database";
import { getSetting } from "../db/settings";
import { GitHubClient } from "../github/client";
import { selectRepoFiles, REPO_CONTENT_DEFAULTS } from "../github/repo-content";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { TaskRepo } from "../repos/task.repo";
import type { HearthTask } from "../../shared/types";

// At most N source repos per claim — app-level setting hearth_repo_cap
// (env bootstrap LXK_HEARTH_REPO_CAP, default 3; same pattern as rate limits).
export const DEFAULT_REPO_CONTENT_REPOS = 3;

export interface RepoContentEntry {
  owner: string;
  repo: string; // full "owner/repo"
  path: string;
  content: string;
}

// Best-effort linked-repo content for Hearth context (Contents: Read). Every
// failure — unconfigured app, missing repo, network, per-file errors — skips
// that repo/file with a warn; the claim NEVER fails because context is
// unavailable. Caps: ≤3 repos, ≤maxFiles files total, ≤maxTotalBytes total,
// each file truncated to maxBytesPerFile at write.
export const loadTaskRepoContent = (
  task: HearthTask
): Effect.Effect<RepoContentEntry[], never, GitHubClient | TaskRepo | ProjectReposRepo | Sqlite> =>
  Effect.gen(function* () {
    if (task.documentType !== "task") return [];
    const taskRepo = yield* TaskRepo;
    const taskRow = yield* taskRepo.findById(task.documentId).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    if (!taskRow) return [];
    // Source: the project's SOURCE-ROLE repos (admin-controlled), capped by
    // the hearth_repo_cap setting. Task-linked repos no longer feed context.
    const reposRepo = yield* ProjectReposRepo;
    const projectRepos = yield* reposRepo.listByProject(taskRow.projectId).pipe(
      Effect.catchAll(() => Effect.succeed([]))
    );
    const db = yield* Sqlite;
    const capRaw = getSetting(db, "hearth_repo_cap") || process.env.LXK_HEARTH_REPO_CAP || "";
    const capParsed = Number.parseInt(capRaw, 10);
    const cap = Number.isFinite(capParsed) && capParsed > 0 ? capParsed : DEFAULT_REPO_CONTENT_REPOS;
    const repos: string[] = [];
    for (const r of projectRepos) {
      if (r.sourceRole) repos.push(r.repo);
    }
    const capped = repos.slice(0, cap);
    if (capped.length === 0) return [];
    const client = yield* GitHubClient;
    const entries: RepoContentEntry[] = [];
    let totalBytes = 0;
    for (const fullRepo of capped) {
      const [owner, name] = fullRepo.split("/");
      if (!owner || !name) continue;
      const branch = yield* client.getDefaultBranch(owner, name).pipe(
        Effect.tapError((e) => Effect.logWarning(`[Hearth] repo-content: skip ${fullRepo}: ${e.message}`)),
        Effect.catchAll(() => Effect.succeed(""))
      );
      if (!branch) continue;
      const tree = yield* client.getRepoFileTree(owner, name, branch).pipe(
        Effect.tapError((e) => Effect.logWarning(`[Hearth] repo-content: tree failed for ${fullRepo}: ${e.message}`)),
        Effect.catchAll(() => Effect.succeed([] as { path: string; type: string; size?: number }[]))
      );
      const selected = selectRepoFiles(tree);
      for (const file of selected) {
        if (entries.length >= REPO_CONTENT_DEFAULTS.maxFiles) break;
        const content = yield* client.getRepoFileContent(owner, name, file.path).pipe(
          Effect.tapError((e) => Effect.logWarning(`[Hearth] repo-content: skip ${fullRepo}:${file.path}: ${e.message}`)),
          Effect.catchAll(() => Effect.succeed(""))
        );
        if (!content) continue;
        const truncated = content.slice(0, REPO_CONTENT_DEFAULTS.maxBytesPerFile);
        if (totalBytes + truncated.length > REPO_CONTENT_DEFAULTS.maxTotalBytes) continue;
        totalBytes += truncated.length;
        entries.push({ owner, repo: fullRepo, path: file.path, content: truncated });
      }
    }
    return entries;
  });
