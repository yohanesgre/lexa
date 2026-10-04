// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => opts,
  Navigate: () => null,
  Outlet: () => null,
  useRouterState: () => "/settings",
}));

vi.mock("../lib/queries", () => ({
  useSession: () => ({ data: null, isLoading: false }),
  useTeams: () => ({ data: [] }),
}));

import { settingsLandingPath } from "./settings";

describe("settingsLandingPath", () => {
  it("sends a superadmin to workspace settings", () => {
    expect(settingsLandingPath({ role: "superadmin" }, [])).toBe("/settings/workspace");
  });

  it("sends a team admin (administered teams present) to team settings", () => {
    expect(settingsLandingPath({ role: "member" }, [{ id: "t1" }])).toBe("/settings/team");
  });

  it("sends a plain member (no administered teams) to user settings", () => {
    expect(settingsLandingPath({ role: "member" }, [])).toBe("/settings/me");
    expect(settingsLandingPath({ role: "member" }, undefined)).toBe("/settings/me");
  });
});
