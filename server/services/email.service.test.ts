import { describe, it, expect } from "vitest";
import type { SendEmail } from "@cloudflare/workers-types";
import type { RuntimeEnv } from "../env";
import { invitationTemplate, sendEmail } from "./email.service";

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
