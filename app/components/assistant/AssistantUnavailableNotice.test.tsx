// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssistantUnavailableNotice } from "./AssistantUnavailableNotice";

// ADR-0003 §F.3 — the capability-disabled notice. Copy transcribed from
// herald-chat.html ("Assistant unavailable on this deployment") and
// settings-project-herald.html (capability-false variant).

describe("AssistantUnavailableNotice", () => {
  it("renders the page variant copy (chat route + admin panels)", () => {
    render(<AssistantUnavailableNotice />);
    expect(screen.getByText("The Assistant runs on the Cloudflare Workers deployment")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This deployment does not include the Assistant. Your projects are unaffected. Assistant chat history is not available on this deployment and is not carried over to the Workers flavor."
      )
    ).toBeInTheDocument();
  });

  it("renders the settings variant copy", () => {
    render(<AssistantUnavailableNotice variant="settings" />);
    expect(screen.getByText("Assistant settings unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The Assistant runs on the Cloudflare Workers deployment. This deployment does not include it, so there are no provider settings to configure here. Your project data is unaffected."
      )
    ).toBeInTheDocument();
  });

  it("honours heading/body overrides for the admin panels", () => {
    render(<AssistantUnavailableNotice title="Assistant Providers unavailable" body="Workers only." />);
    expect(screen.getByText("Assistant Providers unavailable")).toBeInTheDocument();
    expect(screen.getByText("Workers only.")).toBeInTheDocument();
  });
});
