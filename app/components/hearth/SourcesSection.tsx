import { useState } from "react";
import { BookOpen, Globe, Plus, X } from "lucide-react";
import { useAddSource, useRemoveSource, useSources, useWikiPages } from "../../lib/queries";
import { cn } from "../ui/cn";
import type { WikiPageMeta } from "../../../shared/types";

interface SourcesSectionProps {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  className?: string | undefined;
}

export function SourcesSection({ slug, documentType, documentId, className }: SourcesSectionProps) {
  const { data: sources = [] } = useSources(slug, documentType, documentId);
  const addSource = useAddSource(slug, documentType, documentId);
  const removeSource = useRemoveSource(slug, documentType, documentId);
  const { data: wikiPages = [] } = useWikiPages(slug);

  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [adding, setAdding] = useState(false);

  // "@" is the explicit wiki mention trigger: it opens the page list even with
  // an empty query and always adds by validated slug.
  const mention = value.trim().startsWith("@");
  const query = mention ? value.trim().slice(1).trim() : value.trim();

  const wikiMatches = query
    ? wikiPages.filter((p) => p.title.toLowerCase().includes(query.toLowerCase())).slice(0, mention ? 8 : 5)
    : mention
      ? wikiPages.slice(0, 8)
      : [];

  const dropdownOpen = focused && value.trim().length > 0 && (mention || wikiMatches.length > 0);

  const selectWiki = (page: WikiPageMeta) => {
    addSource.mutate(
      { kind: "wiki", ref: page.slug },
      {
        onSettled: () => {
          setValue("");
          setHighlight(-1);
        },
      }
    );
  };

  const handleAdd = () => {
    const v = value.trim();
    if (!v) return;
    if (mention) {
      if (wikiMatches.length === 0) return;
      selectWiki(wikiMatches[highlight >= 0 ? highlight : 0]!);
      return;
    }
    const looksLikeUrl = /^https?:\/\//i.test(v);
    setAdding(true);
    addSource.mutate(
      { kind: looksLikeUrl ? "external" : "wiki", ref: v },
      {
        onSettled: () => {
          setAdding(false);
          setValue("");
        },
      }
    );
  };

  return (
    <div className={cn(className)}>
      <div className="flex items-center gap-2 mb-2">
        <BookOpen size={14} strokeWidth={1.5} className="text-lx-text-muted" />
        <span className="prop-label">Sources</span>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">used by Hearth</span>
      </div>

      {sources.map((s) => (
        <div
          key={s.id}
          className="github-issue-row"
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
          No sources yet. Type @ to pick a wiki page, or paste a URL — Hearth grounds its writing in these.
        </div>
      )}

      <div style={{ position: "relative" }}>
        <div className="flex items-center gap-2">
          <input
            className="prop-input"
            aria-label="Add source — type @ for a wiki page or paste a URL"
            placeholder="Add source — type @ for a wiki page or paste a URL…"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setHighlight(-1);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && dropdownOpen && wikiMatches.length > 0) {
                e.preventDefault();
                setHighlight((h) => (h + 1) % wikiMatches.length);
              } else if (e.key === "ArrowUp" && dropdownOpen && wikiMatches.length > 0) {
                e.preventDefault();
                setHighlight((h) => (h - 1 + wikiMatches.length) % wikiMatches.length);
              } else if (e.key === "Enter" && dropdownOpen && wikiMatches.length > 0) {
                e.preventDefault();
                selectWiki(wikiMatches[highlight >= 0 ? highlight : 0]!);
              } else if (e.key === "Escape") {
                setFocused(false);
              } else if (e.key === "Enter") {
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
            disabled={!value.trim() || adding || (mention && wikiMatches.length === 0)}
          >
            <Plus size={12} strokeWidth={1.5} />
            {adding ? "Adding…" : "Add"}
          </button>
        </div>

        {dropdownOpen && (
          <div className="menu-popover" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, maxHeight: 224, overflowY: "auto" }}>
            {wikiMatches.length === 0 ? (
              <div className="menu-item" style={{ cursor: "default" }}>
                {wikiPages.length === 0 ? "No wiki pages in this project yet" : `No wiki pages match "${query}"`}
              </div>
            ) : (
              wikiMatches.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className={cn("menu-item", i === highlight && "active")}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => selectWiki(p)}
                >
                  <BookOpen size={12} strokeWidth={1.5} />
                  <span className="truncate" style={{ flex: 1, textAlign: "left" }}>{p.title}</span>
                  <span className="font-micro text-2xs text-lx-text-muted flex-shrink-0">{p.slug}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}