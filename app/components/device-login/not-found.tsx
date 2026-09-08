import { NoticeDanger } from "../ui/NoticeDanger";
import { CodeInline } from "./code-inline";

export function NotFoundVariant() {
  return (
    <div className="card-panel" style={{ boxShadow: "var(--lx-shadow-sm)" }}>
      <NoticeDanger>Request not found.</NoticeDanger>
      <p className="text-xs text-lx-text-secondary" style={{ lineHeight: 1.5, margin: 0 }}>
        The link is unknown or was already used — approval consumes the request and returns the raw key to the CLI exactly once. Start a new <CodeInline>lexa-cli login</CodeInline> and open its fresh link. The API never distinguishes unknown ids from consumed ones (no oracle).
      </p>
    </div>
  );
}