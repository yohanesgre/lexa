---
version: 1
slug: "markdown-first-documents"
primary_target: "app/components/editor/MarkdownEditorPane.tsx"
related_targets: ["app/components/DescriptionEditor.tsx", "app/components/TaskDescriptionSection.tsx", "app/components/TextEditor.tsx", "app/components/editor/EditorViewToggle.tsx", "app/components/wiki/WikiEditor.tsx", "app/components/wiki/useWikiEditor.ts", "app/components/wiki/WikiEditSplit.tsx", "app/components/wiki/WikiEditWorkspace.tsx", "app/components/wiki/WikiPageViewer.tsx", "app/components/activity/CommentComposer.tsx", "app/components/activity/CommentCard.tsx", "app/components/activity/CommentToolbar.tsx", "app/components/activity/CommentBody.tsx", "app/components/assistant/AssistantReviewSurface.tsx", "app/components/assistant/ReviewBanner.tsx", "app/components/assistant/panel/AssistantDoneView.tsx", "app/components/share/SharedWikiPage.tsx", "app/components/MarkdownContent.tsx", "app/lib/useAssistantReview.ts", "app/lib/useAttachmentEmbeds.ts", "app/lib/mention-suggestion.ts", "app/lib/mention.tsx"]
---

# Markdown-first documents: interaction handoff

## Authority and scope

This is the durable interaction specification for the approved Markdown-first cutover, not another implementation plan. The existing `status/markdown-first-documents/plan.md` remains the single execution plan. `PRODUCT.md` records canonical Markdown strings and the approved content/loss boundaries; `DESIGN.md` records the Source-Is-the-Document Rule and remains the only token source. The approval permits the representation change, not unrelated invariant or permission changes. The coordinator owns reconciliation of API/schema/invariant documentation outside this design lane.

Reading this as: document editing for small self-hosting teams, in existing PHOSPHOR/Trail Map, with ENERGY 1 / RHYTHM 1 / MOTION 1. Antislop active: during (global preference).

Mode: Operate, narrow interaction correction. Keep current task, wiki, timeline composer, generation review, chat response, and public-share regions. No new layout, visual world, import wizard, token inventory, endpoint, or toolbar capability. `docs/design-system.html` is frozen and unchanged. `.impeccable/design.json` is stale according to Impeccable context; do not regenerate it or repair unrelated shell geometry in this work. Current `DESIGN.md` wins for visual authority.

Evidence is source inspection before the coordinated cutover. File:line references below describe the inspected implementation, not proof of the replacement. No runtime visual review, browser interaction, build, test, detector, contrast measurement, or Delivery Gate happened in this design assignment.

## Existing file map and implementation order

1. `MarkdownEditorPane.tsx`, `DescriptionEditor.tsx`, `TextEditor.tsx`, `WikiEditor.tsx`, `useWikiEditor.ts`: replace the hidden TipTap model with one current Markdown draft and CodeMirror source selection/history. Preserve source immediately on change; debounce preview work, not the authoritative draft. All toolbar/generation/save paths read that same latest source.
2. `TaskDescriptionSection.tsx`, `WikiEditWorkspace.tsx`, `WikiEditSplit.tsx`, `CommentComposer.tsx`, `CommentCard.tsx`, `CommentToolbar.tsx`: retain existing surface ownership and commit/cancel controls; implement the race, keyboard, and failure corrections below together. Existing task mutation callers must expose real completion/failure to keep a failed edit recoverable; a fire-and-forget close is insufficient.
3. `useAssistantReview.ts`, `AssistantReviewSurface.tsx`, `ReviewBanner.tsx`, existing Assistant panel controls: make review/diff/apply source-based, retaining existing full-document replacement semantics and result identity guards.
4. `MarkdownContent.tsx` and existing render consumers, `WikiPageViewer.tsx`, `CommentBody.tsx`, `SharedWikiPage.tsx`, mention/attachment helpers: use the shared TanStack Markdown implementation with explicit surface policies. Remove obsolete runtime TipTap paths only after these consumers move together.

These are ownership seams, not authorization for a worker to exceed its assigned implementation files. This design lane edits no application source.

## Surface<C, V, N>

### C: content flow and cardinality

- Task: one selected description, or one create-form draft. Enter editing; type source or use selection toolbar; optionally preview; finish/save or blur outside the whole editing region; adopt the successful mutation response. Cancel returns to the existing read view without committing the cancelled draft.
- Wiki: one selected page draft containing title and source. Edit; preview or inspect one revision; optionally autosave under the saved setting; explicit Save completes editing only after successful current-session save. Revision close returns to the live unsaved draft; explicit restore adopts the authoritative restored page.
- Comments: one compact new-comment draft and independently owned inline drafts per comment. Enter submits/saves valid text; Shift+Enter inserts a newline. Successful create clears only its submitted draft; successful edit returns to read mode. Cancel discards only the selected inline edit.
- Generation: one result identity for one originating document/session. Generate reads current source and selection; streaming output is display-only; Review in editor presents the source diff; acceptance replaces the whole source with the completed result; rejection preserves the pre-review source. Document save remains the surface's normal save path.
- Read/share: one source rendered under authenticated document, comment, chat, or public-share policy. Wiki outline is derived from the same heading plan that assigns rendered anchors. Rendering never replaces stored source.

### V: interrupted content flow

- Empty: a real empty source `''`, existing placeholder and permitted empty read region. Task required-description validation and comment text validation remain distinct.
- Loading: keep the existing loading region; do not mount an editable empty draft over an unresolved document read. Lazy editor startup cannot clear the selected document.
- Partial: keep available stream text readable and safe. Incomplete links/fences never execute HTML or write a document. A revision preview is a separate read-only projection, not live draft replacement.
- Error: retain exact current source, title, selection where possible, and edit mode after save failure. Keep dirty state and existing catalog/toast/notice feedback. Autosave failure cannot silently mean saved. Failed upload/conversion inserts no fabricated image or generated text.
- Denied/read-only: retain authorized readable content only; remove mutation capability, including toolbar, paste/drop, keyboard submission, and Assistant acceptance. Public shares never mount an editor.

### N: prerequisites and identity boundaries

- Editing requires a settled owned document and permission. Task create has no attachment upload target until a real task ID exists.
- Source toolbar requires editable source selection. Preview, history inspection, and active review cannot mutate a hidden target.
- Save, autosave, revision fetch/restore, generation, and upload completion belong to the originating project, document, and edit session. Document changes or Cancel invalidate late UI adoption, insertion, and navigation from old work.
- An already dispatched mutation/upload cannot be undone merely by cancelling the UI. Cancel discards local unsaved work and stops pending local timers; it is not server rollback. Keep authoritative mutation cache updates scoped to their original entity without reintroducing cancelled text into the active editor.
- Managed conversion belongs to authorized existing attachment ingestion/tool flows. Attaching a file does not automatically persist its extracted text into a task or wiki.

## Frozen interaction contract

### Source, preview, and toolbar

The inspected toggle has exactly `Editor` and `Preview` (`EditorViewToggle.tsx:8-10`), and `WikiEditSplit.tsx:112-115` explicitly describes one pane. Preserve these actual controls and labels; `Markdown` in the plan describes the source representation, not a third view. Do not add `Split` simply because the component filename contains it. The existing plan says preserve modes where currently available; none inspected here offers Split.

Keep accessible source labels `Task description, Markdown` and `Page content, Markdown`; compact create/edit labels are `Add a comment` and `Edit comment`. Keep `Write Markdown here. The preview updates as you type.`, `Add a comment…`, and `Edit comment…` placeholders on their respective surfaces.

Switching view changes presentation only. Immediately typed source, including trailing whitespace, escape sequences, blank lines, Unicode, and JSON-looking text, remains exact. Do not trim, parse/reserialize, or normalize it at the save boundary. A preview may be debounced around the incumbent 300ms interval; explicit save, blur, view change, Generate, and review capture never wait for a delayed source commit. Returning to source preserves caret/selection and undo/redo for the same edit session; only an actual accepted replacement/document switch resets to that replacement's source.

Preserve current document toolbar operations: Heading 2–5, Bold, Italic, Bullet list, Ordered list, Task list, Image, Strikethrough, Code block, Blockquote, Horizontal rule, Insert table, Link, Assistant. Preserve compact comment toolbar: Bold, Italic, Bullet list, Link, Code block. Commands operate on source ranges as undoable transactions, then restore focus/selection to the source. Link/image prompts cannot lose the selected range. Do not restore underline/highlight controls, invent pressed states, add dead undo buttons, or keep a hidden rich-text editor solely for commands. Native CodeMirror undo/redo remains available.

### Save, Cancel, blur, and autosave

- Task edit: bare Enter finishes through the same path as `Save and finish editing`; Shift+Enter inserts newline. `Revert changes` or Escape cancels. Task create has no finish callback, so Enter is normal multiline editing and outer Create consumes latest source.
- Task blur: only leaving the complete editor plus its toolbar/exit row/Assistant popover is a save exit. Switching views, clicking a formatting control, opening a link/image prompt, and reviewing Assistant output are not exit blurs. One intent produces one mutation; failed mutation retains a recoverable draft and no false saved/read state.
- Wiki: retain explicit header `Cancel` and `Save`, `Saving...` on the save button, `Saving…` and `Unsaved changes` in the existing footer. Enter/Shift+Enter are multiline editing, not task/comment submission. Do not introduce a global wiki Escape-to-save/cancel binding: the inspected source has no such callback. Inner picker, popover, or review consumes Escape first.
- Wiki autosave: retain local settings `lexa-wiki-autosave` (default off), `lexa-wiki-autosave-delay` (default 800ms), and existing settings UI. Review and history preview suspend document autosave, including already armed timers. Neither unaccepted result nor historical preview can become an autosave payload. Manual save captures latest title/source, guards duplicate save, and retains the current manual-lock behavior; newer title/source edits or a new session make its response stale for draft adoption.
- Save response: update the original entity cache from the real mutation response. Mark current draft clean only when its document/session/version still matches the submitted snapshot. A late response cannot overwrite newer source/title, clear their dirty state, close their editor, rename/navigate a different page, or update its save label.
- Cancel: invalidate the session before cancelling timers and restoring the last accepted baseline. No blur/cleanup callback may recommit cancelled source. With wiki autosave, Cancel does not revert previously completed autosaves. A currently dispatched save may complete remotely; do not promise undo or claim the cancelled text was never written.
- Revision preview: capture the latest live source once; revision-to-revision switching keeps that snapshot. Source and Save stay read-only/disabled during preview. Close preview restores the unsaved live source; restore changes it only after a successful authoritative response. A delayed revision read or restore for another session cannot take over the new page.

### Comments and keyboard precedence

New-comment Enter submits; inline-comment Enter saves, matching existing helper copy `Enter to save · Shift+Enter newline`. Shift+Enter always inserts newline when editable. Inline `Cancel` and Escape restore the current persisted body, clear that draft's pending work, and return focus to its `Edit comment` control; reopening starts from persisted source, not a cancelled buffer. Do not make Escape erase the new-comment composer.

Disable Comment/Save and keyboard submission for empty-text or over-limit input and while that mutation is pending. Comments use readable nonempty text, not the looser task image/rule/table policy. Preserve the cap as `JSON.stringify(body).length <= 65_536` JavaScript UTF-16 code units for the Markdown string input; escaping, quotes, and non-BMP characters affect the count. Do not substitute raw source length or UTF-8 bytes. Keep existing service errors/catalog rather than introducing new error codes.

Do not discard typing that arrives after a submitted snapshot: either hold the submitted comment editor read-only while pending, or clear/close only when draft/session still equals that submitted snapshot. Failure retains the draft; Cancel cannot be reversed by a delayed success.

Keyboard priority is composition, active inner picker/popover/review, then surface submission/cancel. During IME composition, Enter and Escape must not submit, cancel, accept, discard, or trigger Generate. Consume the composition-ending key event, including browser keyCode 229 behavior where applicable, before surface callbacks. Assistant Additional prompt keeps its existing Ctrl/Cmd+Enter Generate shortcut, with the same composition and pending/settings guards as the button.

Tab and Shift+Tab leave the source editor in normal document focus order; no Tab indentation trap and no new tab-capture mode. Mention picker ArrowUp/ArrowDown selects, Enter chooses one permitted match without submitting, Escape closes only the picker, and Tab dismisses it while leaving the editor. Undo/redo changes source, never launches save or generation.

### Assistant Apply/Discard semantics

Keep existing actual `Generate`, `Review in editor`, `Accept`, `Reject` controls and their current positions. The plan's Apply/Discard terms name these semantics; do not add a second Apply/Discard row or silently relabel the current flow. `Nothing is changed until you accept` remains true for the document source.

Diff the raw original and proposed Markdown, not plain-text projections. Heading/list/link/formatting-only changes must be visible and accepted even when rendered text is unchanged. Accept is a full-source replacement, not insertion at the caret and not gated on a lossy text diff's hunk count. Reject leaves the original source and source history intact. Escape within active review rejects that result only, then restores editor focus; it does not also cancel the surrounding task/wiki editor.

Retain accepted/rejected result identity tracking so reopening cannot offer the same completed result for duplicate application. An in-review or accepted result for another document/session cannot replace current source. Apply task's normal done/save path after acceptance; wiki resumes its existing dirty/autosave/manual-save path. Reject must not create a new dirty change merely because review closed; any genuinely dirty pre-review draft remains dirty and may resume its existing save policy.

Chat tool approvals remain separate from editor acceptance. Keep `ask` / `auto` / `deny`, proposal selection/full diff, apply-once, per-write results, and retry/resume rules from `ai-chat-reliability.md`. Source-based rendering does not approve a write.

### Mentions, images, and rendering trust

- Task/wiki source mentions: project-scoped selection inserts an escaped ordinary Markdown deep link using existing routes, `/{slug}/board?task={id}` or `/{slug}/wiki/{pageSlug}`, retaining its label. No rich node, attached chat context, hidden metadata, or whole-source textual replacement. The existing visible source pane has no active TipTap mention plugin; retaining the plugin on a hidden model does not preserve source interaction.
- Milestone/swimlane/column legacy mention nodes currently have no document route (`tiptap-render.tsx:70-77`). They are not task/wiki links. Do not invent a link/encoding or claim full mention equivalence: unresolved mapping is an offline audit refusal under the approved loss policy. Do not expose an inert insertion choice on the new source picker without an approved representation.
- Comments: preserve known member-name highlighting and unknown names as plain text, with no notification/delivery claim. Apply mention decoration only to parsed ordinary text leaves; inline and fenced code, URLs, and syntax remain literal. The old inline code-mark path can decorate first; the new renderer must not carry that defect forward.
- Task/wiki image authoring: keep existing `Image URL`, `Alt text (optional)`, and HTTP(S) authoring allowlist. Escape Markdown delimiters without changing intended labels/URLs. Uploaded raster images insert `![alt](/api/attachments/{id})` only after successful existing API upload; SVG/HTML and other dropped files stay download-only attachments. No data/blob URL in persisted source. Preserve file order and mapped caret/drop position while intervening edits occur. A completion after Cancel, view/session invalidation, permission change, or document switch cannot insert into the active document. Upload cache/activity may still update the originating entity truthfully; Cancel does not delete original blobs.
- Authenticated document preview/read: allow the incumbent safe HTTP(S) images and exact-shaped authenticated attachment URLs; enforce server ownership. Keep safe document links and existing task/wiki prose wrappers. Invalid schemes are inert, not executable.
- Chat: images remain alt text, not remote loads; link URLs follow the current safe-link allowlist and external-tab protection. No raw HTML execution, MDX, or document writes from streaming output. Code highlighting and streaming caret stay within existing code/bubble anatomy.
- Public share: retain `Shared read-only`, existing child-page navigation, dead-link `Page not available` state and its copy. Map wiki links within the shared subtree to `/share/{token}?page={id}`; outside-subtree internal links retain the dead-link behavior, not authenticated app navigation. Rewrite attachment images to `/api/share/{token}/attachments/{id}` only in render output. Preserve token-scoped server authorization and current safe remote-image behavior; do not embed the token into canonical source. Shared renderer is not shared permission.
- Wiki headings: preserve heading cap, duplicate-heading suffixes and reserved page-title anchor, outline/scrollspy correspondence, and the existing three-section threshold for navigation. Do not derive anchors with a separate parser that disagrees with rendered headings.
- Required syntax compatibility remains an integration gate: Setext headings, indented code, bare URLs, entities, hard breaks, tables, tasks, nested lists, and partial fences/links need real parser evidence. Unsupported presentation cannot rewrite or discard stored source; unresolved required syntax returns to the coordinator for a renderer decision, not a replacement custom compiler.

## Visual and state matrix

Geometry is inherited. Preserve `.md-pane`, `.editor-wrapper`, `.editor-preview`, `.wiki-prose`, `.td-prose`, `.bubble-md`, `.composer`, `.composer-toolbar`, `.composer-footer`, and the current task/wiki/share/chat shells. Use PHOSPHOR variables, never a new palette or token list. Full document source inherits existing 120px minimum pane height, space-6 padding, mono source type 13px/22px, tab size 2, transparent inner background, and no added inner card. Compact comment source inherits 64px minimum height, 10px/12px padding, existing 14px/20px type and mobile 16px input rule. These incumbent dimensions come from `phosphor.css:2069-2107,5171-5205,8499-8501`, not new global tokens.

Copy applicable button markup from `docs/design-system.html:6671-6712`; preserve compact paired controls and toolbar anatomy. Prose uses the incumbent reference at `:7614-7779`, including wiki's longer line height and task/chat deltas. Source monospace exists for syntax readability, not terminal decoration. Amber identifies existing actions/focus; do not add a second accent, shadow, gutter chrome, animation, or floating editor card. Keep CodeMirror default theme colors, excess gutters and borders from leaking into either theme.

| State | Required treatment |
| --- | --- |
| Default | Exact draft in source; preview of that draft; existing control order and primary Save/Comment/Accept actions. |
| Hover | Existing PHOSPHOR tonal feedback only; no hover-only way to save, cancel, review, or remove a relevant attachment. |
| Focus-visible | Existing 2px border-focus outline with 2px offset on controls. See the unresolved editor-focus source conflict below; no claim that a caret alone passed accessibility review. |
| Active | Existing pressed treatment; one operation per activation. Selection operations remain undoable. |
| Disabled/read-only | Muted primitive state without hover mutation. Preview/revision/review permissions apply to toolbar and async paths, not just typing. |
| Loading/saving | Existing skeleton/loading copy; no false empty source or premature saved status; retain safe Cancel and failure recovery. |
| Error | Current draft and dirty state remain; existing catalog feedback names the failed operation. No catch-to-empty or hidden autosave success. |
| Empty | Existing source placeholders and empty read region; comment submission disabled for non-text content. |
| Partial/review | Display-only stream or selected history; original draft preserved; only eligible completed-result acceptance can replace source. |
| Long/mobile | Ordinary text wraps; source/code/table/diff overflow stays within the region. Controls wrap without page-wide overflow and remain reachable above the keyboard. |

Keep current one-pane toggle behavior at 390px and 1440px and current wiki reflow below 768px. This cutover does not introduce another breakpoint or two-pane split. Preserve existing 44px phone view-toggle targets and at least 44px touch hit areas for save/cancel/comment/review controls without changing their visual world. Retain source scroll position where practical across view switches, and prevent CodeMirror content from widening a shrinkable region. Verify 200% zoom and phone focus/keyboard clearance later; this brief supplies no rendered evidence.

No new motion: source/preview/review state changes are immediate. Retain existing 100ms control background/border feedback and installed easing. Reduced motion removes optional transitions/smooth scrolling while preserving status. Screen readers receive labels, read-only/disabled state, and operation status through existing polite regions, not every preview parse or stream delta.

## Prioritized source findings and required corrections

These findings are CONFIRMED source facts. Behavioral/visual consequences not exercised at runtime are SUSPECTED risks.

1. **SEV, CONFIRMED: delayed and duplicate document model.** `MarkdownEditorPane.tsx:59-105,209-219` delays conversion into TipTap; `DescriptionEditor.tsx:68-82,144-158,184-189` and `WikiEditor.tsx:41-55` still read hidden model state. Replace with synchronous current source; saves/generation/view changes must not miss the latest keystroke. SUSPECTED risk: view-unmount and save-before-debounce loss.
2. **SEV, CONFIRMED: failure/identity save gaps.** `TaskDescriptionSection.tsx:42-49` closes editing before mutation success. `useWikiEditor.ts:224-254,289-305` uses stale guards for draft state but rename navigation is outside them and autosave errors are swallowed. Revision reads at `:341-365` have no visible session ownership guard. Preserve drafts on failure and guard all late UI/navigation adoption, not only source setters.
3. **SEV, CONFIRMED: formatting-only acceptance skipped.** `useAssistantReview.ts:47-49,60-74` projects both documents to text and replaces only when diff hunks exist. Raw-source comparison and explicit full-source acceptance are required. `useWikiEditor.ts:403-409` marks dirty even after Reject; rejection must not invent a change or save an unaccepted result.
4. **MED, CONFIRMED: comment edit copy does not match keys/cancel.** `CommentCard.tsx:133-149,175-180` advertises Enter-to-save without an Enter handler; Cancel hides but does not restore the editor buffer. Match the published hint, restore persisted body, guard pending/empty/limit and late success. `CommentComposer.tsx:49-54` clears on success without a draft snapshot guard; preserve typing not included in the submitted body.
5. **MED, CONFIRMED: keyboard ownership gaps.** Task Escape at `MarkdownEditorPane.tsx:191-195`, global review Escape at `ReviewBanner.tsx:19-24`, and prompt Ctrl/Cmd+Enter at `AssistantPanelIdle.tsx:47-51` lack composition checks. CodeMirror migration must preserve IME safety and inner Escape priority, with native Tab escape and undo/redo.
6. **MED, CONFIRMED: hidden insertion paths.** `DescriptionEditor.tsx:135-137` and `useWikiEditor.ts:187-193` attach paste/drop to the hidden TipTap model rather than the visible source. `useAttachmentEmbeds.ts:59-72` completes against a captured view without document/session validation. Wire actual source uploads/insertion and scope completion. `mention-suggestion.ts:104-112` inserts rich nodes, so a retained plugin is not a Markdown source solution.
7. **MED, CONFIRMED: share type guard rejects strings.** `SharedWikiPage.tsx:83-86` replaces non-object content with an empty TipTap document. Consume canonical Markdown directly; retain link/image rewrites at `tiptap-render.tsx:37-62`. SUSPECTED risk: a partially migrated public share looks empty despite stored source.
8. **MED, CONFIRMED source authority conflict; rendered impact unreviewed.** `DESIGN.md`/PRODUCT require visible keyboard focus, but `phosphor.css:5178-5184,9385-9395` records an owner-requested caret-only editor exception; full source remains 13px on phones. Do not silently reverse that recorded owner preference or claim WCAG/phone acceptance. Coordinator must resolve the focus exception against the approved keyboard-accessibility gate and inspect actual CodeMirror focus/zoom behavior before acceptance. This spec does not authorize a new visual treatment to hide the conflict.

## Handoff and integration proof

- Artifact: `.impeccable/surfaces/markdown-first-documents.md`, canonical-document constraints in `PRODUCT.md`, and the Source-Is-the-Document Rule in `DESIGN.md`. These interaction decisions are authoritative; current PHOSPHOR remains the visual authority. The chat brief's Markdown addendum links the two scopes without replacing its reliability contract.
- Scope: existing source/preview/save/cancel/toolbar, task/wiki/comments, Assistant document review, mention/image insertion, wiki outline/revisions and public-share rendering. Implementation belongs to the assigned swe owners, not this design lane. No new screens or controls.
- Verify: coordinator runs the plan's A1/A2 semantic/API boundaries, A4 editor/save/IME/undo/race checks, A5 render/share/stream checks, and A6 Assistant approved/denied writes. Exercise immediate typing then Preview/Save/Generate, edit during autosave, Cancel while saving, page switch while save/revision/upload resolves, comment failure/reopen, formatting-only acceptance, code containing mention syntax, and public scoped images/links. Include 390px/1440px, both themes, keyboard/IME, 200% zoom, reduced motion, empty/loading/error/partial/denied states and console review. Extend existing behavioral coverage rather than source/copy/class/style pins.
- Gate ownership: parent runs `bun run test:fe`, the plan's named editor/wiki/service contract tests, `bun run build:workers`, Impeccable detect on the actual changed UI targets, antislop Delivery Gate, and final `bash scripts/verify-gate.sh --full` after integrated changes settle. No command above was run by this design lane. The handoff is design-complete, not runtime-approved or a passing release assertion.
- Drift: material deviations, unresolved required parser behavior, non-task/wiki mention encoding, or the editor-focus authority conflict return to the coordinator/design owner. Do not invent missing permission, mapping, or visual decisions.
