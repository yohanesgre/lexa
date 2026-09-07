import type { GithubSettings } from "../../lib/api";

// Pure logic for the workspace GitHub Sync settings card.

export function isGithubConfigured(data: GithubSettings | undefined): boolean {
  return !!data && (data.appId !== "" || data.privateKeySet || data.webhookSecretSet);
}

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
