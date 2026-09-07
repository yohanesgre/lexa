import type { ApprovalChip, ApprovalChipState } from "./HeraldApprovals";
import { targetFor } from "./herald-diff-utils";
import { DiffBody } from "./HeraldDiffBody";

const STATE_CLASS: Record<ApprovalChipState, string> = {
  pending: "",
  approved: " state-approved",
  rejected: " state-rejected",
  expired: " state-expired",
  failed: " state-failed",
};

const STATE_ICON = {
  approved: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  rejected: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  expired: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  failed: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  ),
} as const;

const STATE_LABEL: Record<Exclude<ApprovalChipState, "pending">, string> = {
  approved: "Approved",
  rejected: "Rejected",
  expired: "Approval expired",
  failed: "Failed",
};

const STATE_COLOR: Record<Exclude<ApprovalChipState, "pending">, string> = {
  approved: "text-lx-text-success",
  rejected: "text-lx-text-danger",
  expired: "text-lx-text-warning",
  failed: "text-lx-text-danger",
};

// Expired/failed chips swap the diff body for a status note.
function ChipDiffArea({ chip }: { chip: ApprovalChip }) {
  if (chip.state === "expired") {
    return (
      <div className="approval-diff">
        <div className="text-xs text-lx-text-secondary" style={{ lineHeight: "18px" }}>
          Approval expired — write not executed.
        </div>
      </div>
    );
  }
  if (chip.state === "failed" && chip.error) {
    return (
      <div className="approval-diff">
        <div style={{ background: "var(--lx-bg-danger-subtle)", border: "1px solid var(--lx-bg-danger-subtle)", borderRadius: 6, padding: "8px 10px", overflow: "hidden" }}>
          <div className="font-mono text-xs font-medium" style={{ color: "var(--lx-text-danger)" }}>
            {chip.error.code}
          </div>
          <div className="text-xs text-lx-text-secondary mt-1" style={{ lineHeight: "16px" }}>
            {chip.error.message}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="approval-diff">
      <DiffBody chip={chip} />
    </div>
  );
}

export function ApprovalChipRow({
  chip,
  total,
  mixedBatch,
  disabled,
  onDecide,
}: {
  chip: ApprovalChip;
  total: number;
  mixedBatch: boolean;
  disabled: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
}) {
  const decided = chip.state !== "pending";
  const terminal = decided ? (chip.state as Exclude<ApprovalChipState, "pending">) : null;
  return (
    <div className={`approval-chip${STATE_CLASS[chip.state]}`}>
      <div className="flex items-center gap-2">
        <span className="approval-tool">{chip.name}</span>
        <span className="color-muted text-xs text-lx-text-muted">·</span>
        <span className="approval-target">{targetFor(chip.diff)}</span>
        {terminal ? (
          <span className={`approval-status ${STATE_COLOR[terminal]}`} style={{ marginLeft: "auto" }}>
            {STATE_ICON[terminal]}
            {STATE_LABEL[terminal]}
          </span>
        ) : mixedBatch ? (
          <span className="approval-seq" style={{ marginLeft: "auto" }}>
            pending
          </span>
        ) : (
          <span className="approval-seq" style={{ marginLeft: "auto" }}>
            {chip.seq + 1} / {total}
          </span>
        )}
      </div>

      <ChipDiffArea chip={chip} />

      {!decided && (
        <div className="flex items-center justify-end gap-2" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-danger btn-sm" disabled={disabled} onClick={() => onDecide(chip, "reject")}>
            Reject
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={() => onDecide(chip, "approve")}>
            Approve
          </button>
        </div>
      )}
    </div>
  );
}
