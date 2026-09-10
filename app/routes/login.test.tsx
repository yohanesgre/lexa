// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => opts,
  Navigate: () => null,
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/queries", () => ({
  useSession: () => ({ data: null, isLoading: false }),
  useSignIn: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../lib/api", () => ({
  getSetupStatus: () => Promise.resolve({ configured: true }),
}));

import { safeRedirect } from "./login";

describe("safeRedirect", () => {
  it("returns an internal path unchanged", () => {
    expect(safeRedirect("/foo/bar")).toBe("/foo/bar");
  });

  it("rejects protocol-relative targets", () => {
    expect(safeRedirect("//evil.com")).toBe("/");
  });

  it("rejects backslash targets", () => {
    expect(safeRedirect("/\\evil")).toBe("/");
  });

  it("rejects absolute external URLs", () => {
    expect(safeRedirect("https://evil.com")).toBe("/");
  });

  it("falls back to home when undefined", () => {
    expect(safeRedirect(undefined)).toBe("/");
  });

  it("rejects tab/newline whitespace tricks via URL normalization", () => {
    expect(safeRedirect("/\t/evil.com")).toBe("/");
    expect(safeRedirect("/\n/evil.com")).toBe("/");
  });

  it("rejects literal backslash tricks", () => {
    expect(safeRedirect("/\\evil.com")).toBe("/");
  });

  it("keeps encoded slashes on the same origin", () => {
    expect(safeRedirect("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
  });

  it("rejects external URLs with paths", () => {
    expect(safeRedirect("https://evil.com/x")).toBe("/");
  });

  it("round-trips path, query and hash", () => {
    expect(safeRedirect("/foo?x=1#h")).toBe("/foo?x=1#h");
  });
});
