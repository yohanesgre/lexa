import { useRef } from "react";
import { Search, X } from "lucide-react";

interface WikiSearchBoxProps {
  query: string;
  focused: boolean;
  onQueryChange: (q: string) => void;
  onFocusedChange: (focused: boolean) => void;
}

export function WikiSearchBox({ query, focused, onQueryChange, onFocusedChange }: WikiSearchBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      {focused || query.length > 0 ? (
        <>
          <Search
            size={14}
            strokeWidth={1.5}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-lx-text-muted pointer-events-none"
          />
          <input
            ref={inputRef}
            type="text"
            className="prop-input w-full pl-8 pr-8"
            aria-label="Search wiki"
            placeholder="Search wiki..."
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onBlur={() => {
              if (query.length === 0) onFocusedChange(false);
            }}
            autoFocus
          />
          {query.length > 0 && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center rounded text-lx-text-muted hover:text-lx-text-primary"
              onClick={() => {
                onQueryChange("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          className="flex items-center gap-2 w-full h-8 px-3 text-left"
          onClick={() => onFocusedChange(true)}
        >
          <Search size={14} strokeWidth={1.5} className="text-lx-text-muted" />
          <span className="text-xs text-lx-text-muted font-body">Search wiki...</span>
        </button>
      )}
    </div>
  );
}
