import type { HeraldWriteDiff } from "../../../shared/herald";
import { ApprovalChipRow } from "./HeraldApprovalChipRow";

// Approval chips for Herald write proposals — transcribed from
// wireframes/src/herald-write-approvals.html. Shared anatomy per chip:
// tool name (mono) · target ref (mono) · seq counter / status label ·
// diff body · Reject / Approve. Diff body shape follows the diff kind.
// Chip internals live in HeraldApprovalChipRow / HeraldDiffBody.

export type ApprovalChipState = "pending" | "approved" | "rejected" | "expired" | "failed";

export interface ApprovalChip {
  approvalId: string;
  batchId: string;
  seq: number;
  name: string;
  detail?: string | undefined;
  diff: HeraldWriteDiff;
  state: ApprovalChipState;
  error?: { code: string; message: string };
}

export function HeraldApprovalBatch({
  chips,
  locked,
  onDecide,
  onApproveAll,
}: {
  chips: ApprovalChip[];
  locked: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: () => void;
}) {
  const total = chips.length;
  const pendingCount = chips.filter((c) => c.state === "pending").length;
  const decidedCount = total - pendingCount;
  const mixed = decidedCount > 0 && pendingCount > 0;

  // Header: full-pending shows the proposal title + Approve all; any decision
  // swaps it to a decided/pending tally while chips remain; fully terminal
  // batches keep only the tally.
  const tallyParts: string[] = [];
  for (const key of ["approved", "rejected", "expired", "failed", "pending"] as const) {
    const n = chips.filter((c) => c.state === key).length;
    if (n > 0) tallyParts.push(`${n} ${key}`);
  }

  return (
    <div className="approval-batch">
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        {decidedCount === 0 ? (
          <span className="text-sm font-medium text-lx-text-primary">
            Herald proposes <span className="font-mono">{total}</span> change{total === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {tallyParts.join(" · ")}
          </span>
        )}
        {pendingCount > 0 && (
          <button type="button" className="btn btn-ghost-accent btn-sm" disabled={locked} onClick={onApproveAll}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Approve all
          </button>
        )}
      </div>
      {chips
        .toSorted((a, b) => a.seq - b.seq)
        .map((chip) => (
          <ApprovalChipRow key={chip.approvalId} chip={chip} total={total} mixedBatch={mixed} disabled={locked} onDecide={onDecide} />
        ))}
    </div>
  );
}

export function SuspendedIndicator() {
  return (
    <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
      <span className="suspended-dot" />
      <span className="font-micro text-2xs text-lx-text-warning" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
        Waiting for your approval…
      </span>
    </div>
  );
}
