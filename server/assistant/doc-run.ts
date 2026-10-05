// Document-run (task/wiki Generate) helpers shared by the DO dispatch.
//
// Genuinely pure and DI-free: instruction assembly, the D5 write-mode rule, and
// the tool-loop stop conditions. The DO's document branch in `agent.ts` owns the
// assembly/IO (harness resolution, transport, tools); these helpers only carry
// the parts that must match the legacy task path byte-for-byte. Kept out of
// `agent.ts` so the chat branch there stays untouched.

import { stepCountIs, type StopCondition, type ToolSet } from "ai";
import type { AssistantToolPermissionMode } from "../../shared/assistant";
import { shouldSuspendOnProposal } from "./tools-ai";

/**
 * The document run's user instruction: the editor selection (quoted, when
 * present) followed by the run's extra prompt, blank-line separated. Mirrors
 * `AssistantTaskService.runStream`'s `userContent` so the DO run and the legacy
 * SSE path present the model the same text.
 */
export function buildDocumentRunInstruction(
  selection: string | null | undefined,
  extraPrompt: string | null | undefined
): string {
  const effectiveSelection = selection ?? "";
  return [
    effectiveSelection.trim() ? `Selected text:\n"""\n${effectiveSelection}\n"""` : null,
    extraPrompt ?? null,
  ]
    .filter((s): s is string => !!s && s.trim() !== "")
    .join("\n\n");
}

/**
 * D5: the write-mode picker is chat-only. A task/wiki run ignores any crafted
 * send envelope and any sticky `auto`/`deny` a stray chat control may have
 * written, and stays `ask`. Kept as an explicit seam so the document dispatch
 * and the legacy stream share one rule.
 */
export function resolveDocumentRunPermissionMode(): AssistantToolPermissionMode {
  return "ask";
}

/**
 * Stop conditions for a document run: the tool-round cap, then — only when the
 * run has write tools — suspend on a successful `ask`-mode write proposal
 * (parity with the chat branch's inline `stopWhen`).
 */
export function buildDocumentRunStopWhen(input: {
  toolRoundCap: number;
  permissionMode: AssistantToolPermissionMode;
  enabledWrite: readonly string[];
}): StopCondition<ToolSet>[] {
  const stopWhen: StopCondition<ToolSet>[] = [stepCountIs(input.toolRoundCap)];
  if (input.enabledWrite.length > 0) {
    stopWhen.push(({ steps }) =>
      shouldSuspendOnProposal(
        input.permissionMode,
        input.enabledWrite,
        steps.flatMap((step) =>
          step.toolResults.map((result) => ({ toolName: result.toolName, output: result.output }))
        )
      )
    );
  }
  return stopWhen;
}
