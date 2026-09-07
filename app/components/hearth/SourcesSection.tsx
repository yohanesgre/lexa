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

// "@" is the explicit wiki mention trigger: it opens the page list even with
// an empty query and always adds by validated slug.
function resolveWikiMatches(wikiPages: WikiPageMeta[], mention: boolean, query: string): WikiPageMeta[] {
  if (query) {
    return wikiPages.filter((p) => p.title.toLowerCase().includes(query.toLowerCase())).slice(0, mention ? 8 : 5);
  }
  return mention ? wikiPages.slice(0, 8) : [];
}

function moveHighlight(h: number, delta: number, len: number): number {
  return (h + delta + len) % len;
}

interface SourceKeyContext {
  openWithMatches: boolean;
  matchCount: number;
  highlight: number;
  onMoveHighlight: (next: number) => void;
  onSelectMatch: () => void;
  onEscape: () => void;
  onAdd: () => void;
}

function handleSourceKeyDown(e: React.KeyboardEvent<HTMLInputElement>, ctx: SourceKeyContext): void {
  if (e.key === "ArrowDown" && ctx.openWithMatches) {
    e.preventDefault();
    ctx.onMoveHighlight(moveHighlight(ctx.highlight, 1, ctx.matchCount));
  } else if (e.key === "ArrowUp" && ctx.openWithMatches) {
    e.preventDefault();
    ctx.onMoveHighlight(moveHighlight(ctx.highlight, -1, ctx.matchCount));
  } else if (e.key === "Enter" && ctx.openWithMatches) {
    e.preventDefault();
    ctx.onSelectMatch();
  } else if (e.key === "Escape") {
    ctx.onEscape();
  } else if (e.key === "Enter") {
    ctx.onAdd();
  }
}

function SourceRow({ title, kind, onRemove }: { title: string; kind: string; onRemove: () => void }) {
  return (
    <div className="github-issue-row">
      <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
        {kind === "wiki" ? (
          <BookOpen size={12} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />
        ) : (
          <Globe size={12} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />
        )}
        <span className="text-sm text-lx-text-secondary truncate">{title}</span>
        <span className="font-micro text-2xs text-lx-text-muted">{kind}</span>
      </div>
      <button
        type="button"
        className="icon-btn"
        title="Remove source"
        aria-label="Remove source"
        style={{ width: 20, height: 20 }}
        onClick={onRemove}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

function WikiDropdown({ matches, pages, query, highlight, onSelect, onHover }: {
  matches: WikiPageMeta[];
  pages: WikiPageMeta[];
  query: string;
  highlight: number;
  onSelect: (page: WikiPageMeta) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="menu-popover" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, maxHeight: 224, overflowY: "auto" }}>
      {matches.length === 0 ? (
        <div className="menu-item" style={{ cursor: "default" }}>
          {pages.length === 0 ? "No wiki pages in this project yet" : `No wiki pages match "${query}"`}
        </div>
      ) : (
        matches.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={cn("menu-item", i === highlight && "active")}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(p)}
          >
            <BookOpen size={12} strokeWidth={1.5} />
            <span className="truncate" style={{ flex: 1, textAlign: "left" }}>{p.title}</span>
            <span className="font-micro text-2xs text-lx-text-muted flex-shrink-0">{p.slug}</span>
          </button>
        ))
      )}
    </div>
  );
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

  const mention = value.trim().startsWith("@");
  const query = mention ? value.trim().slice(1).trim() : value.trim();
  const wikiMatches = resolveWikiMatches(wikiPages, mention, query);
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    handleSourceKeyDown(e, {
      openWithMatches: dropdownOpen && wikiMatches.length > 0,
      matchCount: wikiMatches.length,
      highlight,
      onMoveHighlight: setHighlight,
      onSelectMatch: () => selectWiki(wikiMatches[highlight >= 0 ? highlight : 0]!),
      onEscape: () => setFocused(false),
      onAdd: handleAdd,
    });
  };

  return (
    <div className={cn(className)}>
      <div className="flex items-center gap-2 mb-2">
        <BookOpen size={14} strokeWidth={1.5} className="text-lx-text-muted" />
        <span className="prop-label">Sources</span>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">used by Hearth</span>
      </div>

      {sources.map((s) => (
        <SourceRow key={s.id} title={s.title} kind={s.kind} onRemove={() => removeSource.mutate(s.id)} />
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
            onKeyDown={handleKeyDown}
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
          <WikiDropdown
            matches={wikiMatches}
            pages={wikiPages}
            query={query}
            highlight={highlight}
            onSelect={selectWiki}
            onHover={setHighlight}
          />
        )}
      </div>
    </div>
  );
}
