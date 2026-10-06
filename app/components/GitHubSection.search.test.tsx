// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { GithubIssue, GithubIssueSummary } from "../../shared/types";

const h = vi.hoisted(() => ({
  link: vi.fn().mockResolvedValue(undefined),
  repos: [] as Array<{ repo: string; sourceRole: boolean; workspaceRole: boolean }>,
  issues: [
    { number: 1, title: "First", state: "open" },
    { number: 2, title: "Second", state: "open" },
    { number: 3, title: "Third", state: "open" },
  ] as GithubIssueSummary[],
}));

vi.mock("../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/queries")>();
  return {
    ...actual,
    useProjectRepos: () => ({ data: h.repos }),
    useGithubIssueSearch: () => ({ data: h.issues }),
    useLinkExistingIssue: () => ({ mutateAsync: h.link }),
  };
});

vi.mock("../lib/useDebouncedValue", () => ({
  useDebouncedValue: <T,>(value: T): T => value,
}));

import { GitHubSection } from "./GitHubSection";

const LINKED: GithubIssue[] = [
  { issueId: "ghi1", issueNumber: 1, repo: "acme/web", title: "First", syncedState: "open", url: "u1", outOfSync: false, pushFailed: false },
  { issueId: "ghi2", issueNumber: 2, repo: "acme/web", title: "Second", syncedState: "open", url: "u2", outOfSync: false, pushFailed: false },
];

function renderSection(githubs: GithubIssue[]) {
  return render(
    <GitHubSection
      taskId="t1"
      slug="demo"
      githubs={githubs}
      columnGithubState="open"
      onLink={async () => null}
      onUnlink={async () => {}}
    />
  );
}

describe("GitHubSection issue-search autocomplete", () => {
  it("falls back to the first result when the list shrinks below activeIndex", () => {
    const { rerender } = renderSection([]);

    // Workspace repos arrive after mount (real query is async) so the flow's
    // selected repo settles before the search runs.
    h.repos = [{ repo: "acme/web", sourceRole: false, workspaceRole: true }];
    rerender(
      <GitHubSection
        taskId="t1"
        slug="demo"
        githubs={[]}
        columnGithubState="open"
        onLink={async () => null}
        onUnlink={async () => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Link issue" }));
    const input = screen.getByLabelText("Search issue number or title");
    fireEvent.change(input, { target: { value: "third" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // A background link update filters the list down to one row without
    // resetting activeIndex — Enter must not dereference results[2].
    rerender(
      <GitHubSection
        taskId="t1"
        slug="demo"
        githubs={LINKED}
        columnGithubState="open"
        onLink={async () => null}
        onUnlink={async () => {}}
      />
    );

    expect(() => fireEvent.keyDown(input, { key: "Enter" })).not.toThrow();
    expect(h.link).toHaveBeenCalledTimes(1);
    expect(h.link).toHaveBeenCalledWith({ taskId: "t1", repo: "acme/web", issueNumber: 3 });
  });
});
