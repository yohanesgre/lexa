import { useState } from "react";
import type { GithubIssue } from "../../shared/types";
import { cn } from "./ui/cn";
import { X } from "lucide-react";
import { GithubMark, LinkIcon } from "./icons";

interface GitHubSectionProps {
  githubs: GithubIssue[];
  taskId: string;
  linkState: "idle" | "input" | "loading" | "success";
  linkRepo: string;
  linkedIssue: { repo: string; number: number } | null;
  setLinkState: (v: "idle" | "input" | "loading" | "success") => void;
  setLinkRepo: (v: string) => void;
  onLink: (taskId: string, repo: string) => Promise<{ repo: string; issueNumber: number } | null | undefined>;
  onUnlink: (taskId: string, issueId: string) => Promise<void>;
}

export function GitHubSection({ githubs, taskId, linkState, linkRepo, linkedIssue, setLinkState, setLinkRepo, onLink, onUnlink }: GitHubSectionProps) {
  const handleLinkIssue = async () => {
    if (!taskId || !linkRepo.trim()) return;
    setLinkState("loading");
    try {
      await onLink(taskId, linkRepo.trim());
      setLinkState("success");
    } catch {
      setLinkState("idle");
    }
  };
  const handleUnlinkIssue = async (issueId: string) => {
    try {
      await onUnlink(taskId, issueId);
    } catch {
      // error toast comes from the mutation
    }
  };
  return (
<div className="github-section mt-4 pt-4">
  {githubs.length > 0 ? (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <GithubMark size={14} className="text-lx-text-muted" />
        <span className="prop-label">GitHub Issues</span>
        <button type="button" className="btn btn-ghost" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setLinkState("input")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14m-7-7h14"/></svg>
          Link issue
        </button>
      </div>
      <div>
      {githubs.map(g => (
        <div key={g.issueId} className={cn("github-issue-row", g.outOfSync && "github-warning")}>
          <div className="flex items-center justify-between w-full">
            <a href={g.url} target="_blank" rel="noreferrer" className="flex items-center gap-2">
              <GithubMark size={14} className="text-lx-text-link" />
              <span className="font-mono text-sm font-medium text-lx-text-link">
                {g.repo} #{g.issueNumber}
              </span>
            </a>
            <div className="flex items-center gap-1">
              <div className="flex items-center gap-2">
                <span className={cn("sync-dot", g.outOfSync ? "sync-diverged" : "sync-synced")} />
                <span
                  className={cn(
                    "font-micro text-2xs uppercase tracking-[0.04em]",
                    g.outOfSync ? "text-lx-text-warning" : "text-lx-text-success"
                  )}
                >
                  {g.outOfSync ? "Diverged" : "Synced"}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost !w-6 !h-6 !p-0"
                title="Unlink issue"
                onClick={() => handleUnlinkIssue(g.issueId)}
              >
                <X size={12} strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
      </div>
  ) : (
    <>
      {linkState === "success" && linkedIssue ? (
        <div className="github-link-success">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GithubMark size={14} className="text-lx-text-link" />
              <span className="font-mono text-sm font-medium text-lx-text-link">
                {linkedIssue.repo} #{linkedIssue.number}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="sync-dot sync-synced" />
              <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-success">
                Synced
              </span>
            </div>
          </div>
          <p className="text-xs text-lx-text-secondary mt-2 leading-4">
            Issue created and linked. Column changes now sync with GitHub.
          </p>
        </div>
      ) : (
        <>
          {linkState === "idle" && (
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
          {(linkState === "input" || linkState === "loading") && (
            <div className="flex items-center gap-2">
              <GithubMark size={14} className="text-lx-text-muted" />
              <span className="text-sm text-lx-text-muted font-body">GitHub Issues</span>
            </div>
          )}
          {linkState === "input" && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <input
                  className="prop-input font-mono flex-1"
                  aria-label="GitHub repository (owner/repo)"
                  placeholder="owner/repo"
                  value={linkRepo}
                  onChange={(e) => setLinkRepo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && linkRepo.trim()) {
                      e.preventDefault();
                      handleLinkIssue();
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setLinkState("idle");
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn btn-primary shrink-0"
                  onClick={handleLinkIssue}
                  disabled={!linkRepo.trim()}
                >
                  Create issue
                </button>
              </div>
              <p className="text-xs text-lx-text-muted mt-2 leading-4">
                Creates a GitHub issue from this task and links it.
              </p>
            </div>
          )}
          {linkState === "loading" && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <input
                  className="prop-input font-mono flex-1 opacity-50"
                  aria-label="GitHub repository (owner/repo)"
                  value={linkRepo}
                  disabled
                />
                <button type="button" className="btn btn-primary shrink-0 opacity-70" disabled>
                  <span className="spinner" />
                  Creating...
                </button>
              </div>
            </div>
          )}
          {linkState === "idle" && (
            <div className="mt-3">
              <button type="button" className="btn btn-ghost" onClick={() => setLinkState("input")}>
                <LinkIcon size={14} />
                Link issue
              </button>
            </div>
          )}
        </>
      )}
    </>
  )}
</div>
  );
}
