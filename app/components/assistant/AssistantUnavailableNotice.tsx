import type { ReactNode } from "react";

// Capability-disabled notice (ADR-0003 §F.3). Transcribed verbatim from the
// wireframes: herald-chat.html "Assistant unavailable on this deployment" (the
// chat route + admin panels) and settings-project-herald.html "Capability-false
// variant (Bun flavor)" (the project settings page). No provider controls render
// on either; the notice replaces the whole surface.

const SPARKLE_PATH =
  "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z";

function NoticeIcon() {
  return (
    <div className="empty-state-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d={SPARKLE_PATH} />
      </svg>
    </div>
  );
}

export interface AssistantUnavailableNoticeProps {
  // "page" = the chat route / admin panels (herald-chat.html markup);
  // "settings" = the project settings capability-false variant.
  variant?: "page" | "settings" | undefined;
  // Optional heading/body overrides used by the admin panels, which render the
  // same notice shell with their own surface name.
  title?: string | undefined;
  body?: ReactNode | undefined;
}

export function AssistantUnavailableNotice({ variant = "page", title, body }: AssistantUnavailableNoticeProps) {
  const isSettings = variant === "settings";
  const heading = title ?? (isSettings ? "Assistant settings unavailable" : "The Assistant runs on the Cloudflare Workers deployment");
  const copy =
    body ??
    (isSettings
      ? "The Assistant runs on the Cloudflare Workers deployment. This deployment does not include it, so there are no provider settings to configure here. Your project data is unaffected."
      : "This deployment does not include the Assistant. Your projects are unaffected. Assistant chat history is not available on this deployment and is not carried over to the Workers flavor.");

  return (
    <div
      className="empty-state"
      style={
        isSettings
          ? { padding: "32px 24px", border: "1px solid var(--lx-border-default)", borderRadius: 12 }
          : { padding: "40px 24px" }
      }
    >
      <NoticeIcon />
      <div className="text-base weight-500 color-primary">{heading}</div>
      <p className="text-sm color-secondary mt-2" style={{ maxWidth: isSettings ? 440 : 420, lineHeight: "20px" }}>
        {copy}
      </p>
    </div>
  );
}
