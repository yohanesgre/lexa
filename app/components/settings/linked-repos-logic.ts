// Pure state machine for the Linked Repos type-ahead
// (wireframes/src/settings-project-herald.html:57-185). Exactly one state
// renders live; "no installation" outranks a listing error so a
// connected-but-not-installed App reads as a setup step, not a failure.
// The real case this precedence protects: an installation probe that reports
// "not_installed" together with a 502 from the repo-listing endpoint (the
// merged server returns 200 [] for zero installations — that is a match, not
// an error). A member's 403 is unrelated: it is requireAdmin, and a member
// never reaches "no-installation" because their settings/install probes are
// disabled.

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
