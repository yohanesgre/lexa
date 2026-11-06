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

// The issued row's own expiry, rendered in UTC. Never recomputed from a
// lifetime constant; an unparseable value is shown verbatim.
function renderExpiry(expiresAt: string): string {
  const parsed = new Date(expiresAt);
  if (!Number.isFinite(parsed.getTime())) return expiresAt;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed) + " UTC";
}

// Email clients cannot load the app's webfonts; the named families are used
// where installed and fall back to the system stacks. Layout is table-based
// with inline styles only, and the palette is the day map: warm paper, ink,
// one lit amber action plate.
const EMAIL_SIGNAGE = "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const EMAIL_GUIDE = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const EMAIL_MONO = "'JetBrains Mono', 'SF Mono', 'Fira Code', ui-monospace, Menlo, Consolas, monospace";

interface EmailLayoutInput {
  preheader: string;
  eyebrow: string;
  heading: string;
  body: string[];
  actionLabel: string;
  link: string;
  expiry: string;
  expiryNote: string;
  footer: string;
  origin: string;
}

function textDocument(input: EmailLayoutInput): string {
  return [
    "LEXA — SELF-HOSTED PROJECT TRACKER",
    "",
    input.eyebrow.toUpperCase(),
    "",
    input.heading,
    "",
    ...input.body.flatMap((paragraph) => [paragraph, ""]),
    `${input.actionLabel}:`,
    input.link,
    "",
    `Expires ${input.expiry}`,
    input.expiryNote,
    "",
    input.footer,
    "",
    input.origin,
    "",
  ].join("\n");
}

function htmlDocument(input: EmailLayoutInput): string {
  const paragraphs = input.body
    .map(
      (paragraph) =>
        `<p style="margin:0 0 14px 0;font-family:${EMAIL_GUIDE};font-size:15px;line-height:1.65;color:#544B3C;">${escapeHtml(paragraph)}</p>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.heading)}</title>
<style>
  @media (max-width: 600px) {
    .lx-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .lx-heading { font-size: 23px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#F7F3EA;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#F7F3EA;">${escapeHtml(input.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F3EA;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FFFDF9;border:1px solid #C2B79E;border-radius:10px;">
          <tr>
            <td class="lx-pad" style="padding:26px 32px 0 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="36" height="36" align="center" valign="middle" style="width:36px;height:36px;background-color:#D4A017;border-radius:8px;font-family:${EMAIL_SIGNAGE};font-size:13px;font-weight:700;line-height:36px;color:#0C0B09;letter-spacing:0.02em;">LX</td>
                  <td style="padding-left:12px;font-family:${EMAIL_SIGNAGE};font-size:15px;font-weight:700;line-height:1.2;letter-spacing:0.16em;color:#2A241B;">LEXA</td>
                </tr>
              </table>
              <div style="padding-top:8px;font-family:${EMAIL_MONO};font-size:9px;line-height:1.4;letter-spacing:0.12em;text-transform:uppercase;color:#544B3C;">Self-hosted project tracker</div>
            </td>
          </tr>
          <tr>
            <td class="lx-pad" style="padding:22px 32px 0 32px;">
              <div style="height:1px;background-color:#CFC4AC;line-height:1px;font-size:0;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td class="lx-pad" style="padding:24px 32px 0 32px;">
              <div style="font-family:${EMAIL_MONO};font-size:10px;font-weight:700;line-height:1.2;letter-spacing:0.14em;text-transform:uppercase;color:#7E5C00;padding-bottom:10px;">${escapeHtml(input.eyebrow)}</div>
              <h1 class="lx-heading" style="margin:0 0 14px 0;font-family:${EMAIL_SIGNAGE};font-size:26px;font-weight:700;line-height:1.2;letter-spacing:-0.01em;color:#2A241B;">${escapeHtml(input.heading)}</h1>
              ${paragraphs}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;background-color:#F9F6EF;border:1px solid #CFC4AC;border-radius:6px;">
                <tr>
                  <td style="padding:12px 14px;">
                    <div style="font-family:${EMAIL_MONO};font-size:9px;font-weight:700;line-height:1.2;letter-spacing:0.14em;text-transform:uppercase;color:#544B3C;">Expires</div>
                    <div style="padding-top:3px;font-family:${EMAIL_MONO};font-size:13px;line-height:1.5;color:#2A241B;">${escapeHtml(input.expiry)}</div>
                    <div style="padding-top:6px;font-family:${EMAIL_GUIDE};font-size:12px;line-height:1.55;color:#544B3C;">${escapeHtml(input.expiryNote)}</div>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0 0;">
                <tr>
                  <td align="center" bgcolor="#8A5A0A" style="border-radius:6px;mso-padding-alt:13px 22px;">
                    <a href="${escapeHtml(input.link)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 22px;font-family:${EMAIL_SIGNAGE};font-size:14px;font-weight:700;line-height:1;color:#FFF9EC;text-decoration:none;border-radius:6px;">${escapeHtml(input.actionLabel)}</a>
                  </td>
                </tr>
              </table>
              <div style="padding-top:24px;font-family:${EMAIL_MONO};font-size:9px;font-weight:700;line-height:1.4;letter-spacing:0.14em;text-transform:uppercase;color:#544B3C;">Or open this link</div>
              <div style="padding-top:5px;font-family:${EMAIL_MONO};font-size:12px;line-height:1.6;color:#7E5C00;word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(input.link)}</div>
            </td>
          </tr>
          <tr>
            <td class="lx-pad" style="padding:24px 32px 26px 32px;">
              <div style="height:1px;background-color:#CFC4AC;line-height:1px;font-size:0;">&nbsp;</div>
              <div style="padding-top:18px;font-family:${EMAIL_GUIDE};font-size:12px;line-height:1.6;color:#544B3C;">${escapeHtml(input.footer)}</div>
              <div style="padding-top:6px;font-family:${EMAIL_MONO};font-size:11px;line-height:1.6;color:#7E5C00;">${escapeHtml(input.origin)}</div>
            </td>
          </tr>
        </table>
        <div style="padding-top:16px;font-family:${EMAIL_MONO};font-size:9px;line-height:1.5;letter-spacing:0.12em;text-transform:uppercase;color:#544B3C;">Transactional message</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderTemplate(
  input: EmailLayoutInput & { to: string; subject: string }
): OutboundTemplate {
  return {
    to: input.to,
    subject: input.subject,
    text: textDocument(input),
    html: htmlDocument(input),
  };
}

export function passwordResetTemplate(input: { to: string; origin: string; link: string; expiresAt: string }): OutboundTemplate {
  const expiry = renderExpiry(input.expiresAt);
  return renderTemplate({
    to: input.to,
    subject: "Reset your Lexa password",
    preheader: "Choose a new password for your Lexa account.",
    eyebrow: "Password reset",
    heading: "Reset your password",
    body: [
      `A password reset was requested for your Lexa account at ${input.origin}.`,
      "Choose a new password with the button below.",
    ],
    actionLabel: "Choose a new password",
    link: input.link,
    expiry,
    expiryNote: "This link expires in 30 minutes and can be used once.",
    footer: "If you didn't request this, ignore this email — your password hasn't changed.",
    origin: input.origin,
  });
}

export function invitationTemplate(input: { to: string; origin: string; link: string; expiresAt: string }): OutboundTemplate {
  const expiry = renderExpiry(input.expiresAt);
  return renderTemplate({
    to: input.to,
    subject: "You’re invited to Lexa",
    preheader: "An administrator invited you to Lexa.",
    eyebrow: "Invitation",
    heading: "You’re invited to Lexa",
    body: [
      `An administrator invited you to join Lexa at ${input.origin}.`,
      "Create your account and choose a password to get started.",
    ],
    actionLabel: "Accept invitation",
    link: input.link,
    expiry,
    expiryNote: "This invitation expires seven days after it was created.",
    footer: "If you weren't expecting this invitation, you can ignore this email. No account is created until you accept.",
    origin: input.origin,
  });
}

export function passwordLinkTemplate(input: { to: string; origin: string; link: string; expiresAt: string }): OutboundTemplate {
  const expiry = renderExpiry(input.expiresAt);
  return renderTemplate({
    to: input.to,
    subject: "Set your Lexa password",
    preheader: "An administrator created a password setup link for your Lexa account.",
    eyebrow: "Password setup",
    heading: "Set your password",
    body: [
      `An administrator created a password setup link for your Lexa account at ${input.origin}.`,
      "Choose a password with the button below.",
    ],
    actionLabel: "Set your password",
    link: input.link,
    expiry,
    expiryNote: "This link expires seven days after it was created and can be used once.",
    footer: "Your password doesn't change until you submit a new one.",
    origin: input.origin,
  });
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
