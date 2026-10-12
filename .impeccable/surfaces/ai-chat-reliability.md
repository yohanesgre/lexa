---
version: 1
slug: "ai-chat-reliability"
primary_target: "app/components/chat/AssistantChatPage.tsx"
related_targets: ["app/components/chat/AssistantChatComposer.tsx", "app/components/chat/AssistantChatTurns.tsx", "app/components/chat/AssistantBubble.tsx", "app/components/chat/AssistantChatShell.tsx", "app/components/chat/AssistantApprovals.tsx", "app/components/chat/AssistantApprovalChipRow.tsx", "app/components/chat/AssistantResumeProgress.tsx", "app/components/chat/AssistantGeneratedPanel.tsx", "app/components/chat/AssistantDiffBody.tsx", "app/components/chat/assistant-chat-session.ts", "app/components/chat/assistant-chat-turns-state.ts", "app/components/chat/assistant-chat-logic.ts", "app/components/chat/assistant-chat-utils.ts", "app/components/chat/useChatQueue.ts", "app/lib/use-assistant-stream.ts", "app/lib/assistant-image.ts"]
---

# AI chat reliability: surface state brief

## Direction and authority

Mode: Operate. This is a narrow refinement of existing PHOSPHOR chat, not a visual redesign. The user needs to read what Assistant produced, understand whether work finished, and choose a safe next action when delivery, attachments, or writes fail.

Reading this as: project chat for small self-hosting teams, in existing PHOSPHOR, with ENERGY 1 / RHYTHM 1 / MOTION 1. Antislop active: during (global preference).

`DESIGN.md` frontmatter is normative and remains the only token source. `.impeccable/design.json` supplies supplementary component/motion guidance, not replacement tokens. `PRODUCT.md`, accepted ADR-0005/ADR-0006 in `docs/ARCHITECTURE.md:252-274`, and the approved ai-chat-reliability plan govern behavior. The approved availability correction is in `PRODUCT.md`: the in-process TanStack AI engine serves both Workers and local Bun; the optional Workers chat supervisor is opt-in, not another engine.

Preserve shell, thread sidebar, header, composer placement, transcript column, existing generated-content viewer, and all navigation. No assets, provider wizard, new screen/drawer, new state store, endpoint, wire field, error code, or token family. Existing generated-content drawer is retained, not recreated. No change to sticky `ask` / `auto` / `deny` semantics.

Impeccable context reported a stale sidecar. The shell brief also contains older day-theme values and phone-band geometry. Do not copy those into this brief or repair them here: current `DESIGN.md` wins, and this lane does not touch shell geometry or tokens. Runtime rendering, contrast, and Delivery Gate evidence belong to the coordinator's integrated verification; this document is a design handoff, not proof of a passing UI.

## Regions and existing component map

Paths below identify existing ownership seams, not permission to expand a worker's assigned file scope.

| Region | Exact location and content order | Existing component/reference |
| --- | --- | --- |
| R1: composer | `.chat-deck`: existing rail and rail hint; existing queued-message row; message textarea; attachment strip and readiness feedback; footer status and actions. | `AssistantChatComposer.tsx:352-469,869-1038`; `ChatComposerArea` in `AssistantChatShell.tsx:407-538`. |
| R2: response | `.chat-scroll` / `.bubble-ai`: metadata and Copy reply; existing activity; answer text/code; turn-local terminal notice and recovery action; existing approval batch and citations. Keep these in one turn, not a separate error bubble. | `StreamingBubble` in `AssistantChatTurns.tsx:194-221`; `AssistantBubble.tsx:153-235`; transcript composition in `AssistantChatShell.tsx:344-403`. |
| R3: approval and continuation | Existing `.approval-batch`: proposal header/tally; ordered cards with target and diff; decision actions. Existing `.resume-progress` stays between proposal turn and continuation slot, never a third reply bubble. | `AssistantApprovalBatch` in `AssistantApprovals.tsx:34-362`; `ApprovalChipRow` in `AssistantApprovalChipRow.tsx:85-127`; `AssistantResumeProgress.tsx:27-66`. |
| R4: generated content | Existing `Generated content` viewer and header toggle. Target above full body/unified diff; existing void when nothing generated. | `AssistantGeneratedPanel.tsx:19-39`; `AssistantDiffBody.tsx:68-103,124-147`; shared `DiffView` imported there. |
| R5: configuration/access feedback | Existing provider-missing slot or current thread's inline notice. Do not replace other readable history with a full-page error after a turn failure. | `ChatProviderMissingPanel` in `AssistantChatTurns.tsx:21-44`; `AssistantErrorPanel` in `AssistantBubble.tsx:17-66`; settings destination in `app/routes/settings/project.$projectId.tsx:7-14`. |

Implementation order: preserve/converge turn content and terminal metadata; enforce attachment readiness on every submission path; distinguish recovery actions; reconcile approval and write results; apply permission-aware guidance; integrate existing page props only where required. `assistant-chat-session.ts`, `assistant-chat-turns-state.ts`, `assistant-chat-logic.ts`, `assistant-chat-utils.ts`, `useChatQueue.ts`, and `use-assistant-stream.ts` remain the existing state/transport seams. Do not introduce a parallel UI store.

Source findings that the frontend owner must account for before changing files:

- `AssistantBubble.tsx:194-233` currently selects error OR content, hiding a failed partial answer. This existing renderer must render answer AND notice.
- `AssistantChatShell.tsx:378-398` owns the settled bubble and resume wiring. `AssistantChatTurns.tsx` alone does not own settled error rendering.
- `AssistantChatComposer.tsx:695-755,860-861` filters ready files, but retained uploading/failed files must also block acceptance and dispatch.
- `AssistantApprovalChipRow.tsx:39-44` displays approval decision labels, not proof of application. `Approved` must not mean `Applied`.
- `assistant-chat-utils.ts:157-160` and `AssistantBubble.tsx:29` include unconditional nothing-added language. Remove that claim for partial/accepted failures.
- `app/lib/assistant-image.ts:108-112` owns named file feedback. Preserve its existing named extraction error unless a scoped copy change is authorized; the readiness notice and explicit Remove action supply recovery without silently dropping the file.

The plan's W3 file list omits some of these existing render/copy seams. The coordinator must settle frontend file authorization before implementation; do not invent replacement components to evade the file boundary.

Full-diff selection is part of A8, not a new viewer: `AssistantChatPage.tsx:681-683` currently chooses the newest proposal, while `AssistantDiffBody.tsx:58-62` intentionally summarizes create bodies inside cards. For a multi-proposal batch, existing carousel paging/focus must make the active proposal's full body/diff available in the existing Generated content viewer, with matching target. On phones, the existing Generated content toggle opens that proposal; returning to approval preserves its selection. Do not approve an earlier proposal while its only full-content view still shows the newest proposal. Keep current newest-proposal following until the user selects a card; no new navigation, preview control, or persistence store.

## Surface<C, V, N>

### C: successful content flow

```text
Configured, permitted project + selected or freshly minted owned chat
  => existing landing or restored transcript
  => draft + retained attachments
  => every retained attachment ready, or user explicitly removes it
  => Send (or existing Queue while the current turn is busy)
  => accepted turn / Connecting to Assistant…
  => incremental answer / Assistant is replying… / Stop
  => terminal done with preserved answer

ask + actual write proposal
  => existing proposal cards + full generated-content diff
  => Approve or Reject each proposal
  => all decisions settled
  => existing automatic resume for that exact batch
  => authoritative per-write results + continuation

auto + actual write
  => existing tool/result rows, without approval suspension
  => actual application/failure results + answer

deny + attempted write
  => refusal reported by existing tool/result path
  => no execution and no approval control
```

The transcript is many ordered turns; only the current turn is live. Attachments are retained per-message units. Approval cards are ordered per-batch units. Generated content is one selected proposal's full body/diff using the existing selection behavior. Never infer an absent proposal from a failed history/settings read.

### V: interruption flow

```text
Unresolved retained attachment => named file/error + readiness notice; no send/dispatch
Refused or failed before ingress => draft/files remain recoverable; no false completed turn
Failure after content => same turn's partial answer + terminal notice + eligible recovery
Explicit Stop => same turn's partial answer + Reply stopped.; queued follow-up remains held
Approval decision/resume failure => same batch + actual decision/results + Resume when eligible
Same-turn replay in flight => existing content + Reconnecting to the current reply…
Unavailable replay buffer => canonical available history; no restarted generation or write
Denied/missing existing thread => This conversation is unavailable.; no foreign content
```

### N: needs and trust boundaries

- R1 needs the current owned chat/project and existing attachment capability. Every retained file must be ready with a usable storage reference. A file labelled ready without that reference is unresolved, not silently omitted.
- R2 needs authorized history/live frames plus the current turn identity. Failure, stop, and reload must converge to one partial response, never append the same partial text twice. EOF without terminal settlement is not completion.
- R3 needs an owner/project/thread-bound batch and authoritative decisions/results. A claim or approved decision alone is not proof of a domain change. Another tab's decision is authoritative; an old/foreign batch must not be replaced with the newest batch.
- R4 needs the real proposal/diff. Loading, failed, denied, and empty are not interchangeable; do not show a fabricated full diff or enable approval before required proposal data is available.
- R5 needs a settled provider/settings read and the user's actual permission to manage Assistant configuration. Loading/error is not not-configured. Unknown permission does not expose an admin link.
- Same-turn replay needs an actual running authorized reconnect operation. The default in-process path does not promise live recovery across reload. ADR-0006 replay is volatile; eviction/redeploy does not authorize regeneration or repeated writes.

## Allowed states and copy

States below are presentation mappings of existing lifecycle/data, not new protocol enum values. Existing stream values are `idle`, `connecting`, `streaming`, `suspended`, `done`, `error`, `aborted` (`use-assistant-stream.ts:68`). A reconnect label requires observable in-flight delivery work, not a new backend flag invented by the UI.

| State | Region and exact visible copy | Actions and behavior |
| --- | --- | --- |
| Empty configured chat | R1/R2: existing `What should we get done?`, `Reads this project's tasks, wiki and activity.` Existing starter strings stay unchanged. | Existing starter chips prefill, never submit (`ChatLanding.tsx:9-25`). |
| Loading/submitting | R1 footer: `Connecting to Assistant…` | Preserve draft/files until acceptance; preserve recovery snapshot through pre-ingress failure. Do not dispatch a conflicting turn. Stop uses the existing cancellation path where supported. |
| Streaming | R1 footer: `Assistant is replying…`; R2 shows incremental text/activity. | `Stop` remains visible. No success statement before terminal settlement. Existing Queue remains a separate held-follow-up action, not concurrent generation. |
| Reconnecting | R1 footer: `Reconnecting to the current reply…`; R2 keeps received text. | Only during real same-turn replay/reconnect. Keep existing Stop available when it can reach that run. Never label regeneration as reconnect. |
| Partial failure | R2, immediately after retained answer: `The reply stopped before it finished.` Then safe catalog guidance if useful. | `Retry` only under the recovery rules below. Preserve Copy reply for available text. Do not replace partial content with an error-only panel. |
| Failure with no answer | R2: safe existing error-catalog guidance for the actual failure; no empty fake answer block. | Preserve draft/files for refusal/pre-ingress failure. Apply Retry/settings/auth recovery according to actual cause and permission. Never say nothing was added unless non-acceptance is established. |
| Stopped | R2, immediately after retained answer: `Reply stopped.` | No rollback/undo claim. Eligible `Retry` starts another attempt, not continuation. No Stop after settlement. Held queued message is not automatically dispatched by this stop. |
| Uploading | R1 attachment area: named upload chip with measured progress when available. Readiness notice: `Wait for attachments to finish uploading.` | Block Send, Enter submission, Queue acceptance, held Send and automatic queued dispatch. Existing cancel/remove aborts that upload and explicitly removes the chip. |
| Attachment failure | R1: existing named upload-failure message. Readiness notice: `Retry or remove the failed attachment before sending.` | Existing file `Retry` retries that file; `Remove` explicitly removes it. Retain all other files and draft. Disable Send/Queue/dispatch until all retained files resolve. |
| Extraction failure | R1: existing `Couldn't read {filename} — text extraction failed. Remove it to send.` | Retain named unreadable file and original draft. Existing explicit `Remove` unblocks only when remaining files are ready. A real existing file retry may return it to unresolved/uploading; it never implicitly submits. No new extraction endpoint. |
| Approval pending/suspended | R3: existing full proposal/target/diff and pending tally. Existing `Approve`, `Reject`, `Approve all`, `Reject all`, and `Review` control remain. | `ask` executes nothing before decisions. Locked/in-flight cards cannot decide twice. Generated-content viewer must expose the full content before approval, not just a body-summary count. |
| Resuming batch | R3: existing `Executing approved writes…` on approve path; existing `Assistant is working…` on rejection continuation. | Existing automatic exact-batch resume remains. Do not add an extra approval or mandatory Resume click to the happy path. |
| Resume failure/long wait | R3: existing `Resume failed.` or `Resume is taking longer than expected.` | Recovery button visibly says `Resume`, not turn `Retry`. Available only for the existing safely eligible exact batch; never while the same dispatch is running. Reconcile results before offering another execution. |
| Applied/failed/partial write | R3 and existing tool/result rows: actual target plus `Applied` or `Failed` when supported by authoritative results; `Approved`, `Rejected`, `Approval expired` remain decision labels. | Partial means mixed real results, not a new stored status. Keep per-write outcomes and safe error catalog guidance. Successful auto writes must not become blanket `No changes`. Do not infer application from approval alone or from a completed provider answer. |
| Provider not configured | R5: `Assistant is not configured for this project.` | Permitted admin gets existing `Open Settings`, destination `/settings/project/$projectId`, Assistant provider section. Member gets `Ask a workspace admin to configure Assistant.` No inaccessible settings link. |
| Provider/auth error | R2: safe existing catalog message without provider payload/credentials. | Provider authentication failure offers the same permitted settings route or member guidance. Session authentication failure follows existing sign-in recovery, not provider settings or blind repeated Retry. Retain locally owned draft; do not expose unauthorized history. |
| Denied/missing existing thread | R5: `This conversation is unavailable.` | No title/messages/files from another owner/project; no retry/resume/cancel capability for that thread. Existing New chat navigation remains. A locally minted unsent chat with no server row still uses the normal landing, not this denial state. |
| Long content | All regions: real text/names/diff, without replacement copy. | Wrap ordinary text/status/actions; scroll code/tables/diffs internally; retain full accessible names and all attachment controls. Never widen the page or clip a recovery action. |

Readiness precedence: retained failed/unreadable files show their named errors and the failed-attachment recovery notice; retained uploads also keep their progress visible. With only uploads unresolved, show the uploading notice. With all files ready or explicitly removed, remove the readiness notice. Dismissing an input rejection message does not remove a retained failed/unreadable file. Loading/streaming status and readiness may coexist because they describe different work.

## Recovery actions and write-risk contract

- `Retry` on a failed/stopped turn starts a new attempt from that turn's actual triggering user message and original ready attachment refs. It does not claim to continue the partial sentence, resume approval execution, reconnect delivery, roll back writes, or safely regenerate a known committed/indeterminate write.
- Before any tool execution boundary, the existing safe retry/fallback policy may apply. After visible output, preserve partial text and settle failure; do not merge a second provider's answer into it.
- Suppress turn Retry/regenerate whenever a write executed or its outcome is indeterminate. Keep actual write/result rows visible. When recovery could otherwise be mistaken for rollback, show this plain supporting sentence in the same notice: `Changes already applied are not undone.` Use the existing domain surface to inspect actual results; do not add an unsafe retry-write action or a new confirmation flow.
- `Resume` recovers the existing suspended/decided batch via `/api/assistant/chat/:chatId/resume` with its exact `batchId`. It creates no new user turn. The server's existing claim protects that batch; the UI must not advertise a replay of already applied/indeterminate writes. No-op/settled outcomes reconcile history, release transient UI busy state, and leave the next legitimate Send usable.
- `Stop` cancels the current run through its actual transport/cancel path. Preserve text and authoritative completed mutations. It does not delete a turn, remove attachments from an accepted message, reject unrelated approvals, or undo applied changes.
- Reconnect is delivery of the current run, never a new turn or approval Resume. When its volatile buffer is unavailable, end the reconnect wait and restore available canonical transcript safely. Do not invent guaranteed continuation or leave a permanent spinner.
- A history-read `Retry` repeats the history read only. A file `Retry` repeats that file operation only. Accessible names disambiguate these actions from turn Retry even when visible labels stay short.
- Existing Queue keeps one follow-up. Readiness is checked at acceptance AND every dispatch, including automatic flush. A refused acceptance keeps draft/files; blocked queued dispatch keeps its queued content plus retained file feedback. Recovery of a file does not silently resend a stopped/failed held turn. Do not automatically remove a failed file or send only the ready subset.

## Primitives, tokens, hierarchy and motion

Use the existing component tree and PHOSPHOR primitives. `docs/design-system.html:6671-6676` defines button variant markup; `:6706-6712` defines sizes/icon-button anatomy. Copy the existing inline notice icon/span anatomy at `:6784-6787`; `.notice` dimensions are at `:3049-3058`. Reuse the installed notice styling, not the frozen artifact's old raw color values.

No second token/value table is introduced here. Bind colors to normative `DESIGN.md` roles through existing `--lx-text-primary`, `--lx-text-secondary`, `--lx-text-muted`, `--lx-text-danger`, `--lx-bg-danger-subtle`, `--lx-border-default`, `--lx-border-focus`, and the established surface/spacing families. Warning/success feedback uses existing semantic roles, not an extra palette. Both themes consume those tokens; no raw colors or local overrides for day/night.

- Answer remains the focus: retain existing `.bubble-md` prose and code anatomy, reading measure and type size. Terminal status is a subordinate inline notice after the answer, not a replacement card or louder heading. Copy reply copies the available answer, not error guidance.
- Error/attachment blocking feedback uses `.notice notice-danger` with a relevant existing alert icon and real text. Stopped status is neutral; failed delivery is danger. Loading/reconnect status is neutral plain text, never a success stamp. Status/help/action labels use the existing Guide body role, not a new tiny uppercase Surveyor heading. Surveyor remains for measured time/count/code.
- Newly composed notice/action relationships use existing space-2 between actions and space-2 between answer and terminal notice. Preserve existing notice padding/radius/icon dimensions verbatim; preserve inherited bubble/composer/approval padding and borders. Flat surfaces, no added shadow or decorative stripe.
- `Send` remains the composer's primary action; `Approve` remains the pending proposal's primary action. Turn/file Retry and Resume use ghost buttons. Stop uses the existing quiet ghost treatment; no solid destructive-confirm styling. Hide inapplicable actions rather than leaving misleading inactive capabilities.
- No new entrance, animated error, pulsing state dot, asset, font, CDN, or decorative badge. State content changes immediately. Existing button background/border feedback uses the sidecar's button-state duration (100ms) and installed easing; existing row feedback is 120ms linear. Do not alter existing shell/drawer motion. Under reduced motion, transitions/programmatic smooth scrolling snap and loading movement stops; status text remains.

## Interaction, keyboard, mobile and themes

| Interaction state | Required treatment |
| --- | --- |
| Default | Readable status with only eligible actions; ready attachments remain named. No turn Retry or Resume on a successfully completed response. |
| Hover | Existing PHOSPHOR tonal treatment only; no hover-only access to recovery, attachment Remove, or full diff. |
| Focus-visible | Existing 2px `--lx-border-focus` outline with 2px offset for controls; keep composer focus visibly indicated by its current focus-within treatment. No clipped focus ring. |
| Active | Existing pressed fill. One activation dispatches one operation; prevent duplicate submission while operation owns the action. |
| Disabled | Existing muted/non-hover state. Explain readiness/busy reason in persistent nearby text, not tooltip-only. Stop remains independently available for a supported active run. |
| Loading | Plain real-operation text; do not disable editing/removal that remains safe. Preserve input through refusal and pre-ingress failure. |
| Error/partial/stopped | Answer then state/recovery, with both available to assistive technology; never color-only or toast-only. |
| Empty | Existing landing or generated-content void, no fabricated response/proposal. |
| Long content | Content-driven height, wrapping status/error text, reachable actions and internally contained wide content. |

Keyboard: keep `Message Assistant` accessible label and existing mention behavior. Enter submits only if ready; Shift+Enter inserts a newline; IME composition does not submit. Apply identical guards to keyboard and buttons. Tab order follows source/visual order: transcript Copy/recovery and proposal controls, resume row, composer rail/queue/message/file controls/footer. Enter/Space activate buttons. Preserve existing approval carousel arrow-key paging and focus on the next pending card. In-flight/disabled actions do not receive duplicate activation. If a focused file is removed, focus returns to a remaining relevant file control or composer, never the page root.

Announce lifecycle status changes once through existing polite status/live regions. Announce blocking attachment errors once at their file/notice. Do not announce every token, elapsed second, percentage tick, or repeat the entire partial answer on every delta. Retain the transcript's log semantics; failed/stopped partial content stays readable and copyable after settlement and reload.

Geometry is inherited, not reauthored: existing desktop column/measure at 1440, tablet behavior at 768–1023.98, phone behavior below 768 (390 acceptance), threads pane behavior below 1024, and generated-content viewer's existing in-flow-at-1280/drawer-below-1280 split. Read shell dimensions from current `DESIGN.md`/installed tokens, not older shell-rail numbers. Do not create another responsive panel.

At 390, status wraps before actions; recovery/file action groups wrap as units with existing space-2 gaps. Touch targets are at least 44 by 44px; existing compact visual controls may use that hit area without changing shell geometry. Desktop actions retain existing primitive sizing, minimum 32px hit targets. Long filenames may wrap; if an existing name truncates visually, preserve its full accessible name and keep Retry/Remove outside the clipped area. Use shrinkable content regions, never page-wide horizontal scroll. Preserve composer clearance and safe-area handling so the last notice/actions remain reachable above the on-screen keyboard. Full diff content remains obtainable through the existing Generated content control before approval at mobile widths; Escape/backdrop closes the existing viewer and returns focus to its trigger.

Both night and day themes must retain semantic contrast, focus and legible disabled/busy states. Text/placeholder contrast must meet 4.5:1 and necessary control/focus indicators 3:1 against adjacent surfaces. Do not claim contrast from a token name: the coordinator measures actual composited notice/button states. Verify 200% zoom without clipping and reduced motion without losing status or actions.

## Acceptance hooks and evidence owner

These are required integration checks, not executed results. The coordinator owns browser, tests, detector, antislop Delivery Gate, and the final full gate after the wave settles. Extend existing behavioral cases; no new source-text/copy/px/class/style pins.

- A6 / S7: delay upload, fail upload, unreadable PDF, mixed ready/unresolved files. Try Send, Enter, Queue, held Send, automatic queued dispatch. No unresolved file is omitted; explicit Retry/Remove works; refused/pre-ingress send keeps draft/files; accepted attachments remain visible after reload. Hook existing `app/components/chat/assistant-chat-utils.test.ts`, `useChatQueue.test.tsx`, and `server/api/http-assistant-attachments.test.ts`.
- A7 / S3–S5,S8,S10: fail before ingress, after partial delta, and after a tool boundary; Stop during a live turn; then send a legitimate next turn. Partial answer and status stay together, live/history convergence shows one answer, EOF is not done, distinct Retry/Resume/Stop behavior matches this brief. Provider/member/admin/session guidance has a real permitted route without raw diagnostics. Hook `app/lib/use-assistant-stream.test.ts` and existing `assistant-chat-utils.test.ts`.
- A8 / S6,S8: read the full create body/edit diff before ask approval at desktop/mobile. Approve/reject/expire/deny; successful auto write; one failed write among applied writes; simultaneous exact-batch resume from two tabs; committed/indeterminate failure. Stored domain state matches each displayed result; approval is not application; rejected/expired/denied writes do not execute; Retry does not silently repeat or undo a write. Hook existing `server/services/assistant-chat.service.test.ts`, `server/assistant/build-stream.test.ts`, and `server/assistant/write-tools.test.ts`.
- A11 / S10: exercise every table state at 1440 and 390, both themes, keyboard only and reduced motion. Capture status/error/partial text, retained file controls, full diff accessibility, focus order, action hit targets and no overflow/clipping. Include a middle-width pass while preserving existing shell behavior. Check console errors. Record actual snapshots, contrast measurements and observed interaction outcomes, not compilation-based visual claims.
- Supporting S9: default mode vs authorized supervisor replay; show reconnect only while real delivery work runs; unavailable volatile buffer restores available history without reexecution. No exactly-once/durable-continuation marketing claim.

Coordinator commands follow the plan: local Worker/browser scenarios first, then named lane suites and typecheck; `.agents/skills/impeccable/scripts/impeccable detect --json app/components/chat app/lib/use-assistant-stream.ts`; antislop Delivery Gate with one-line-per-item evidence; final `bash scripts/verify-gate.sh --full`. Design review compares the rendered states against this brief and current PHOSPHOR, with CONFIRMED/SUSPECTED SEV/MED/NIT findings. No test/build/browser/detector gate was run by this design lane.

## Handoff

- Artifact: `.impeccable/surfaces/ai-chat-reliability.md`, plus approved assistant availability corrections in `PRODUCT.md`. This brief is authoritative for the bounded state/copy refinement; current `DESIGN.md` wins for tokens/geometry.
- Scope: existing composer, failed/partial/stopped transcript response, attachment readiness, existing approval/resume/result rows, full diff access, and permission-aware setup guidance. Implementation belongs to the frontend owner; reconcile the renderer/copy file-boundary findings above with the coordinator first. No implementation is included here.
- Verify: coordinator-run A6–A8/A11 hooks and S3–S10, Impeccable detect, antislop Delivery Gate, typecheck/lane tests, then `bash scripts/verify-gate.sh --full` on integrated work. Until that evidence exists, this artifact does not imply UI acceptance or a green release gate.
- Drift: material deviations, missing authoritative write-risk/permission inputs, or a need for a new state/endpoint return for a design/contract pass; do not invent the missing capability.
