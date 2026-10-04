import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useAssistantOverviewSummary } from "../../../lib/assistant-usage.query";
import { useAssistantRuns } from "../../../lib/queries/assistant-admin";
import { useProjects } from "../../../lib/queries";
import { UsageKpiCards } from "../UsageKpiCards";
import { GatewayHealthSection } from "../GatewayHealthSection";
import { formatDuration, formatTimestamp, RunStatusChip, runKindLabel } from "./run-display";

export function AssistantOverviewSection() {
  const { data: usage } = useAssistantOverviewSummary();
  const { data: runs } = useAssistantRuns({ limit: 5 });
  const { data: projects } = useProjects();
  const projectById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
  const recent = runs?.data ?? [];

  return (
    <>
      <UsageKpiCards summary={usage?.summary} />

      <GatewayHealthSection />

      <section className="card-panel mt-4" style={{ overflow: "hidden", padding: 0 }}>
        <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <h2 className="font-display text-base weight-500 color-primary">Recent runs</h2>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="settings-table">
            <thead>
              <tr>
                <th style={{ width: 120 }}>Time</th>
                <th style={{ width: 130 }}>Project</th>
                <th>Document</th>
                <th style={{ width: 120 }}>Agent</th>
                <th style={{ width: 130 }}>Skill</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 80, textAlign: "right" }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "14px 12px" }}>
                    <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>No runs yet</div>
                  </td>
                </tr>
              ) : recent.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs color-secondary">{formatTimestamp(r.createdAt, { seconds: false })}</td>
                  <td className="text-xs weight-500 color-primary">{projectById.get(r.projectId)?.name ?? "—"}</td>
                  <td className="text-xs color-primary">
                    <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>{runKindLabel(r)}</span> · {r.documentTitle || "—"}
                  </td>
                  <td className="text-xs color-secondary">{r.agentName || "—"}</td>
                  <td className="text-xs color-secondary">{r.skillName || "—"}</td>
                  <td>
                    {r.status === "failed" ? (
                      <Link to="/admin/assistant/runs" style={{ textDecoration: "none" }}><RunStatusChip status={r.status} /></Link>
                    ) : (
                      <RunStatusChip status={r.status} />
                    )}
                  </td>
                  <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{formatDuration(r.startedAt, r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
