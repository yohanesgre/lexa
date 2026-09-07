import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useHeraldMemory, useAddHeraldMemory, useRemoveHeraldMemory } from "../../../lib/queries";
import type { HeraldMemoryEntry } from "../../../lib/api";
import { formatRelative } from "../../../lib/relative-time";

export function ProjectMemorySection({ projectId }: { projectId: string }) {
  const { data: memories = [], isLoading } = useHeraldMemory(projectId);
  const addMemory = useAddHeraldMemory(projectId);
  const removeMemory = useRemoveHeraldMemory(projectId);
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    if (!draft.trim()) return;
    addMemory.mutate(draft.trim(), { onSuccess: () => setDraft("") });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Project memory</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Curated facts Herald should always know: decisions, constraints, preferences. At enqueue time the top terms of the task title + description FTS-match up to 5 entries (2000-char cap) into the system prompt. Task data does not belong here.
      </p>

      <div className="card-panel card-panel--elevated">
        {isLoading ? (
          <div className="skeleton" style={{ height: 80 }} />
        ) : memories.length === 0 ? (
          <div className="empty-box" style={{ padding: "20px 16px" }}>
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }}>
              <path d="M12 8a4 4 0 0 1 4 4" />
              <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" />
              <path d="M8 16h.01" />
              <path d="M8.5 19h7" />
            </svg>
            <div className="text-sm font-medium text-lx-text-primary mt-1">No memories yet</div>
            <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 360 }}>Add project conventions Herald should respect in every run. Leave empty to run without injected memory.</p>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 8 }}>
            {memories.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} onDelete={() => removeMemory.mutate(memory.id)} deleting={removeMemory.isPending && removeMemory.variables === memory.id} />
            ))}
          </div>
        )}

        {/* Add form stays visible in every state (stable page structure). */}
        <div className="mt-4" style={{ borderTop: "1px solid var(--lx-border-subtle)", paddingTop: 16 }}>
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <input
              className="prop-input flex-1"
              type="text"
              placeholder="Add a fact, constraint, or preference…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              aria-label="Add a fact, constraint, or preference"
              style={{ minWidth: 280 }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={handleAdd} disabled={addMemory.isPending || !draft.trim()}>
              <Plus size={12} strokeWidth={1.5} />
              Add
            </button>
          </div>
          <div className="field-hint">One fact per entry, phrased as a standing rule. Entries are matched by meaning at enqueue time, not quoted verbatim.</div>
        </div>
      </div>
    </section>
  );
}

function MemoryRow({ memory, onDelete, deleting }: { memory: HeraldMemoryEntry; onDelete: () => void; deleting: boolean }) {
  const isHerald = memory.source === "herald";
  return (
    <div className="card-row" style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div className="flex-1">
        <div className="text-sm text-lx-text-primary" style={{ lineHeight: "18px" }}>{memory.content}</div>
        <div className="flex items-center gap-2 mt-1">
          <span
            className="agent-tag"
            style={isHerald ? { background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", borderColor: "rgba(240,192,64,0.25)" } : undefined}
          >
            {memory.source}
          </span>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
            {isHerald ? `saved by Herald · ${formatRelative(memory.updatedAt)}` : `updated ${formatRelative(memory.updatedAt)}`}
          </span>
        </div>
      </div>
      <button type="button" className="btn btn-danger btn-icon-sm" title="Delete memory" aria-label={`Delete memory: ${memory.content}`} onClick={onDelete} disabled={deleting}>
        <Trash2 size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}
