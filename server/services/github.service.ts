import { Effect } from "effect";
import { GitHubClient } from "../github/client";
import { WebhookEventRepo } from "../repos/webhook-event.repo";
import { TaskRepo } from "../repos/task.repo";
import { TaskService } from "./task.service";
import { ColumnRepo } from "../repos/column.repo";
import { GithubIssueAlreadyLinked, TaskNotFound } from "../api/errors";
import { extractText } from "../../shared/tiptap-text";

export class GitHubService extends Effect.Service<GitHubService>()("Lexa/GitHubService", {
  dependencies: [GitHubClient.Default, WebhookEventRepo.Default, TaskRepo.Default, TaskService.Default, ColumnRepo.Default],
  effect: Effect.gen(function* () {
    const client = yield* GitHubClient;
    const webhookEvents = yield* WebhookEventRepo;
    const taskRepo = yield* TaskRepo;
    const taskService = yield* TaskService;
    const columnRepo = yield* ColumnRepo;

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
            // Title sync is GitHub → Lexa only (documented asymmetry).
            const title = payload.issue?.title;
            if (title) yield* taskRepo.update(task.id, { title });
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

      // Create a GitHub issue from a task and link it. One task can hold
      // multiple issues but only one per repo — duplicate repo links are
      // rejected (ALREADY_LINKED).
      createLinkedIssue: (taskId: string, repo: string) =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          if (task.githubs.some((g) => g.repo === repo)) {
            return yield* new GithubIssueAlreadyLinked({ taskId });
          }
          const issue = yield* client.createIssue(repo, task.title, extractText(task.description));
          yield* taskRepo.setGithubLink(taskId, {
            issueId: issue.nodeId,
            issueNumber: issue.number,
            repo, // stored "owner/name" — used by all future syncs
          });
          return { issueId: issue.nodeId, issueNumber: issue.number, repo };
        }),
    };
  }),
}) {}
