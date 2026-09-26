import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useAssistantProviders, useAssistantProvidersHealth, useProbeAssistantProvider } from "../../lib/queries/assistant-admin";
import { formatRelative } from "../../lib/relative-time";
import type { AssistantProviderHealth } from "../../lib/api";

// Plain-language gateway health. Status is icon shape + text, never color
// alone; circuit-breaker jargon lives only in the per-row Details disclosure.
// Self-contained: embedded once, full, on the Overview tab.
type HealthStatus = "working" | "slow" | "trouble" | "offline" | "unknown";

// No server-side latency watch threshold exists (D5 exposes latencyMs only).
const SLOW_LATENCY_MS = 5000;

const statusMeta: Record<HealthStatus, { label: string; tone: "ok" | "warn" | "danger" | "muted"; accent: string; rank: number }> = {
  offline: { label: "Offline", tone: "danger", accent: "danger", rank: 0 },
  trouble: { label: "Having trouble", tone: "warn", accent: "warning", rank: 1 },
  slow: { label: "Slow", tone: "warn", accent: "warning", rank: 2 },
  unknown: { label: "Not checked yet", tone: "muted", accent: "neutral", rank: 3 },
  working: { label: "Working", tone: "ok", accent: "success", rank: 4 },
};

function statusOf(h: AssistantProviderHealth | undefined): HealthStatus {
  if (!h) return "unknown";
  if (h.circuitState === "open") return "offline";
  if (h.lastCheckedAt == null && h.lastProbeAt == null) return "unknown";
  if (h.circuitState === "half-open" || h.consecutiveFailures > 0) return "trouble";
  if (h.latencyMs != null && h.latencyMs >= SLOW_LATENCY_MS) return "slow";
  return "working";
}

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === "working") {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><path d="m9 12 2 2 4-4" /></svg>;
  }
  if (status === "trouble") {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>;
  }
  if (status === "offline") {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>;
  }
  if (status === "slow") {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><path d="M12 7v5" /><path d="M12 16h.01" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><path d="M12 7v5l3 2" /></svg>;
}

function StatusPill({ status, text }: { status: HealthStatus; text?: string }) {
  const meta = statusMeta[status];
  return (
    <span className={`health-status health-status--${meta.tone}`}>
      <StatusIcon status={status} />
      {text ?? meta.label}
    </span>
  );
}

function retryCopy(seconds: number | null): string {
  if (seconds == null) return "automatic retry pending";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `automatic retry in ~${minutes} min`;
}

function enabledModelLabels(models: { modelId: string; enabled: boolean }[] | undefined): string[] {
  return (models ?? []).filter((m) => m.enabled).map((m) => m.modelId.split("/").pop() ?? m.modelId);
}

function noteFor(status: HealthStatus, h: AssistantProviderHealth | undefined): string {
  if (!h) return "Checking…";
  const failureSuffix = h.lastFailureCode ? ` (${h.lastFailureCode})` : "";
  if (status === "working") return `Checked ${h.lastCheckedAt ? formatRelative(h.lastCheckedAt) : "just now"} · refreshes every 30s`;
  if (status === "slow") return `Responded in ${h.latencyMs?.toLocaleString()} ms · above the ${SLOW_LATENCY_MS / 1000}s watch threshold`;
  if (status === "trouble") return `${h.consecutiveFailures} checks failed in a row${failureSuffix} · retries automatically on the next request`;
  if (status === "offline") return `${h.consecutiveFailures} checks failed in a row${failureSuffix} · ${retryCopy(h.retryAfterSeconds)} · calls to this provider are paused`;
  return "No checks recorded yet · run a test connection to start monitoring";
}

function aggregateCheckedNote(rows: (AssistantProviderHealth | undefined)[]): string {
  const times = rows.map((h) => h?.lastCheckedAt).filter((t): t is string => !!t);
  if (times.length === 0) return "not checked yet";
  const latest = times.reduce((a, b) => (a > b ? a : b));
  const rel = formatRelative(latest);
  return rel === "just now" ? "checked just now" : `checked ${rel}`;
}

export function GatewayHealthSection() {
  const { data: providers, isLoading, isError, refetch } = useAssistantProviders();
  const ids = useMemo(() => (providers ?? []).map((p) => p.id), [providers]);
  const health = useAssistantProvidersHealth(ids);
  const probe = useProbeAssistantProvider();
  const byId = useMemo(() => new Map(health.map((h, i) => [ids[i]!, h])), [health, ids]);
  const settled = health.every((h) => !h.isPending);

  const overall = useMemo(() => {
    if (settled && (ids.length === 0 || health.every((h) => h.data))) {
      const states = ids.map((id) => statusOf(byId.get(id)?.data));
      return {
        worst: states.length ? states.reduce((a, b) => (statusMeta[a].rank <= statusMeta[b].rank ? a : b)) : null,
        counts: states.reduce<Record<HealthStatus, number>>((acc, s) => ({ ...acc, [s]: acc[s] + 1 }), { working: 0, slow: 0, trouble: 0, offline: 0, unknown: 0 }),
      };
    }
    return null;
  }, [settled, ids, byId, health]);

  const worstProviderId = useMemo(() => {
    if (!settled) return null;
    let bestId: string | null = null;
    let bestRank = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const state = health[i]?.data;
      if (!state) continue;
      const rank = statusMeta[statusOf(state)].rank;
      if (rank < bestRank) {
        bestRank = rank;
        bestId = ids[i]!;
      }
    }
    return bestId;
  }, [ids, health, settled]);

  const worstIsAttention = overall?.worst === "offline" || overall?.worst === "trouble";

  const headerPill = (() => {
    if (isLoading || !providers) return <span className="health-status health-status--muted"><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} aria-hidden="true" />Checking providers…</span>;
    if (isError) return null;
    if (!overall || overall.worst === null) return <span className="health-status health-status--muted"><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} aria-hidden="true" />Checking…</span>;
    if (overall.worst === "working") return <StatusPill status="working" text="All systems working" />;
    const n = overall.counts[overall.worst];
    const unit = `${n} provider${n === 1 ? "" : "s"}`;
    if (overall.worst === "offline") return <StatusPill status="offline" text={`${unit} offline`} />;
    if (overall.worst === "trouble") return <StatusPill status="trouble" text={`${unit} having trouble`} />;
    if (overall.worst === "slow") return <StatusPill status="slow" text={`${unit} slow`} />;
    return <StatusPill status="unknown" />;
  })();

  const summaryLine = overall ? (
    <p className="health-summary">
      {ids.length} provider{ids.length === 1 ? "" : "s"}
      {(["working", "slow", "trouble", "offline", "unknown"] as HealthStatus[])
        .filter((s) => overall.counts[s] > 0)
        .map((s) => ` · ${overall.counts[s]} ${statusMeta[s].label.toLowerCase()}`)
        .join("")}
      {" · "}
      {aggregateCheckedNote(ids.map((id) => byId.get(id)?.data))}
    </p>
  ) : null;

  const renderProviders = (list: typeof providers) => (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {(list ?? []).map((p) => {
        const h = byId.get(p.id);
        const status = h?.isPending ? null : statusOf(h?.data);
        const meta = status ? statusMeta[status] : null;
        const models = enabledModelLabels(p.models);
        const metaLine = models.length > 0 ? `Serving ${models.length} model${models.length === 1 ? "" : "s"} · ${models.join(" · ")}` : "No models enabled";
        const probing = probe.isPending && probe.variables === p.id;
        const needsAttention = status === "offline" || status === "trouble";
        return (
          <div key={p.id} className={`card-row${meta ? ` card-row--${meta.accent}` : ""}`}>
            <div className="flex items-start justify-between" style={{ gap: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 240 }}>
                <div className="health-provider-head">
                  <span className="health-provider-label">{p.label}</span>
                  {status && meta ? (
                    <StatusPill status={status} />
                  ) : h?.isError ? (
                    <span className="health-status health-status--danger"><StatusIcon status="offline" />error</span>
                  ) : (
                    <span className="health-status health-status--muted"><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} aria-hidden="true" />Checking…</span>
                  )}
                </div>
                <div className="health-provider-meta mt-1">{metaLine}</div>
                {status ? <div className="health-provider-note mt-1">{noteFor(status, h?.data)}</div> : null}
              </div>
              <div className="health-provider-actions">
                <button
                  type="button"
                  className={`btn ${needsAttention ? "btn-primary" : "btn-ghost"} btn-sm`}
                  disabled={probe.isPending}
                  onClick={() => probe.mutate(p.id)}
                >
                  {probing ? <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} /> : <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7" /><path d="M21 3v6h-6" /></svg>}
                  {probing ? "Testing…" : "Test connection"}
                </button>
                <Link to="/admin/assistant/providers" className="btn btn-ghost btn-sm" style={{ textDecoration: "none" }}>Settings</Link>
              </div>
            </div>
            {probe.isError && probe.variables === p.id ? (
              <div className="notice notice-danger mt-2">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><line x1={12} y1={8} x2={12} y2={12} /><line x1={12} y1={16} x2={12.01} y2={16} /></svg>
                <span>{(probe.error as Error)?.message ?? "Test connection failed"}</span>
              </div>
            ) : null}
            <details className="health-details mt-2">
              <summary><svg className="health-details-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>Details</summary>
              <div className="health-details-body">
                <dl className="health-details-kv">
                  <dt>Circuit</dt><dd>{h?.data?.circuitState ?? "—"}</dd>
                  <dt>Failed checks in a row</dt><dd>{h?.data ? h.data.consecutiveFailures : "—"}</dd>
                  <dt>Total failed checks</dt><dd>{h?.data ? h.data.failureCount : "—"}</dd>
                  {h?.data?.openedAt ? (<><dt>Opened at</dt><dd>{h.data.openedAt}</dd></>) : null}
                  <dt>Last breaker event</dt><dd>{h?.data?.lastProbeAt ?? "— (no check recorded)"}</dd>
                  {h?.data?.lastFailureCode ? (<><dt>Last failure</dt><dd>{h.data.lastFailureCode}{h.data.lastFailureAt ? ` · ${h.data.lastFailureAt}` : ""}</dd></>) : null}
                  {h?.data?.latencyMs != null ? (<><dt>Last response</dt><dd>{h.data.latencyMs.toLocaleString()} ms</dd></>) : null}
                  <dt>Endpoint</dt><dd>{p.baseUrl}</dd>
                </dl>
              </div>
            </details>
          </div>
        );
      })}
    </div>
  );

  const body = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {[0, 1].map((i) => (
            <div key={i} className="card-row">
              <div className="flex items-start justify-between" style={{ gap: 12 }}>
                <div style={{ minWidth: 240 }}>
                  <div className="skeleton" style={{ width: 150, height: 14 }} />
                  <div className="skeleton mt-2" style={{ width: 250, height: 11 }} />
                  <div className="skeleton mt-1" style={{ width: 180, height: 11 }} />
                </div>
                <div className="skeleton" style={{ width: 130, height: 28 }} />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (isError) {
      return (
        <div className="notice notice-danger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><line x1={12} y1={8} x2={12} y2={12} /><line x1={12} y1={16} x2={12.01} y2={16} /></svg>
          <span>Couldn&apos;t load providers.</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => refetch()}>Retry</button>
        </div>
      );
    }
    if ((providers ?? []).length === 0) {
      return (
        <div className="empty-box">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }}><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7" /><path d="M21 3v6h-6" /></svg>
          <div className="text-sm weight-500 color-primary mt-1">No providers configured</div>
          <p className="text-xs color-secondary" style={{ maxWidth: 360 }}>Add a provider to start monitoring Assistant health.</p>
          <Link to="/admin/assistant/providers" className="btn btn-primary btn-sm mt-1" style={{ textDecoration: "none" }}>Add provider</Link>
        </div>
      );
    }
    return (
      <>
        <div className="health-legend mb-2">
          {(["working", "slow", "trouble", "offline", "unknown"] as HealthStatus[]).map((s) => (
            <span key={s} className="health-legend-item"><StatusPill status={s} /></span>
          ))}
        </div>
        {renderProviders(providers)}
      </>
    );
  };

  return (
    <section className="card-panel mt-4" id="gateway-health">
      <div className="flex items-center justify-between mb-2" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          <h2 className="font-display text-lg weight-500 color-primary">Gateway health</h2>
          {headerPill}
        </div>
        <button
          type="button"
          className={`btn ${worstIsAttention ? "btn-primary" : "btn-ghost"} btn-sm`}
          disabled={probe.isPending || !worstProviderId}
          onClick={() => worstProviderId && probe.mutate(worstProviderId)}
        >
          {probe.isPending && probe.variables === worstProviderId ? (
            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} />
          ) : (
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7" /><path d="M21 3v6h-6" /></svg>
          )}
          {worstIsAttention ? "Test failing provider" : "Test connection"}
        </button>
      </div>
      {!isLoading && !isError && (providers ?? []).length > 0 ? <div className="mb-3">{summaryLine}</div> : null}
      {body()}
    </section>
  );
}
