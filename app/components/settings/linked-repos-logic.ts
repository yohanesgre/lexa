// Pure state machine for the Linked Repos type-ahead
// (wireframes/src/settings-project-herald.html:57-185). Exactly one state
// renders live; "no installation" outranks an upstream error because a
// connected-but-not-installed App returns 403 to the admin-gated search.

export type RepoSearchState = "idle" | "searching" | "no-installation" | "error" | "no-matches" | "results";

export function repoSearchState(args: {
  query: string;
  debouncedQuery: string;
  searchStatus: "pending" | "error" | "success";
  resultCount: number;
  installStatus: "installed" | "not_installed" | "unknown" | undefined;
}): RepoSearchState {
  if (args.query.trim().length < 2) return "idle";
  if (args.debouncedQuery !== args.query.trim() || args.searchStatus === "pending") return "searching";
  if (args.installStatus === "not_installed") return "no-installation";
  if (args.searchStatus === "error") return "error";
  return args.resultCount > 0 ? "results" : "no-matches";
}
