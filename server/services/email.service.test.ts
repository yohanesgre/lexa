import { describe, it, expect } from "vitest";
import type { SendEmail } from "@cloudflare/workers-types";
import type { RuntimeEnv } from "../env";
import { invitationTemplate, passwordLinkTemplate, passwordResetTemplate, sendEmail } from "./email.service";

const template = invitationTemplate({
  to: "invitee@example.test",
  origin: "https://lexa.example.test",
  link: "https://lexa.example.test/invite?token=test",
  expiresAt: "2026-11-04T12:00:00.000Z",
});

function envWith(send: SendEmail["send"]): RuntimeEnv {
  return {
    LXK_ENV: "production",
    LXK_PUBLIC_URL: "https://lexa.example.test",
    LXK_EMAIL_FROM: "noreply@example.test",
    EMAIL: { send } as unknown as SendEmail, // test double for the native binding
  };
}

describe("native email outcome classification", () => {
  it("accepts with messageId, fails only known rejections, and keeps unrecognized transport errors unknown", async () => {
    const accepted = await sendEmail(envWith(async () => ({ messageId: "msg_1" })), template);
    expect(accepted).toEqual({ status: "accepted", messageId: "msg_1" });

    const rejected = Object.assign(new Error("provider rejected"), { code: "E_VALIDATION_ERROR" });
    expect(await sendEmail(envWith(async () => Promise.reject(rejected)), template)).toEqual({ status: "failed" });

    const internal = Object.assign(new Error("internal"), { code: "E_INTERNAL_SERVER_ERROR" });
    expect(await sendEmail(envWith(async () => Promise.reject(internal)), template)).toEqual({ status: "unknown" });

    const unrecognized = new Error("network");
    expect(await sendEmail(envWith(async () => Promise.reject(unrecognized)), template)).toEqual({ status: "unknown" });
  });
});

describe("email templates", () => {
  const expiresAt = "2026-11-04T12:00:00.000Z";
  const link = "https://lexa.example.test/invite?token=abc&next=%2Fboard";
  const input = { to: "invitee@example.test", origin: "https://lexa.example.test", link, expiresAt };

  it("renders the action link, a readable UTC expiry and a plain-text alternative for every template", () => {
    for (const render of [invitationTemplate, passwordResetTemplate, passwordLinkTemplate]) {
      const mail = render(input);
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.text).toContain(link);
      expect(mail.text).toContain("UTC");
      expect(mail.text).not.toContain(expiresAt);
      expect(mail.html).toContain("https://lexa.example.test/invite?token=abc&amp;next=%2Fboard");
      expect(mail.html).toContain('role="presentation"');
      expect(mail.html).toContain("<h1");
    }
  });

  it("escapes link text and attributes", () => {
    const mail = invitationTemplate({ ...input, link: 'https://lexa.example.test/invite?x=<script>&y="1"' });
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("&quot;1&quot;");
    expect(mail.html).toContain("&amp;");
    expect(mail.html).not.toContain("<script>");
  });
});
