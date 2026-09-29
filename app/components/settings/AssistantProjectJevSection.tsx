import { useProjectJev, useSetProjectJev } from "../../lib/queries/assistant-admin";
import type { Project } from "../../../shared/types";

// Per-project Jev advisory opt-in (wireframe settings-project-herald.html §Jev
// advisory). DEFAULT OFF: absence of a stored row renders as disabled. The
// toggle is disabled while the global Jev config is missing, disabled, or
// key-less — the server reports that as `available === false`, which a member
// can read without superadmin access to the global GET.
export function AssistantProjectJevSection({ project }: { project: Project }) {
  const { data, isLoading, isError } = useProjectJev(project.id);
  const save = useSetProjectJev(project.id);

  const available = data?.available ?? false;
  const enabled = data?.enabled ?? false;
  // A failed BACKGROUND refetch reports `isError` with cached data present;
  // only a first-load failure (no data) swaps in the error surface.
  const showError = isError && !data;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Jev advisory</h2>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">direct Typesafe REST</span>
          <span className="text-xs text-lx-text-muted">default off</span>
        </div>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>

      {showError ? (
        <div className="card-panel card-panel--elevated">
          <div className="text-sm text-lx-text-muted py-6 text-center">Could not load Jev advisory settings.</div>
        </div>
      ) : isLoading || !data ? (
        <div className="card-panel card-panel--elevated">
          <div className="text-sm text-lx-text-muted py-6 text-center">Loading…</div>
        </div>
      ) : (
        <div className="field" style={{ marginBottom: 0 }}>
          <div className="flex items-center gap-3" style={{ marginBottom: 8 }}>
            <button
              type="button"
              className={`toggle-switch${enabled ? " is-on" : ""}`}
              aria-label={available ? (enabled ? "Jev advisory enabled for this project" : "Jev advisory disabled for this project") : "Jev advisory unavailable"}
              aria-pressed={enabled}
              disabled={!available || save.isPending}
              style={available ? undefined : { opacity: 0.45 }}
              onClick={() => save.mutate({ enabled: !enabled })}
            />
            <span className={`text-xs ${available ? "text-lx-text-secondary" : "text-lx-text-muted"}`}>
              {available
                ? enabled
                  ? <>Advisory preflight + <span className="font-mono">jev_assess</span> offered on this project&apos;s runs.</>
                  : <>No Jev preflight and no <span className="font-mono">jev_assess</span> tool on this project&apos;s runs.</>
                : "Jev is not configured globally."}
            </span>
          </div>

          {!available && (
            <div className="notice notice-warning">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              <span>Configure Jev in Admin → Assistant → Providers &amp; Models</span>
            </div>
          )}

          <div className="field-hint">Per-project opt-in for the Jev advisory preflight and the read-only <span className="font-mono">jev_assess</span> tool. Absence of a stored row renders as disabled — opt-in, never opt-out. The toggle is disabled while the global Jev config is missing, disabled, or key-less.</div>
        </div>
      )}
    </section>
  );
}
