import type { ReactNode } from "react";
import { chars, cap } from "./herald-diff-utils";

// Shared diff primitives for Herald approval chips — transcribed from
// wireframes/src/herald-write-approvals.html.

export function FieldList({ rows }: { rows: Array<{ label: string; value: string | null; primary?: boolean }> }) {
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

export function DiffTable({ changes }: { changes: Array<{ field: string; before: string | null; after: string | null }> }) {
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

export function MovePills({ from, to, muted }: { from: string; to: string; muted?: boolean }) {
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

export function TextBlock({ label, text, tone }: { label: string; text: string; tone: "before" | "after" }) {
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

export function ConfirmLine({ children }: { children: ReactNode }) {
  return <div className="text-xs text-lx-text-secondary" style={{ lineHeight: "18px" }}>{children}</div>;
}
