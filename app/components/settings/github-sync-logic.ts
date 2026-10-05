import type { GithubSettings } from "../../lib/api";

// Pure logic for the workspace GitHub Sync settings card.

export function isGithubConfigured(data: GithubSettings | undefined): boolean {
  return !!data && (data.appId !== "" || data.privateKeySet || data.webhookSecretSet);
}

// The App-slug row is HIDDEN entirely when the contract omits/empties the
// slug, rather than rendering an empty read-only input.
export function hasGithubAppSlug(data: { appSlug?: string | undefined } | undefined): boolean {
  return !!data && typeof data.appSlug === "string" && data.appSlug !== "";
}

// `Manage on GitHub` opens the App's public settings page (external, new tab).
export function githubAppSettingsUrl(slug: string | undefined): string {
  return slug ? `https://github.com/settings/apps/${encodeURIComponent(slug)}` : "https://github.com/settings/apps";
}

// Install App CTA target — the App's install page, falling back to GitHub's
// installations list when the contract omits the slug.
export function githubAppInstallUrl(slug: string | undefined): string {
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : "https://github.com/settings/installations";
}

export interface GithubInstallPresentation {
  text: string;
  href: string;
}

// Install-status copy + link for the connected card and the repo type-ahead
// (wireframes/src/settings-workspace.html:370-407). Installed links to the
// installation manager; not installed links to the App's Install page; unknown
// carries no link.
export function installStatusPresentation(
  probe: { status: "installed" | "not_installed" | "unknown"; accounts: string[] },
  slug: string | undefined
): GithubInstallPresentation {
  switch (probe.status) {
    case "installed":
      return { text: "Repo lists are limited to what these installations grant.", href: "https://github.com/settings/installations" };
    case "not_installed":
      return { text: "The App isn't installed on any account yet.", href: githubAppInstallUrl(slug) };
    default:
      return { text: "Couldn't check whether the App is installed right now.", href: "" };
  }
}

// The manifest flow is a form POST: GitHub's create-App form reads the
// `manifest` field from the request body. Pure so it is unit-testable; the
// DOM submission lives in submitManifestForm.
export function manifestFormFields(manifest: unknown): { name: string; value: string }[] {
  return [{ name: "manifest", value: JSON.stringify(manifest) }];
}

// Builds and submits a hidden form to GitHub (hard navigation, no fetch).
export function submitManifestForm(url: string, manifest: unknown): void {
  if (typeof document === "undefined") return;
  const form = document.createElement("form");
  form.method = "post";
  form.action = url;
  for (const field of manifestFormFields(manifest)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = field.name;
    input.value = field.value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

// Callback variant classification from the query GitHub redirects back with.
// Unknown/consumed/expired state, a missing state, and a stale tab all fall
// into the same `invalid` path (the server never distinguishes them either).
export type GithubCallbackOutcome = "completing" | "cancelled" | "invalid";

export function githubCallbackOutcome(search: { code?: string | undefined; state?: string | undefined; error?: string | undefined }): GithubCallbackOutcome {
  if (!search.state) return "invalid";
  if (search.code) return "completing";
  return "cancelled";
}

// Callback API error code → the reason carried back to Settings. Unknown codes
// stay neutral (the base sentence).
export function githubFailureReason(code: string | undefined): string {
  switch (code) {
    case "GITHUB_MANIFEST_EXCHANGE_FAILED":
      return "exchange";
    case "GITHUB_MANIFEST_PERMISSIONS_DENIED":
      return "permissions";
    case "GITHUB_SECRET_WRITE_FAILED":
      return "storage";
    default:
      return "unknown";
  }
}

// Cause-neutral base sentence — a Lexa-side write failure must never be
// misattributed to GitHub. The reason only varies the sentence, never layout.
export const GITHUB_FAILURE_BASE = "Couldn't finish connecting — the authorization was cancelled, the one-time link expired, or Lexa couldn't store the credentials. No credentials were saved.";

export function githubFailureCopy(reason: string | undefined): string {
  switch (reason) {
    case "exchange":
      return "Couldn't finish connecting — GitHub couldn't complete the handshake. No credentials were saved.";
    case "permissions":
      return "Couldn't finish connecting — the GitHub App was created without the required permissions. No credentials were saved.";
    case "storage":
      return "Couldn't finish connecting — Lexa couldn't store the credentials on this server. No credentials were saved.";
    default:
      return GITHUB_FAILURE_BASE;
  }
}

// Callback surface copy is ONE fixed cause-neutral line regardless of the
// failure reason (wireframes/src/settings-github-callback.html); the reason is
// kept for diagnostics only. The reason-specific variants above belong to the
// settings-side card alone.
export const GITHUB_CALLBACK_FAILURE_COPY = "Lexa couldn't finish connecting — no credentials were saved.";

export function canSaveGithubCredentials(appId: string, pemText: string): boolean {
  const appIdOk = /^\d+$/.test(appId);
  const pemOk = pemText === "" || pemText.includes("-----BEGIN");
  return appIdOk && pemOk;
}

// Empty fields mean "keep the stored value"; the secret only rides along
// when the user typed one (secretTouched).
export function saveGithubCredentialsPayload(args: {
  appId: string;
  pemText: string;
  secret: string;
  secretTouched: boolean;
}): { appId: string; privateKey?: string | undefined; webhookSecret?: string } {
  return {
    appId: args.appId,
    ...(args.pemText !== "" ? { privateKey: args.pemText } : {}),
    ...(args.secretTouched ? { webhookSecret: args.secret } : {}),
  };
}

export function webhookUrlNow(): string {
  return typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/github` : "";
}
