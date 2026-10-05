// @vitest-environment jsdom
// Workspace → GitHub Sync manual-credentials card (card-level disclosure body).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GithubSettings } from "../../lib/api";

const h = vi.hoisted(() => ({
  settings: { value: undefined as GithubSettings | undefined },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useGithubSettings: () => ({ data: h.settings.value, isLoading: false, isError: false }),
    useUpdateGithubSettings: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { GithubSyncCredentialsCard } from "./GithubSyncCredentialsCard";

const NONE: GithubSettings = { appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" };

describe("GithubSyncCredentialsCard", () => {
  it("heads the manual fallback 'Manual credentials'", () => {
    h.settings.value = NONE;
    render(<GithubSyncCredentialsCard onRemove={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Manual credentials" })).toBeInTheDocument();
  });
});
