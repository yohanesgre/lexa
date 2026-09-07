import { useState } from "react";
import { useHeraldProviders, useTestProvider, useFetchModels } from "../../lib/queries/herald-admin";
import type { HeraldProvider } from "../../../shared/herald";
import { WarningNotice } from "../ui/NoticeWarning";
import { HeraldProviderRow } from "./HeraldProviderRow";
import type { ProviderTestState } from "./HeraldProviderRow";
import { HeraldProviderForm } from "./HeraldProviderForm";
import { HeraldProviderDeleteDialog } from "./HeraldProviderDeleteDialog";

// Workspace → Herald Providers registry (superadmin-gated). Projects pick a
// provider + model from this list; keys and base URLs live only here.
export function HeraldProvidersSection() {
  const { data: providers = [], isLoading } = useHeraldProviders();
  const test = useTestProvider();
  const fetchModels = useFetchModels();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestState>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const editing: HeraldProvider | null = editingId ? providers.find((p) => p.id === editingId) ?? null : null;

  const toggle = (id: string) => setExpanded((prev) => (prev === id ? null : id));

  const handleTest = (id: string) => {
    setTestResults((m) => ({ ...m, [id]: { state: "pending" } }));
    test.mutate(id, {
      onSuccess: (res) => setTestResults((m) => ({ ...m, [id]: { state: "ok", latencyMs: res.latencyMs } })),
      onError: (err) => {
        const e = err as { code?: string | undefined; message?: string | undefined };
        setTestResults((m) => ({ ...m, [id]: { state: "fail", code: e.code ?? "PROVIDER_UNREACHABLE", message: e.message } }));
      },
    });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Herald Providers</h2>
          <span className="text-xs text-lx-text-muted">superadmin-gated</span>
        </div>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Central registry of LLM providers Herald can use. Projects pick a primary provider + model from this list; the registry owns base URLs, keys, and the enabled model catalog. Keys are write-only (masked on read, never serialized).
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: "28%" }}>Label</th><th style={{ width: "38%" }}>Base URL</th><th style={{ width: "14%" }}>Models</th><th style={{ width: "20%", textAlign: "right" }}>Actions</th></tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <HeraldProviderRow
                  key={p.id}
                  provider={p}
                  expanded={expanded === p.id}
                  testState={testResults[p.id]}
                  fetchPending={fetchModels.isPending}
                  onToggle={() => toggle(p.id)}
                  onTest={() => handleTest(p.id)}
                  onFetch={() => fetchModels.mutate(p.id)}
                  onEdit={() => setEditingId(p.id)}
                  onDelete={() => setDeleteConfirm(p.id)}
                />
              ))}
              {providers.length === 0 && (
                <tr><td colSpan={4} className="text-sm text-lx-text-muted" style={{ textAlign: "center", padding: 24 }}>No providers yet — add one below.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <HeraldProviderForm key={editingId ?? "new"} editing={editing} onCancel={() => setEditingId(null)} />

      {providers.length === 0 && (
        <WarningNotice className="mt-4" title="No providers yet">
          Add a provider above to enable Herald. Projects cannot select a model until at least one provider has enabled models.
        </WarningNotice>
      )}

      {deleteConfirm && (
        <HeraldProviderDeleteDialog providerId={deleteConfirm} onClose={() => setDeleteConfirm(null)} />
      )}
    </section>
  );
}
