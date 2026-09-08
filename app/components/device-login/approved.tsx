import { Link } from "@tanstack/react-router";
import { IconFrame } from "./icon-frame";

export function ApprovedVariant({ keyName }: { keyName: string }) {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)", textAlign: "center" }}>
      <IconFrame tone="success">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></svg>
      </IconFrame>
      <div className="text-sm weight-500 mb-1" style={{ fontSize: 15 }}>Selesai — cek terminal</div>
      <p className="text-xs text-lx-text-secondary mb-4" style={{ marginTop: 0 }}>
        The CLI received the raw key once (name: <span className="font-mono">{keyName}</span>). It is bound to your account and listed under Settings → Me → API keys.
      </p>
      <Link to="/settings/me" className="btn btn-ghost" style={{ height: 32, padding: "0 14px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
        Go to my API keys
      </Link>
    </div>
  );
}