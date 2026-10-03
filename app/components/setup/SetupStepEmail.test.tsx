// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ setSetupAdmin: vi.fn() }));

vi.mock("../../lib/api", () => ({ setSetupAdmin: h.setSetupAdmin }));

import { SetupStepEmail } from "./SetupStepEmail";

beforeEach(() => {
  h.setSetupAdmin.mockReset();
  h.setSetupAdmin.mockResolvedValue({ ok: true });
});

function renderStep(onDone = vi.fn()) {
  render(<SetupStepEmail email="admin@example.com" onEmailChange={() => {}} isRemote={false} onDone={onDone} />);
  return onDone;
}

describe("SetupStepEmail", () => {
  it("shows the mismatch hint and blocks submit when passwords differ", async () => {
    const user = userEvent.setup();
    const onDone = renderStep();

    await user.type(screen.getByLabelText("Password"), "supersecret");
    await user.type(screen.getByLabelText("Confirm password"), "differentpass{Enter}");

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    expect(h.setSetupAdmin).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("clears the hint and submits with the email and password when they match", async () => {
    const user = userEvent.setup();
    const onDone = renderStep();

    await user.type(screen.getByLabelText("Password"), "supersecret");
    await user.type(screen.getByLabelText("Confirm password"), "differentpass{Enter}");
    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();

    const confirmInput = screen.getByLabelText("Confirm password");
    await user.clear(confirmInput);
    await user.type(confirmInput, "supersecret");
    expect(screen.queryByText("Passwords do not match")).toBeNull();

    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(h.setSetupAdmin).toHaveBeenCalledWith("admin@example.com", "supersecret"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("still reports a too-short password", async () => {
    const user = userEvent.setup();
    const onDone = renderStep();

    await user.type(screen.getByLabelText("Password"), "short{Enter}");

    expect(await screen.findByText("Password must be at least 8 characters.")).toBeInTheDocument();
    expect(h.setSetupAdmin).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
