// Native Cloudflare Email Sending only: one binding, one sender, three fixed
// templates. No provider registry, SMTP, transport retries, queue, outbox, or
// delivery history — Cloudflare owns mail-server attempts after acceptance.
// Every send returns an outcome object instead of failing the caller, because
// link issuance/persistence is the authoritative result even when mail is not.

import { Effect } from "effect";
import { resolvePublicUrl, type RuntimeEnv } from "../env";
import { currentEnv } from "../runtime-env";

export type EmailDeliveryStatus = "accepted" | "failed" | "unknown" | "not_configured";

export interface EmailDelivery {
  status: EmailDeliveryStatus;
  messageId?: string;
}

interface OutboundTemplate {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Provider submission must be bounded: the whole job runs inside a Worker
// request lifetime (`ctx.waitUntil`), and a hung send would otherwise consume
// the request's remaining budget without ever resolving.
export const EMAIL_SEND_TIMEOUT_MS = 10_000;

const SENDER_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// Only these known provider rejection categories prove the message was NOT
// accepted. Any other `E_*` (e.g. an internal server error) is an unrecognized
// transport outcome and stays `unknown` — never retried, never called failed.
const DEFINITE_PROVIDER_CODES: Record<string, true> = {
  E_VALIDATION_ERROR: true,
  E_FIELD_MISSING: true,
  E_TOO_MANY_RECIPIENTS: true,
  E_INVALID_EMAIL: true,
  E_INVALID_FROM: true,
  E_INVALID_RECIPIENT: true,
  E_SENDER_NOT_VERIFIED: true,
  E_RECIPIENT_NOT_ALLOWED: true,
  E_SUPPRESSED: true,
  E_SUPPRESSION: true,
  E_RATE_LIMIT_EXCEEDED: true,
  E_DAILY_LIMIT_EXCEEDED: true,
  E_QUOTA_EXCEEDED: true,
  E_ACCOUNT_SUSPENDED: true,
  E_SUSPENDED: true,
};

// Safe log token only (never a raw payload/message).
const PROVIDER_LOG_CODE_RE = /^E_[A-Z0-9_]+$/;

class EmailSendTimeout extends Error {
  constructor() {
    super("email send timed out");
    this.name = "EmailSendTimeout";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Bare verified-domain sender address, or null when absent/malformed. */
export function resolveEmailSender(env: RuntimeEnv): string | null {
  const raw = env.LXK_EMAIL_FROM?.trim() ?? "";
  return raw.length > 0 && SENDER_ADDRESS_RE.test(raw) ? raw : null;
}

// Recovery/invite links must never travel over plain HTTP outside local dev.
function safeLinkOrigin(env: RuntimeEnv): string | null {
  const origin = resolvePublicUrl(env).replace(/\/+$/, "");
  if (origin.startsWith("https://")) return origin;
  if (env.LXK_ENV === "dev" && origin.startsWith("http://")) return origin;
  return null;
}

/**
 * Effective delivery availability: native binding + valid sender + a usable
 * (HTTPS or dev-http) canonical origin. Public discovery uses this exact
 * predicate so a form is never advertised while sends are impossible.
 */
export function emailDeliveryConfigured(env: RuntimeEnv): boolean {
  return env.EMAIL !== undefined && resolveEmailSender(env) !== null && safeLinkOrigin(env) !== null;
}

// The issued row's own expiry, rendered with an explicit UTC timezone. Never
// recomputed from a lifetime constant.
function renderExpiry(expiresAt: string): string {
  const parsed = new Date(expiresAt);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : expiresAt;
}

function htmlDocument(paragraphs: string[], actionLabel: string, link: string): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  return [
    "<!doctype html>",
    "<html><body>",
    body,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(actionLabel)}</a></p>`,
    "</body></html>",
  ].join("\n");
}

export function passwordResetTemplate(input: { to: string; origin: string; link: string; expiresAt: string }): OutboundTemplate {
  const expires = renderExpiry(input.expiresAt);
  const intro = `A password reset was requested for your Lexa account at ${input.origin}. Use the link below to choose a new password.`;
  const expiry = `This link expires in 30 minutes, at ${expires}, and can be used once.`;
  const footer = "If you did not request this, ignore this email; your password has not changed.";
  return {
    to: input.to,
    subject: "Reset your Lexa password",
    text: `${intro} ${expiry} ${footer}\n\nReset password: ${input.link}\n`,
    html: htmlDocument([intro, expiry, footer], "Reset password", input.link),
  };
}

export function invitationTemplate(input: { to: string; origin: string; link: string; expiresAt: string }): OutboundTemplate {
  const expires = renderExpiry(input.expiresAt);
  const intro = `An administrator invited you to Lexa at ${input.origin}. Use the link below to create your account and choose a password.`;
  const expiry = `This invitation expires at ${expires}, seven days after it was created.`;
  const footer = "If you were not expecting this invitation, you can ignore it.";
  return {
    to: input.to,
    subject: "You’re invited to Lexa",
    text: `${intro} ${expiry} ${footer}\n\nAccept invitation: ${input.link}\n`,
    html: htmlDocument([intro, expiry, footer], "Accept invitation", input.link),
  };
}

export function passwordLinkTemplate(input: { to: string; origin: string; link: string; expiresAt: string }): OutboundTemplate {
  const expires = renderExpiry(input.expiresAt);
  const intro = `An administrator requested a password setup link for your Lexa account at ${input.origin}. Use the link below to choose a password.`;
  const expiry = `This link expires at ${expires}, seven days after it was created, and can be used once.`;
  const footer = "Your password does not change until you submit a new one.";
  return {
    to: input.to,
    subject: "Set your Lexa password",
    text: `${intro} ${expiry} ${footer}\n\nSet password: ${input.link}\n`,
    html: htmlDocument([intro, expiry, footer], "Set password", input.link),
  };
}

function providerCode(error: Error): string | number | undefined {
  if (!("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

// Only a provider error carrying a recognized rejection code proves the
// message was NOT accepted. Anything else (deadline, network, unknown throw)
// stays `unknown` — never a manufactured failure and never a retry trigger.
function definiteRejection(error: Error): boolean {
  const code = providerCode(error);
  if (typeof code === "string" && Object.hasOwn(DEFINITE_PROVIDER_CODES, code)) return true;
  return typeof code === "number" && code >= 400 && code < 500;
}

function safeErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = providerCode(error);
  if (typeof code === "string" && PROVIDER_LOG_CODE_RE.test(code)) return code;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "unknown";
}

/** One bounded submission through the native binding; never throws. */
export async function sendEmail(env: RuntimeEnv, template: OutboundTemplate): Promise<EmailDelivery> {
  const sender = resolveEmailSender(env);
  if (!env.EMAIL || !sender) return { status: "not_configured" };

  const { promise: timedOut, reject: rejectTimeout } = Promise.withResolvers<never>();
  const timer = setTimeout(() => rejectTimeout(new EmailSendTimeout()), EMAIL_SEND_TIMEOUT_MS);
  try {
    const sending = env.EMAIL.send({
      from: { name: "Lexa", email: sender },
      to: template.to,
      subject: template.subject,
      text: template.text,
      html: template.html,
    });
    // A timed-out race must not surface as an unhandled rejection later.
    sending.catch(() => {});
    const result = await Promise.race([sending, timedOut]);
    return result.messageId ? { status: "accepted", messageId: result.messageId } : { status: "accepted" };
  } catch (error) {
    const status: EmailDeliveryStatus = error instanceof EmailSendTimeout || !(error instanceof Error) || !definiteRejection(error) ? "unknown" : "failed";
    // Sanitized: outcome + provider category only — no recipient, subject,
    // body, token-bearing URL, or raw provider payload.
    console.warn(`[Email] delivery ${status} category=${safeErrorCategory(error)}`);
    return { status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Effect service used by the workspace route layer and the recovery job. It
 * reads the per-request RuntimeEnv, so links use the canonical public origin
 * and the sender is never exposed to callers.
 */
export class EmailService extends Effect.Service<EmailService>()("Lexa/EmailService", {
  effect: Effect.gen(function* () {
    const send = (build: (origin: string) => OutboundTemplate) =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        const origin = safeLinkOrigin(env);
        if (!env.EMAIL || origin === null) return { status: "not_configured" } as EmailDelivery;
        return yield* Effect.promise(() => sendEmail(env, build(origin)));
      });

    const sendInvitation = (input: { to: string; link: string; expiresAt: string }) =>
      send((origin) => invitationTemplate({ ...input, origin }));

    const sendPasswordLink = (input: { to: string; link: string; expiresAt: string }) =>
      send((origin) => passwordLinkTemplate({ ...input, origin }));

    const sendPasswordReset = (input: { to: string; link: string; expiresAt: string }) =>
      send((origin) => passwordResetTemplate({ ...input, origin }));

    return { sendInvitation, sendPasswordLink, sendPasswordReset };
  }),
}) {}
