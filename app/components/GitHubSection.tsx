import { useEffect, useMemo, useRef, useState } from "react";
import type { GithubIssue, GithubIssueSummary } from "../../shared/types";
import { cn } from "./ui/cn";
import { X } from "lucide-react";
import { GithubMark, LinkIcon } from "./icons";
import { useProjectRepos, useGithubIssueSearch, useLinkExistingIssue } from "../lib/queries";

interface GitHubSectionProps {
  taskId: string;
  slug: string;
  githubs: GithubIssue[];
  columnGithubState: "open" | "closed" | null;
  onLink: (taskId: string, repo: string) => Promise<{ repo: string; issueNumber: number } | null | undefined>;
  onUnlink: (taskId: string, issueId: string) => Promise<void>;
}

function divergence(g: GithubIssue): { label: string; diverged: boolean } {
  if (!g.outOfSync && !g.pushFailed) return { label: "Synced", diverged: false };
  if (g.outOfSync && g.pushFailed) return { label: "Out of sync — both", diverged: true };
  if (g.outOfSync) return { label: "Out of sync — state", diverged: true };
  return { label: "Out of sync — edit not pushed", diverged: true };
}

function LinkedIssuesList({ githubs, onUnlinkClick }: { githubs: GithubIssue[]; onUnlinkClick: (g: GithubIssue) => void }) {
  const hasDiverged = githubs.some((g) => g.outOfSync || g.pushFailed);
  return (
    <div>
      {githubs.map((g) => {
        const d = divergence(g);
        return (
          <div
            key={g.issueId}
            className={cn("card-row", d.diverged ? "card-row--danger" : "card-row--success")}
            style={{ marginBottom: 8 }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <GithubMark size={14} className="text-lx-text-link shrink-0" />
                <a href={g.url} target="_blank" rel="noreferrer" className="font-mono text-sm font-medium text-lx-text-link whitespace-nowrap">
                  {g.repo} #{g.issueNumber}
                </a>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className="sync-dot"
                  style={d.diverged ? { background: "var(--lx-text-danger)" } : undefined}
                />
                <span
                  className={cn(
                    "font-micro text-2xs uppercase tracking-[0.04em]",
                    d.diverged ? "text-lx-text-danger" : "text-lx-text-success"
                  )}
                >
                  {d.label}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost !w-6 !h-6 !p-0"
                  title="Unlink issue"
                  onClick={() => onUnlinkClick(g)}
                >
                  <X size={12} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {hasDiverged && (
        <p className="text-xs text-lx-text-muted mt-1 leading-4">
          Divergence reasons: <span className="font-mono">— state</span> (fix: move the task to the mapped column) · <span className="font-mono">— edit not pushed</span> (fix: the next task edit re-pushes) · <span className="font-mono">— both</span>.
        </p>
      )}
    </div>
  );
}

function IssueSearchResults({ results, activeIndex, onHover, onPick }: {
  results: GithubIssueSummary[];
  activeIndex: number;
  onHover: (i: number) => void;
  onPick: (r: GithubIssueSummary) => void;
}) {
  return (
    <div className="mt-1 card-row" style={{ overflow: "hidden" }}>
      {results.map((r, i) => (
        <button
          type="button"
          key={r.number}
          className="flex items-center gap-2 w-full text-left"
          style={{
            padding: "8px 12px",
            background: i === activeIndex ? "var(--lx-surface-selected)" : undefined,
            borderLeft: i === activeIndex ? "2px solid var(--lx-text-link)" : "2px solid transparent",
          }}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(r)}
        >
          <span className="font-mono text-xs text-lx-text-link shrink-0">#{r.number}</span>
          <span className="text-sm text-lx-text-primary truncate">{r.title}</span>
          <span className={cn("text-2xs font-micro uppercase tracking-[0.04em] ml-auto shrink-0", r.state === "open" ? "text-lx-text-success" : "text-lx-text-muted")}>
            {r.state}
          </span>
        </button>
      ))}
    </div>
  );
}

function LinkFlowPanel({ repos, selectedRepo, onRepoChange, query, onQueryChange, onKeyDown, results, activeIndex, onHoverIndex, onPick, onNewIssue }: {
  repos: string[];
  selectedRepo: string;
  onRepoChange: (repo: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  results: GithubIssueSummary[];
  activeIndex: number;
  onHoverIndex: (index: number) => void;
  onPick: (result: GithubIssueSummary) => void;
  onNewIssue: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2" style={{ alignItems: "stretch" }}>
        <select
          className="prop-input"
          style={{ minWidth: 170 }}
          aria-label="GitHub repository"
          value={selectedRepo}
          onChange={(e) => onRepoChange(e.target.value)}
        >
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <input
          ref={searchRef}
          className="prop-input font-mono flex-1"
          aria-label="Search issue number or title"
          placeholder="Search issue # or title…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="btn btn-ghost-accent shrink-0" onClick={onNewIssue}>
          + New issue
        </button>
      </div>
      {query.trim() && results.length > 0 && (
        <IssueSearchResults
          results={results}
          activeIndex={activeIndex}
          onHover={onHoverIndex}
          onPick={onPick}
        />
      )}
      <p className="text-xs text-lx-text-muted mt-2 leading-4">
        Search runs in the selected repo only (#number or title). Picking one links it — two-way state sync starts immediately.
      </p>
    </div>
  );
}

function NewIssuePanel({ repos, selectedRepo, onRepoChange, onCreate, onCancel, creating }: {
  repos: string[];
  selectedRepo: string;
  onRepoChange: (repo: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  creating: boolean;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <select
          className="prop-input"
          style={{ minWidth: 170 }}
          aria-label="GitHub repository"
          value={selectedRepo}
          onChange={(e) => onRepoChange(e.target.value)}
        >
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button type="button" className="btn btn-primary shrink-0" onClick={onCreate} disabled={creating}>
          {creating ? (
            <>
              <span className="spinner" />
              Creating...
            </>
          ) : (
            "Create issue"
          )}
        </button>
        <button
          type="button"
          className="btn btn-ghost shrink-0"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      <p className="text-xs text-lx-text-muted mt-2 leading-4">
        Creates a GitHub issue from this task and links it. Title + description are seeded from the task. Confirmation modal confirms the external side effect.
      </p>
    </div>
  );
}

export function GitHubSection({ taskId, slug, githubs, columnGithubState, onLink, onUnlink }: GitHubSectionProps) {
  const { data: repos } = useProjectRepos(slug);
  const workspaceRepos = useMemo(() => {
    const out: string[] = [];
    for (const r of repos ?? []) if (r.workspaceRole) out.push(r.repo);
    return out;
  }, [repos]);

  const [flowOpen, setFlowOpen] = useState(false);
  const [flowMode, setFlowMode] = useState<"link" | "newIssue">("link");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState<GithubIssue | null>(null);

  // Keep the selected repo valid when the workspace repo list arrives or
  // changes — adjust during render (React docs pattern), not in an effect.
  const [prevRepos, setPrevRepos] = useState(workspaceRepos);
  if (prevRepos !== workspaceRepos) {
    setPrevRepos(workspaceRepos);
    if (workspaceRepos.length > 0 && !workspaceRepos.includes(selectedRepo)) {
      setSelectedRepo(workspaceRepos[0]!);
    }
  }

  const issueSearch = useGithubIssueSearch(slug, selectedRepo, query);
  const linkExisting = useLinkExistingIssue(slug);

  const linkedKeys = useMemo(() => new Set(githubs.map((g) => `${g.repo}#${g.issueNumber}`)), [githubs]);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return (issueSearch.data ?? []).filter((i) => !linkedKeys.has(`${selectedRepo}#${i.number}`));
  }, [issueSearch.data, query, selectedRepo, linkedKeys]);

  // Dialogs must swallow Escape before TaskDetail's window handler closes the slideover.
  useEffect(() => {
    if (!confirmCreate && !confirmUnlink) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setConfirmCreate(false);
        setConfirmUnlink(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmCreate, confirmUnlink]);

  const openFlow = (mode: "link" | "newIssue" = "link") => {
    setFlowMode(mode);
    setFlowOpen(true);
  };

  const changeRepo = (repo: string) => {
    setSelectedRepo(repo);
    setQuery("");
    setActiveIndex(0);
  };

  const handlePick = async (issue: GithubIssueSummary) => {
    try {
      await linkExisting.mutateAsync({ taskId, repo: selectedRepo, issueNumber: issue.number });
      setQuery("");
      setActiveIndex(0);
      setFlowOpen(false);
    } catch {
      // error toast comes from the mutation
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setQuery("");
        setFlowOpen(false);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void handlePick(results[activeIndex]!);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (query) {
        setQuery("");
        setActiveIndex(0);
      } else {
        setFlowOpen(false);
      }
    }
  };

  const handleCreateConfirm = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await onLink(taskId, selectedRepo);
      setConfirmCreate(false);
      setFlowOpen(false);
      setFlowMode("link");
      setQuery("");
    } catch {
      // error toast comes from the mutation
    } finally {
      setCreating(false);
    }
  };

  const handleUnlinkConfirm = async () => {
    if (!confirmUnlink) return;
    try {
      await onUnlink(taskId, confirmUnlink.issueId);
      setConfirmUnlink(null);
    } catch {
      // error toast comes from the mutation
    }
  };

  return (
    <div className="github-section mt-4 pt-4">
      <div className="flex items-center gap-2 mb-2">
        <GithubMark size={14} className="text-lx-text-muted" />
        <span className="prop-label">GitHub</span>
        {githubs.length > 0 && !flowOpen && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 24, padding: "0 8px", fontSize: 11 }}
            onClick={() => openFlow("link")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14m-7-7h14" /></svg>
            Link issue
          </button>
        )}
        {workspaceRepos.length > 0 && (
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em] ml-auto">
            Workspace: {workspaceRepos.join(" · ")}
          </span>
        )}
      </div>

      {githubs.length > 0 && (
        <LinkedIssuesList githubs={githubs} onUnlinkClick={setConfirmUnlink} />
      )}

      {githubs.length === 0 && !flowOpen && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GithubMark size={14} className="text-lx-text-muted" />
            <span className="text-sm text-lx-text-muted font-body">No issue linked</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="sync-dot sync-unlinked" />
            <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">
              Unlinked
            </span>
          </div>
        </div>
      )}

      {githubs.length === 0 && !flowOpen && (
        <div className="mt-3">
          <button type="button" className="btn btn-ghost" onClick={() => openFlow("link")}>
            <LinkIcon size={14} />
            Link issue
          </button>
        </div>
      )}

      {flowOpen &&
        (workspaceRepos.length === 0 ? (
          <p className="text-xs text-lx-text-muted mt-3 leading-4">
            No workspace repos — add one in Settings → GitHub Sync
          </p>
        ) : flowMode === "link" ? (
          <LinkFlowPanel
            repos={workspaceRepos}
            selectedRepo={selectedRepo}
            onRepoChange={changeRepo}
            query={query}
            onQueryChange={(q) => {
              setQuery(q);
              setActiveIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
            results={results}
            activeIndex={activeIndex}
            onHoverIndex={setActiveIndex}
            onPick={(r) => void handlePick(r)}
            onNewIssue={() => openFlow("newIssue")}
          />
        ) : (
          <NewIssuePanel
            repos={workspaceRepos}
            selectedRepo={selectedRepo}
            onRepoChange={changeRepo}
            onCreate={() => setConfirmCreate(true)}
            onCancel={() => {
              setFlowMode("link");
              setQuery("");
            }}
            creating={creating}
          />
        ))}

      {confirmCreate && (
        <>
          <button type="button" className="dialog-overlay" onClick={() => setConfirmCreate(false)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
            <dialog open className="dialog dialog-enter" aria-modal="true" aria-labelledby="gh-create-title">
              {columnGithubState === "closed" ? (
                <>
                  <h2 id="gh-create-title" className="font-display text-lg font-medium text-lx-text-primary">Create issue in a closed column?</h2>
                  <p className="text-sm text-lx-text-secondary mt-3 leading-5" style={{ maxWidth: 360 }}>
                    This task's column maps to <span className="font-mono text-xs">closed</span>. The new issue will start <span className="font-mono text-xs">open</span> and show out of sync until the task is moved to the mapped column.
                  </p>
                  <div className="flex items-center gap-2 mt-4 justify-end">
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmCreate(false)}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={() => void handleCreateConfirm()} disabled={creating}>
                      {creating ? "Creating..." : "Create issue anyway"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2 id="gh-create-title" className="font-display text-lg font-medium text-lx-text-primary">Create GitHub issue in <span className="font-mono text-sm">{selectedRepo}</span> from this task?</h2>
                  <p className="text-sm text-lx-text-secondary mt-3 leading-5" style={{ maxWidth: 360 }}>
                    Creates a GitHub issue from this task and links it. Title + description are seeded from the task.
                  </p>
                  <div className="flex items-center gap-2 mt-4 justify-end">
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmCreate(false)}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={() => void handleCreateConfirm()} disabled={creating}>
                      {creating ? "Creating..." : "Create issue"}
                    </button>
                  </div>
                </>
              )}
            </dialog>
          </div>
        </>
      )}

      {confirmUnlink && (
        <>
          <button type="button" className="dialog-overlay" onClick={() => setConfirmUnlink(null)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
            <dialog open className="dialog dialog-enter" aria-modal="true" aria-labelledby="gh-unlink-title">
              <h2 id="gh-unlink-title" className="font-display text-lg font-medium text-lx-text-primary">Unlink issue?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5" style={{ maxWidth: 360 }}>
                Unlink <span className="font-mono text-xs">{confirmUnlink.repo} #{confirmUnlink.issueNumber}</span> from this task? The GitHub issue stays open; only the link is removed.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmUnlink(null)}>Cancel</button>
                <button type="button" className="btn btn-danger-solid" onClick={() => void handleUnlinkConfirm()}>Unlink</button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </div>
  );
}
