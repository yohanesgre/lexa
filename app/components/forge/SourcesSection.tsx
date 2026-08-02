import { useState } from "react";
import { BookOpen, Globe, Plus, X } from "lucide-react";
import { useAddSource, useRemoveSource, useSources, useWikiPages } from "../../lib/queries";
import { cn } from "../ui/cn";

interface SourcesSectionProps {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  className?: string;
}

export function SourcesSection({ slug, documentType, documentId, className }: SourcesSectionProps) {
  const { data: sources = [] } = useSources(slug, documentType, documentId);
  const addSource = useAddSource(slug, documentType, documentId);
  const removeSource = useRemoveSource(slug, documentType, documentId);
  const { data: wikiPages = [] } = useWikiPages(slug);

  const [value, setValue] = useState("");
  const [showWikiResults, setShowWikiResults] = useState(false);
  const [adding, setAdding] = useState(false);

  const wikiMatches = value.trim()
    ? wikiPages.filter((p) => p.title.toLowerCase().includes(value.trim().toLowerCase())).slice(0, 5)
    : [];

  const handleAdd = () => {
    const v = value.trim();
    if (!v) return;
    const looksLikeUrl = /^https?:\/\//i.test(v);
    setAdding(true);
    addSource.mutate(
      { kind: looksLikeUrl ? "external" : "wiki", ref: v },
      {
        onSettled: () => {
          setAdding(false);
          setValue("");
          setShowWikiResults(false);
        },
      }
    );
  };

  return (
    <div className={cn(className)}>
      <div className="flex items-center gap-2 mb-2">
        <BookOpen size={14} strokeWidth={1.5} className="text-lx-text-muted" />
        <span className="prop-label">Sources</span>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">used by Forge</span>
      </div>

      {sources.map((s) => (
        <div
          key={s.id}
          className="flex items-center justify-between"
          style={{ padding: "6px 10px", background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 6, marginBottom: 4 }}
        >
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            {s.kind === "wiki" ? (
              <BookOpen size={12} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />
            ) : (
              <Globe size={12} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />
            )}
            <span className="text-sm text-lx-text-secondary truncate">{s.title}</span>
            <span className="font-micro text-2xs text-lx-text-muted">{s.kind}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="Remove source"
            aria-label="Remove source"
            style={{ width: 20, height: 20 }}
            onClick={() => removeSource.mutate(s.id)}
          >
            <X size={10} strokeWidth={2} />
          </button>
        </div>
      ))}

      {sources.length === 0 && (
        <div className="text-xs text-lx-text-muted mb-2">
          No sources yet. Add a wiki page or URL for Forge to ground its writing in.
        </div>
      )}

      <div style={{ position: "relative" }}>
        <div className="flex items-center gap-2">
          <input
            className="prop-input"
            placeholder="Add wiki page or URL…"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setShowWikiResults(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            style={{ flex: 1, height: 28, fontSize: 12, minWidth: 0 }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 26, padding: "0 8px", fontSize: 12, flexShrink: 0 }}
            onClick={handleAdd}
            disabled={!value.trim() || adding}
          >
            <Plus size={12} strokeWidth={1.5} />
            {adding ? "Adding…" : "Add"}
          </button>
        </div>

        {showWikiResults && value.trim() && wikiMatches.length > 0 && (
          <div className="menu-popover" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30 }}>
            {wikiMatches.map((p) => (
              <button
                key={p.id}
                type="button"
                className="menu-item"
                onClick={() => {
                  addSource.mutate({ kind: "wiki", ref: p.slug }, { onSettled: () => { setValue(""); setShowWikiResults(false); } });
                }}
              >
                <BookOpen size={12} strokeWidth={1.5} />
                {p.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
