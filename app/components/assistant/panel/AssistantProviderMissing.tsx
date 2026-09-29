import { Link } from "@tanstack/react-router";

export function AssistantProviderMissing({ projectId }: { projectId: string | undefined }) {
  return (
    <>
      <div className="empty-state" style={{ padding: "32px 20px" }}>
        <div className="empty-state-icon">
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
          </svg>
        </div>
        <div className="text-sm font-medium text-lx-text-primary">No AI provider configured</div>
        <p className="text-xs text-lx-text-secondary mt-1" style={{ maxWidth: 240 }}>
          Assistant runs against a per-project provider endpoint. Set one up in Project Settings → Assistant provider.
        </p>
        {projectId && (
          <Link
            to="/settings/project/$projectId"
            params={{ projectId }}
            className="btn btn-primary btn-sm mt-3"
            style={{ textDecoration: "none" }}
          >
            Open Settings
          </Link>
        )}
      </div>
      <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
        <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">PROVIDER_NOT_CONFIGURED · 409</span>
        <button type="button" className="btn btn-primary btn-sm" disabled style={{ opacity: 0.45 }}>Generate</button>
      </div>
    </>
  );
}
