// Pure state precedence for the Linked Repos type-ahead
// (wireframes/src/settings-project-herald.html:57-185).
import { describe, expect, it } from "vitest";
import { repoSearchState, type RepoSearchState } from "./linked-repos-logic";

function state(over: Partial<Parameters<typeof repoSearchState>[0]> = {}): RepoSearchState {
  return repoSearchState({
    query: "web",
    debouncedQuery: "web",
    searchStatus: "success",
    resultCount: 0,
    installStatus: "installed",
    ...over,
  });
}

describe("repoSearchState", () => {
  it("idle until the query reaches two characters (no dropdown, no request)", () => {
    expect(state({ query: "" })).toBe("idle");
    expect(state({ query: " w " })).toBe("idle");
    expect(state({ query: "w" })).toBe("idle");
  });

  it("searching while the debounce is pending or the request is in flight", () => {
    expect(state({ query: "web", debouncedQuery: "" })).toBe("searching");
    expect(state({ query: "web", debouncedQuery: "web", searchStatus: "pending" })).toBe("searching");
  });

  it("no-installation when the probe reports a connected-but-not-installed App", () => {
    expect(state({ installStatus: "not_installed" })).toBe("no-installation");
  });

  it("not_installed wins over a search 403 (the admin-gated search errors with no installation)", () => {
    expect(state({ searchStatus: "error", installStatus: "not_installed" })).toBe("no-installation");
  });

  it("error on an upstream failure with an installation present", () => {
    expect(state({ searchStatus: "error", resultCount: 0 })).toBe("error");
  });

  it("no-matches on a settled 200 with an empty result set", () => {
    expect(state({ resultCount: 0 })).toBe("no-matches");
    expect(state({ resultCount: 0, installStatus: undefined })).toBe("no-matches");
    expect(state({ resultCount: 0, installStatus: "unknown" })).toBe("no-matches");
  });

  it("results once the settled search returns matches", () => {
    expect(state({ resultCount: 3 })).toBe("results");
  });
});
