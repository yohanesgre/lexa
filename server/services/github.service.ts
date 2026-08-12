import { Effect } from "effect";
import { GitHubClient } from "../github/client";
import { WebhookEventRepo } from "../repos/webhook-event.repo";
import { TaskRepo } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { ColumnRepo } from "../repos/column.repo";
import { TaskService } from "./task.service";
import { ProjectService } from "./project.service";
import { ActivityService } from "./activity.service";
import { GithubIssueAlreadyLinked, TaskNotFound, GithubApiError, ProjectNotFound, ColumnNotFound, SwimlaneNotFound, RequiredFieldMissing, InvalidOption, DeadlineAfterLane } from "../api/errors";
import { Sqlite, withTx, DbError, ConstraintViolation, RowNotFound } from "../db/database";
import { extractText } from "../../shared/tiptap-text";
import { docToMarkdown, markdownToDoc, normalizeMarkdownForEcho } from "../../shared/markdown";
import * as msg from "../activity-messages";
import type { Actor, ActivityEvent } from "../../shared/types";

// Short-lived per-repo cache for the autocomplete listing (core API is cheap,
// but a keystroke-per-request against GitHub is wasteful). A brand-new issue
// appears after ≤ TTL — accepted (see design edge #5).
const ISSUE_LIST_TTL_MS = 60_000;
const issueListCache = new Map<string, { at: number; items: { number: number; title: string; state: "open" | "closed" }[] }>();

export class GitHubService extends Effect.Service<GitHubService>()("Lexa/GitHubService", {
  dependencies: [GitHubClient.Default, WebhookEventRepo.Default, TaskRepo.Default, ProjectRepo.Default, ProjectReposRepo.Default, TaskService.Default, ProjectService.Default, ColumnRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const client = yield* GitHubClient;
    const webhookEvents = yield* WebhookEventRepo;
    const taskRepo = yield* TaskRepo;
    const projectRepo = yield* ProjectRepo;
    const reposRepo = yield* ProjectReposRepo;
    const taskService = yield* TaskService;
    const projectService = yield* ProjectService;
    const columnRepo = yield* ColumnRepo;
    const activityService = yield* ActivityService;
    const db = yield* Sqlite;

    return {
      // ---- Lexa → GitHub (called by ROUTES after a successful move) ----
      // Pushes state per linked issue, then records what we pushed so the
      // resulting webhook echo is recognized and skipped.
      syncStateFromLexa: (taskId: string, columnGithubState: "open" | "closed") =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          for (const issue of task.githubs) {
            // repo comes from the STORED link ("owner/name" captured at link
            // time) — never parsed out of an html_url, never assumed to be
            // project.github_repo
            yield* client.updateIssueState(issue.repo, issue.issueNumber, columnGithubState);
            yield* taskRepo.setGithubSyncedState(taskId, issue.issueId, columnGithubState);
          }
        }),

      // ---- Lexa → GitHub content sync (title + body, asymmetric) ----
      // Called after a task save. Diffs the task's current title/description
      // against what we last pushed per link (pushed_* echo columns): nothing
      // to push when they match. Pushes to ALL linked issues, then records the
      // outcome — success stores the pushed values (webhook echo detection),
      // failure only flags push_failed so the next save retries naturally.
      syncContentFromLexa: (taskId: string) =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          const body = docToMarkdown(task.description);
          const links = yield* taskRepo.findGithubLinks(taskId);
          for (const link of links) {
            const titleChanged = normalizeMarkdownForEcho(link.pushed_title) !== normalizeMarkdownForEcho(task.title);
            const bodyChanged = normalizeMarkdownForEcho(link.pushed_body) !== normalizeMarkdownForEcho(body);
            if (!titleChanged && !bodyChanged) continue;
            yield* client.updateIssueContent(link.repo, link.issue_number, { title: task.title, body }).pipe(
              Effect.tap(() => taskRepo.setPushedContent(taskId, link.issue_id, task.title, body, false)),
              Effect.catchAll((e) =>
                taskRepo.setPushedContent(taskId, link.issue_id, null, null, true).pipe(
                  Effect.tap(() => Effect.logWarning(`[GitHub] content push failed for task ${taskId} issue ${link.issue_id}`, e))
                )
              )
            );
          }
        }),

      // ---- GitHub → Lexa (webhook processing) ----
      // The route acks GitHub immediately (200); processing runs in the
      // background (Bun has no waitUntil — ack first, then process). GitHub
      // retries on delivery failure; since delivery is recorded only AFTER
      // success, a mid-processing crash leaves the event unrecorded and the
      // retry reprocesses it. All handlers are idempotent.
      handleWebhook: (deliveryId: string, event: string, payload: { action?: string; issue?: { node_id?: string; title?: string } }) =>
        Effect.gen(function* () {
          // 1. Cheap pre-check; the authoritative recordDelivery happens AFTER
          //    successful processing (see step 6).
          if (yield* webhookEvents.isSeen(deliveryId)) return;

          // 2. GitHub sends X-GitHub-Event "issues" with the transition in
          //    payload.action (closed/reopened/edited) — compose the
          //    "issues.<action>" form and only handle those three.
          const action = payload.action ?? "";
          if (event !== "issues" || (action !== "closed" && action !== "reopened" && action !== "edited")) return;
          const nodeId = payload.issue?.node_id;
          if (!nodeId) return;

          const task = yield* taskRepo.findByGithubIssue(nodeId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          if (!task) {
            // Issue not linked to any task — nothing to process, but the
            // delivery succeeded: record so GitHub stops retrying it.
            yield* webhookEvents.recordDelivery(deliveryId);
            return;
          }

          if (action === "edited") {
            // Content sync, GitHub → Lexa (title + body), echo-suppressed.
            // The edited payload carries the new TITLE but not the body — the
            // body always comes from an API fetch.
            const title = payload.issue?.title;
            if (!title) {
              yield* webhookEvents.recordDelivery(deliveryId);
              return;
            }
            const links = yield* taskRepo.findGithubLinks(task.id);
            const link = links.find((l) => l.issue_id === nodeId);
            if (!link) {
              yield* webhookEvents.recordDelivery(deliveryId);
              return;
            }
            const actor: Actor = { kind: "system", label: "github", userId: null };

            // Echo check: our pushes always send title+body together, so a
            // title match alone is NOT proof of echo — skip only when BOTH
            // fetched values match what we last pushed (normalized at the
            // string edges; GitHub normalizes boundary whitespace).
            const fetched = yield* client.getIssue(link.repo, link.issue_number).pipe(
              Effect.catchAll(() => Effect.succeed(null))
            );
            if (fetched) {
              const isEcho =
                normalizeMarkdownForEcho(link.pushed_title) === normalizeMarkdownForEcho(fetched.title) &&
                normalizeMarkdownForEcho(link.pushed_body) === normalizeMarkdownForEcho(fetched.body);
              if (isEcho) {
                yield* webhookEvents.recordDelivery(deliveryId);
                return;
              }
              // External edit — apply title + description (Markdown → TipTap).
              // field_changed rows are emitted inside the update, in the same
              // transaction (emission invariant).
              yield* taskService.update(actor, task.id, {
                title: fetched.title,
                description: markdownToDoc(fetched.body),
              }).pipe(
                Effect.catchAll((e) => Effect.logWarning(`[GitHub] webhook edit apply failed for task ${task.id}`, e))
              );
              yield* webhookEvents.recordDelivery(deliveryId);
              return;
            }

            // GET failed (network/rate limit) — title-only fallback: compare
            // the payload title against what we pushed; differ → apply title
            // only, body update skipped (divergence surfaces via the badge).
            if (normalizeMarkdownForEcho(link.pushed_title) !== normalizeMarkdownForEcho(title)) {
              yield* taskService.update(actor, task.id, { title }).pipe(
                Effect.catchAll((e) => Effect.logWarning(`[GitHub] webhook edit apply failed for task ${task.id}`, e))
              );
            }
            yield* webhookEvents.recordDelivery(deliveryId);
            return;
          }

          const incomingState = action === "closed" ? "closed" : "open";

          // 3. ECHO SUPPRESSION (per link): we already pushed this exact
          //    state → skip.
          const link = task.githubs.find((g) => g.issueId === nodeId);
          if (link && link.syncedState === incomingState) return;

          // 4. Column lookup by explicit mapping — never by name
          //    (renaming "Done" → "Shipped" can't break sync).
          const columns = yield* columnRepo.findByProject(task.projectId);
          const target = columns.find((c) => c.githubState === incomingState);
          if (!target) return; // no mapped column → no-op

          // 5. Webhook moves bypass WIP limits and required_fields
          //    (log-and-skip semantics: robots ≠ humans). Move + synced-state
          //    write execute as ONE SQLite transaction (batch helper) — atomic.
          yield* taskService.moveFromWebhook(nodeId, target.id, incomingState);

          // 6. Record delivery only AFTER success (see step 1).
          yield* webhookEvents.recordDelivery(deliveryId);
        }),

      // ---- Issue picker data (autocomplete backing) ----
      // Repo-first: only workspace repos of the project are searchable. The
      // per-repo list endpoint (core API ~5000 req/hr — NOT the search API,
      // no index lag) is cached ~60s. Text filter runs over the recent 100
      // issues; an exact #number misses the list (e.g. brand-new or ancient)
      // → direct issue GET fallback.
      listWorkspaceIssues: (slug: string, repo: string, query?: string): Effect.Effect<{ number: number; title: string; state: "open" | "closed" }[], ProjectNotFound | DbError | GithubApiError> =>
        Effect.gen(function* () {
          const repos = yield* projectService.listRepos(slug);
          if (!repos.some((r) => r.repo === repo && r.workspaceRole)) {
            return yield* new GithubApiError({ message: `Repo '${repo}' is not a workspace repo of this project` });
          }
          const now = Date.now();
          const cached = issueListCache.get(repo);
          let items = cached && now - cached.at < ISSUE_LIST_TTL_MS ? cached.items : null;
          if (!items) {
            const [owner, name] = repo.split("/");
            items = yield* client.listIssues(owner, name);
            issueListCache.set(repo, { at: now, items });
          }
          const q = (query ?? "").trim();
          if (!q) return items;
          const num = /^#?(\d+)$/.exec(q);
          if (num) {
            const n = Number(num[1]);
            const hit = items.find((i) => i.number === n);
            if (hit) return [hit];
            const issue = yield* client.getIssue(repo, n).pipe(
              Effect.map((i) => ({ number: i.number, title: i.title, state: i.state })),
              Effect.catchAll(() => Effect.succeed(null))
            );
            return issue ? [issue] : [];
          }
          const needle = q.toLowerCase();
          return items.filter((i) => i.title.toLowerCase().includes(needle));
        }),

      // Create a GitHub issue from a task and link it. One task can hold
      // multiple issues but only one per repo — duplicate repo links are
      // rejected (ALREADY_LINKED). The target repo must be a workspace repo
      // of the task's project (roles gate NEW links only).
      createLinkedIssue: (actor: Actor, taskId: string, repo: string): Effect.Effect<{ issueId: string; issueNumber: number; repo: string; activity: ActivityEvent[] }, TaskNotFound | GithubIssueAlreadyLinked | GithubApiError | ConstraintViolation | DbError | RowNotFound | ProjectNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          if (task.githubs.some((g) => g.repo === repo)) {
            return yield* new GithubIssueAlreadyLinked({ taskId });
          }
          const project = yield* projectRepo.findById(task.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: task.projectId }))
          );
          const repos = yield* reposRepo.listByProject(project.id);
          if (!repos.some((r) => r.repo === repo && r.workspaceRole)) {
            return yield* new GithubApiError({
              message: `Repo '${repo}' is not a workspace repo of this project`,
            });
          }
          const issue = yield* client.createIssue(repo, task.title, extractText(task.description));
          return yield* withTx(db, Effect.gen(function* () {
            yield* taskRepo.setGithubLink(taskId, {
              issueId: issue.nodeId,
              issueNumber: issue.number,
              repo, // stored "owner/name" — used by all future syncs
            });
            const ev = yield* activityService.append(taskId, actor, "github_linked", msg.githubLinked(repo, issue.number));
            return { issueId: issue.nodeId, issueNumber: issue.number, repo, activity: [ev] };
          }));
        }),

      // Link an EXISTING GitHub issue to a task (the autocomplete flow). The
      // repo must be a workspace repo; the issue must not already be linked to
      // any task (UNIQUE(issue_id)); a task holds at most one link per repo.
      linkExistingIssue: (actor: Actor, taskId: string, repo: string, issueNumber: number): Effect.Effect<{ issueId: string; issueNumber: number; repo: string; activity: ActivityEvent[] }, TaskNotFound | GithubIssueAlreadyLinked | GithubApiError | ConstraintViolation | DbError | RowNotFound | ProjectNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          if (task.githubs.some((g) => g.repo === repo)) {
            return yield* new GithubIssueAlreadyLinked({ taskId });
          }
          const project = yield* projectRepo.findById(task.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: task.projectId }))
          );
          const repos = yield* reposRepo.listByProject(project.id);
          if (!repos.some((r) => r.repo === repo && r.workspaceRole)) {
            return yield* new GithubApiError({
              message: `Repo '${repo}' is not a workspace repo of this project`,
            });
          }
          const issue = yield* client.getIssue(repo, issueNumber);
          const alreadyLinked = yield* taskRepo.findByGithubIssue(issue.nodeId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          if (alreadyLinked) {
            return yield* new GithubIssueAlreadyLinked({ taskId: alreadyLinked.id });
          }
          return yield* withTx(db, Effect.gen(function* () {
            yield* taskRepo.setGithubLink(taskId, {
              issueId: issue.nodeId,
              issueNumber: issue.number,
              repo,
            });
            const ev = yield* activityService.append(taskId, actor, "github_linked", msg.githubLinked(repo, issue.number));
            return { issueId: issue.nodeId, issueNumber: issue.number, repo, activity: [ev] };
          }));
        }),

      // Pick up a GitHub issue as a Lexa task: creates the task (title from
      // the issue, description from the body via Markdown → TipTap) in the
      // project's first column, then links it. required_fields behave exactly
      // like a normal create — no special-casing. An issue already linked to
      // ANY task is rejected (UNIQUE(issue_id)).
      createTaskFromIssue: (actor: Actor, slug: string, repo: string, issueNumber: number): Effect.Effect<{ taskId: string; activity: ActivityEvent[] }, ProjectNotFound | GithubApiError | GithubIssueAlreadyLinked | ColumnNotFound | SwimlaneNotFound | TaskNotFound | RequiredFieldMissing | InvalidOption | DeadlineAfterLane | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const project = yield* projectService.findBySlug(slug);
          const repos = yield* reposRepo.listByProject(project.id);
          if (!repos.some((r) => r.repo === repo && r.workspaceRole)) {
            return yield* new GithubApiError({
              message: `Repo '${repo}' is not a workspace repo of this project`,
            });
          }
          const issue = yield* client.getIssue(repo, issueNumber);
          const alreadyLinked = yield* taskRepo.findByGithubIssue(issue.nodeId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          if (alreadyLinked) {
            return yield* new GithubIssueAlreadyLinked({ taskId: alreadyLinked.id });
          }
          const columns = yield* columnRepo.findByProject(project.id);
          if (columns.length === 0) {
            return yield* new ColumnNotFound({ id: "first" });
          }
          const first = [...columns].sort((a, b) => a.position - b.position)[0];
          const { task } = yield* taskService.create(actor, {
            projectId: project.id,
            columnId: first.id,
            title: issue.title,
            description: markdownToDoc(issue.body),
          });
          const ev = yield* withTx(db, Effect.gen(function* () {
            yield* taskRepo.setGithubLink(task.id, {
              issueId: issue.nodeId,
              issueNumber: issue.number,
              repo,
            });
            return yield* activityService.append(task.id, actor, "github_linked", msg.githubLinked(repo, issue.number));
          }));
          return { taskId: task.id, activity: [ev] };
        }),
    };
  }),
}) {}
