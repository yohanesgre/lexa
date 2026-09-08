import { NoticeDanger } from "../ui/NoticeDanger";
import { CodeInline } from "./code-inline";

export function ExpiredVariant() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <NoticeDanger>This request has expired.</NoticeDanger>
      <p className="text-xs text-lx-text-secondary" style={{ lineHeight: 1.5, margin: 0 }}>
        Device-login requests are valid for 10 minutes. Run <CodeInline>lexa-cli login &lt;URL&gt;</CodeInline> again to mint a new one.
      </p>
    </div>
  );
}