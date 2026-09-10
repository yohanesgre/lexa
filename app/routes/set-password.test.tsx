// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  session: { value: null as { user: { id: string } } | null },
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => ({ token: "tok" }),
  }),
  Navigate: ({ to }: { to: string }) => <div data-testid="home-redirect">{to}</div>,
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/queries", () => ({
  useSession: () => ({ data: h.session.value, isLoading: false }),
  useSetPassword: () => ({ mutate: h.mutate, isPending: false }),
}));

import { SetPasswordForm } from "../components/auth/SetPasswordForm";
import { SetPasswordPage } from "./set-password";

beforeEach(() => {
  h.session.value = null;
  h.mutate.mockReset();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Password"), "supersecret");
  await user.type(screen.getByLabelText("Confirm password"), "supersecret");
  await user.click(screen.getByRole("button", { name: "Set password" }));
}

describe("SetPasswordForm", () => {
  it("shows the success card and fires onDone after a successful submit", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    h.mutate.mockImplementation((_vars, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });

    render(<SetPasswordForm token="tok" onDone={onDone} />);
    await fillAndSubmit(user);

    expect(await screen.findByText(/you're signed in/i)).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("SetPasswordPage", () => {
  it("redirects home when a session already exists", () => {
    h.session.value = { user: { id: "u1" } };
    render(<SetPasswordPage />);
    expect(screen.getByTestId("home-redirect")).toBeInTheDocument();
  });

  it("keeps the success card after completion even once a session appears", async () => {
    const user = userEvent.setup();
    h.mutate.mockImplementation((_vars, options?: { onSuccess?: () => void }) => {
      h.session.value = { user: { id: "u1" } };
      options?.onSuccess?.();
    });

    render(<SetPasswordPage />);
    expect(screen.queryByTestId("home-redirect")).toBeNull();

    await fillAndSubmit(user);

    expect(await screen.findByText(/you're signed in/i)).toBeInTheDocument();
    expect(screen.queryByTestId("home-redirect")).toBeNull();
  });
});
