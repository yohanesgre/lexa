import { useEffect, useState } from "react";
import { IconFrame } from "./icon-frame";
import { expiresInLabel } from "./expires-label";

export function PendingVariant({ clientName, code, expiresAt, busy, onApprove, onDeny }: {
  clientName: string;
  code: string;
  expiresAt: string;
  busy: "approving" | "denying" | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <IconFrame tone="neutral">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
      </IconFrame>
      <div className="text-sm weight-500 mb-1" style={{ textAlign: "center", fontSize: 15 }}>Approve this device?</div>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <div className="font-mono text-base weight-500">{clientName}</div>
        <div className="text-xs text-lx-text-muted" style={{ marginTop: 4 }}>
          code <span className="chip font-mono text-xs" style={{ background: "var(--lx-surface-input)" }}>{code}</span> · {expiresInLabel(expiresAt, now)}
        </div>
      </div>
      <p className="text-xs text-lx-text-secondary" style={{ textAlign: "center", lineHeight: 1.5, margin: "0 0 16px" }}>
        A terminal on this machine is requesting a key bound to your account. Approve mints the key once — the CLI prints it, and you can manage it in Settings → Me → API keys.
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-danger" style={{ flex: 1 }} onClick={onDeny} disabled={busy !== null}>
          {busy === "denying" ? (<><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />Denying…</>) : "Deny"}
        </button>
        <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={onApprove} disabled={busy !== null}>
          {busy === "approving" ? (<><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />Approving…</>) : "Approve"}
        </button>
      </div>
    </div>
  );
}