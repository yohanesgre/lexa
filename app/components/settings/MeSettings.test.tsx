// @vitest-environment jsdom
// Wireframe settings-me.html: change-password revokes ALL OTHER sessions
// (changePassword({ revokeOtherSessions: true })) and the success copy says so.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/Toast";
import * as auth from "../../lib/auth";
import { PasswordSection } from "./MeSettings";

vi.mock("../../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/auth")>();
  return { ...actual, changePassword: vi.fn() };
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}><ToastProvider>{children}</ToastProvider></QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(auth.changePassword).mockReset().mockResolvedValue(undefined);
});

describe("PasswordSection", () => {
  it("sends revokeOtherSessions: true and reports revoked sessions on success", async () => {
    const user = userEvent.setup();
    render(<PasswordSection />, { wrapper: wrapper() });

    await user.type(screen.getByLabelText("Current password"), "oldpass1");
    await user.type(screen.getByLabelText("New password"), "newpass12");
    await user.type(screen.getByLabelText("Confirm new password"), "newpass12");
    await user.click(screen.getByRole("button", { name: "Update password" }));

    expect(auth.changePassword).toHaveBeenCalledWith({
      currentPassword: "oldpass1",
      newPassword: "newpass12",
      revokeOtherSessions: true,
    });
    expect(await screen.findByText("Password updated. All other sessions were signed out.")).toBeTruthy();
  });
});
