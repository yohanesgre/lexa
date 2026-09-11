import { CodeInline } from "./code-inline";
import { IconFrame } from "./icon-frame";

export function DeniedVariant() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <IconFrame tone="warning">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>
      </IconFrame>
      <div className="text-sm weight-500 mb-1" style={{ textAlign: "center", fontSize: 15 }}>Request denied</div>
      <p className="text-xs text-lx-text-secondary" style={{ textAlign: "center", lineHeight: 1.5, margin: "0 0 16px" }}>
        You rejected the request — no key was minted. Run <CodeInline>lx login &lt;URL&gt;</CodeInline> again to start a fresh one; the CLI shows <span className="font-mono">DEVICE_LOGIN_DENIED</span>.
      </p>
    </div>
  );
}