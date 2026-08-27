import type { ReactNode } from "react";
import type { HeraldWriteDiff } from "../../../shared/herald";

// Approval chips for Herald write proposals — transcribed from
// wireframes/src/herald-write-approvals.html. Shared anatomy per chip:
// tool name (mono) · target ref (mono) · seq counter / status label ·
// diff body · Reject / Approve. Diff body shape follows the diff kind.

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

const DIFF_CAP = 2000;

function chars(n: number): string {
  return `${n.toLocaleString("en-US")} / ${DIFF_CAP.toLocaleString("en-US")} chars`;
}

function cap(text: string): string {
  return text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}…` : text;
}

function targetFor(diff: HeraldWriteDiff): string {
  switch (diff.type) {
    case "task_create":
      return "new";
    case "task_update":
    case "task_move":
    case "task_archive":
    case "task_restore":
    case "task_delete":
    case "comment":
      return diff.taskRef;
    case "wiki_create":
    case "wiki_edit":
    case "wiki_delete":
      return diff.slug;
    case "milestone_create":
    case "milestone_update":
    case "milestone_archive":
    case "milestone_delete":
    case "sprint_create":
    case "sprint_update":
    case "sprint_archive":
    case "sprint_delete":
      return diff.name;
    case "swimlane_move":
      return diff.swimlaneName;
  }
}

function FieldList({ rows }: { rows: Array<{ label: string; value: string | null; primary?: boolean }> }) {
  return (
    <div className="approval-field-list">
      {rows.map((r) => (
        <div key={r.label} className="flex" style={{ gap: 8 }}>
          <span className="approval-field-label">{r.label}</span>
          <span className={`text-xs ${r.primary ? "text-lx-text-primary" : "text-lx-text-secondary"}`} style={{ minWidth: 0 }}>
            {r.value ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function DiffTable({ changes }: { changes: Array<{ field: string; before: string | null; after: string | null }> }) {
  if (changes.length === 0) return null;
  return (
    <table className="settings-table approval-diff-table" style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-subtle)", borderRadius: 6 }}>
      <thead>
        <tr>
          <th style={{ width: "28%" }}>Field</th>
          <th style={{ width: "36%" }}>Before</th>
          <th style={{ width: "36%" }}>After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.field}>
            <td style={{ color: "var(--lx-text-muted)" }}>{c.field}</td>
            <td className="diff-before">{c.before ?? "—"}</td>
            <td className="diff-after">{c.after ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MovePills({ from, to, muted }: { from: string; to: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="column-pill diff-before">{from}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-muted)" strokeWidth="1.5">
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
      <span className={`column-pill ${muted ? "diff-before" : "diff-after"}`}>{to}</span>
    </div>
  );
}

function TextBlock({ label, text, tone }: { label: string; text: string; tone: "before" | "after" }) {
  return (
    <div className="approval-textblock">
      <div className="flex items-center justify-between">
        <span className="approval-blocklabel">{label}</span>
        <span className="approval-blocklabel">{chars(text.length)}</span>
      </div>
      <p className={tone === "before" ? "diff-before" : "diff-after"}>{cap(text)}</p>
    </div>
  );
}

function ConfirmLine({ children }: { children: ReactNode }) {
  return <div className="text-xs text-lx-text-secondary" style={{ lineHeight: "18px" }}>{children}</div>;
}

function DiffBody({ chip }: { chip: ApprovalChip }) {
  const d = chip.diff;
  switch (d.type) {
    case "task_create":
      return (
        <FieldList
          rows={[
            { label: "Title", value: d.title, primary: true },
            ...Object.entries(d.fields).map(([k, v]) => ({ label: k, value: v })),
          ]}
        />
      );
    case "task_update":
      return <DiffTable changes={d.changes} />;
    case "task_move":
      return <MovePills from={d.fromColumn} to={d.toColumn} />;
    case "task_archive":
      return (
        <ConfirmLine>
          Archives <span className="font-mono text-lx-text-primary">{d.taskRef}</span> — &ldquo;{d.taskTitle}&rdquo;. The task leaves the board but stays searchable.
        </ConfirmLine>
      );
    case "task_restore":
      return (
        <ConfirmLine>
          Restores <span className="font-mono text-lx-text-primary">{d.taskRef}</span> — &ldquo;{d.taskTitle}&rdquo;.
        </ConfirmLine>
      );
    case "comment":
      return <TextBlock label="Comment body" text={d.bodyText} tone="before" />;
    case "wiki_create":
      return (
        <FieldList
          rows={[
            { label: "Title", value: d.title, primary: true },
            { label: "Parent page", value: d.slug },
          ]}
        />
      );
    case "wiki_edit":
      return (
        <>
          <TextBlock label="Before" text={d.beforeText} tone="before" />
          <TextBlock label="After" text={d.afterText} tone="after" />
        </>
      );
    case "milestone_create":
      return <FieldList rows={[{ label: "Name", value: d.name, primary: true }]} />;
    case "milestone_update":
      return <DiffTable changes={d.changes ?? []} />;
    case "milestone_archive":
      return (
        <ConfirmLine>
          Archives milestone <span className="text-lx-text-primary">{d.name}</span>. Its tasks stay untouched.
        </ConfirmLine>
      );
    case "sprint_create":
      return <FieldList rows={[{ label: "Name", value: d.name, primary: true }]} />;
    case "sprint_update":
      return <DiffTable changes={d.changes ?? []} />;
    case "task_delete":
      return (
        <ConfirmLine>
          Deletes <span className="font-mono text-lx-text-primary">{d.taskRef}</span> — &ldquo;{d.taskTitle}&rdquo;. This cannot be undone.
        </ConfirmLine>
      );
    case "wiki_delete":
      return (
        <ConfirmLine>
          Deletes page <span className="font-mono text-lx-text-primary">{d.slug}</span> — &ldquo;{d.title}&rdquo;.
        </ConfirmLine>
      );
    case "milestone_delete":
      return (
        <ConfirmLine>
          Deletes milestone <span className="text-lx-text-primary">{d.name}</span>.
        </ConfirmLine>
      );
    case "sprint_archive":
      return (
        <ConfirmLine>
          Archives sprint <span className="text-lx-text-primary">{d.name}</span>. Its live tasks archive with it.
        </ConfirmLine>
      );
    case "sprint_delete":
      return (
        <ConfirmLine>
          Deletes sprint <span className="text-lx-text-primary">{d.name}</span>.
        </ConfirmLine>
      );
    case "swimlane_move":
      return <MovePills from={d.fromMilestone ?? "Backlog"} to={d.toMilestone ?? "Backlog"} />;
  }
}

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
  const stateClass =
    chip.state === "approved"
      ? " state-approved"
      : chip.state === "rejected"
        ? " state-rejected"
        : chip.state === "expired"
          ? " state-expired"
          : chip.state === "failed"
            ? " state-failed"
            : "";
  const decided = chip.state !== "pending";
  const terminal = decided ? (chip.state as Exclude<ApprovalChipState, "pending">) : null;
  return (
    <div className={`approval-chip${stateClass}`}>
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

      {chip.state === "expired" ? (
        <div className="approval-diff">
          <div className="text-xs text-lx-text-secondary" style={{ lineHeight: "18px" }}>
            Approval expired — write not executed.
          </div>
        </div>
      ) : chip.state === "failed" && chip.error ? (
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
      ) : (
        <div className="approval-diff">
          <DiffBody chip={chip} />
        </div>
      )}

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
      {[...chips]
        .sort((a, b) => a.seq - b.seq)
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
