import { Link, useRouterState } from "@tanstack/react-router";

export function PageNotFound() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <main
      style={{
        position: "relative",
        minHeight: "calc(100vh - 48px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div
        className="font-display font-semibold"
        aria-hidden="true"
        style={{
          position: "absolute",
          fontSize: 220,
          lineHeight: 1,
          letterSpacing: "-0.04em",
          color: "var(--lx-surface-card-hover)",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        404
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          padding: 24,
        }}
      >
        <span
          className="font-micro text-2xs"
          style={{ color: "var(--lx-border-focus)", textTransform: "uppercase", letterSpacing: "0.08em" }}
        >
          Error · 404
        </span>
        <h1 className="font-display text-3xl font-semibold text-lx-text-primary mt-2">Page not found</h1>
        <p className="text-sm text-lx-text-secondary mt-2" style={{ maxWidth: 400 }}>
          {"The page you're looking for doesn't exist — the project may have been renamed, or this link is stale."}
        </p>
        <code
          className="font-mono text-xs mt-3"
          style={{
            background: "var(--lx-surface-elevated)",
            border: "1px solid var(--lx-border-default)",
            borderRadius: 4,
            padding: "4px 10px",
            color: "var(--lx-text-muted)",
          }}
        >
          GET {pathname} → NO MATCH
        </code>
        <Link to="/" className="btn btn-primary mt-4">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </svg>
          Back to Dashboard
        </Link>
      </div>
    </main>
  );
}
