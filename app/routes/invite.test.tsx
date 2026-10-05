// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";

type PeekData =
  | { valid: true; email: string }
  | { valid: false; reason: "used" | "expired" | "unknown" }
  | undefined;

const h = vi.hoisted(() => ({
  session: { value: null as { user: { id: string } } | null },
  token: { value: "tok" as string | undefined },
  peek: {
    value: {
      data: undefined as PeekData,
      isLoading: false,
      isError: false,
      refetch: (() => undefined) as () => void,
    },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => ({ token: h.token.value }),
  }),
  Navigate: ({ to }: { to: string }) => <div data-testid="home-redirect">{to}</div>,
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/queries", () => ({
  useSession: () => ({ data: h.session.value, isLoading: false }),
  useInvitePeek: () => h.peek.value,
  useAcceptInvite: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useSignIn: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Route } from "./invite";

const InvitePage = (Route as unknown as { component: ComponentType }).component;

function setPeek(state: { data: PeekData; isLoading?: boolean; isError?: boolean }) {
  h.peek.value = {
    data: state.data,
    isLoading: state.isLoading ?? false,
    isError: state.isError ?? false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  h.session.value = null;
  h.token.value = "tok";
  setPeek({ data: undefined });
});

const createButton = () => screen.queryByRole("button", { name: "Create account" });

describe("InvitePage gating", () => {
  it("renders the create-account form when the peek is valid", () => {
    setPeek({ data: { valid: true, email: "invitee@lexa.dev" } });
    render(<InvitePage />);
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(createButton()).toBeInTheDocument();
  });

  it("renders the already-used state with no form for reason used", () => {
    setPeek({ data: { valid: false, reason: "used" } });
    render(<InvitePage />);
    expect(screen.getByText(/already been used/i)).toBeInTheDocument();
    expect(createButton()).toBeNull();
  });

  it("renders the invalid-or-expired state with no form for reason expired", () => {
    setPeek({ data: { valid: false, reason: "expired" } });
    render(<InvitePage />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(createButton()).toBeNull();
  });

  it("renders the invalid-or-expired state with no form for reason unknown", () => {
    setPeek({ data: { valid: false, reason: "unknown" } });
    render(<InvitePage />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(createButton()).toBeNull();
  });

  it("renders the invalid state with a Retry and no form when the peek fails", () => {
    setPeek({ data: undefined, isError: true });
    render(<InvitePage />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(createButton()).toBeNull();
  });

  it("never renders the form while the peek is loading", () => {
    setPeek({ data: undefined, isLoading: true });
    render(<InvitePage />);
    expect(createButton()).toBeNull();
  });

  it("renders the invalid state with no form when the token is missing", () => {
    h.token.value = undefined;
    render(<InvitePage />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(createButton()).toBeNull();
  });
});
