// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  isGithubConfigured,
  hasGithubAppSlug,
  githubAppSettingsUrl,
  manifestFormFields,
  submitManifestForm,
  githubCallbackOutcome,
  githubFailureReason,
  githubFailureCopy,
  GITHUB_FAILURE_BASE,
  canSaveGithubCredentials,
  saveGithubCredentialsPayload,
  webhookUrlNow,
} from "./github-sync-logic";
import type { GithubSettings } from "../../lib/api";

const SETTINGS: GithubSettings = { appId: "1234567", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isGithubConfigured", () => {
  it("is false for undefined, an empty summary, and true once any credential exists", () => {
    expect(isGithubConfigured(undefined)).toBe(false);
    expect(isGithubConfigured({ appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" })).toBe(false);
    expect(isGithubConfigured(SETTINGS)).toBe(true);
    expect(isGithubConfigured({ ...SETTINGS, appId: "" })).toBe(true);
  });
});

describe("hasGithubAppSlug", () => {
  it("is false when the contract omits or empties the slug (row hides)", () => {
    expect(hasGithubAppSlug(undefined)).toBe(false);
    expect(hasGithubAppSlug({ ...SETTINGS, appSlug: "" })).toBe(false);
    expect(hasGithubAppSlug(SETTINGS)).toBe(true);
  });
});

describe("githubAppSettingsUrl", () => {
  it("points at the App's public settings page and encodes the slug", () => {
    expect(githubAppSettingsUrl("lexa-nimbus")).toBe("https://github.com/settings/apps/lexa-nimbus");
    expect(githubAppSettingsUrl("a b/c")).toBe("https://github.com/settings/apps/a%20b%2Fc");
  });

  it("falls back to the Apps index with no slug", () => {
    expect(githubAppSettingsUrl(undefined)).toBe("https://github.com/settings/apps");
    expect(githubAppSettingsUrl("")).toBe("https://github.com/settings/apps");
  });
});

describe("manifestFormFields", () => {
  it("carries a single JSON-stringified manifest field", () => {
    expect(manifestFormFields({ name: "lexa", hook_attributes: { url: "x" } })).toEqual([
      { name: "manifest", value: '{"name":"lexa","hook_attributes":{"url":"x"}}' },
    ]);
  });
});

describe("submitManifestForm", () => {
  it("POSTs a hidden form to GitHub and submits it", () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    submitManifestForm("https://github.com/settings/apps/new?state=s1", { name: "lexa" });
    const form = document.body.querySelector("form");
    expect(form).not.toBeNull();
    expect(form?.method).toBe("post");
    expect(form?.action).toBe("https://github.com/settings/apps/new?state=s1");
    const input = form?.querySelector("input") as HTMLInputElement;
    expect(input.name).toBe("manifest");
    expect(input.value).toBe('{"name":"lexa"}');
    expect(submit).toHaveBeenCalledTimes(1);
    form?.remove();
  });
});

describe("githubCallbackOutcome", () => {
  it("invalid whenever the one-time state is missing", () => {
    expect(githubCallbackOutcome({})).toBe("invalid");
    expect(githubCallbackOutcome({ code: "c", error: "access_denied" })).toBe("invalid");
  });

  it("completing with a state + code, cancelled with a state alone", () => {
    expect(githubCallbackOutcome({ state: "s1", code: "c0de" })).toBe("completing");
    expect(githubCallbackOutcome({ state: "s1" })).toBe("cancelled");
    expect(githubCallbackOutcome({ state: "s1", error: "access_denied" })).toBe("cancelled");
  });
});

describe("githubFailureReason", () => {
  it("maps the setup error codes; unknown stays neutral", () => {
    expect(githubFailureReason("GITHUB_MANIFEST_EXCHANGE_FAILED")).toBe("exchange");
    expect(githubFailureReason("GITHUB_MANIFEST_PERMISSIONS_DENIED")).toBe("permissions");
    expect(githubFailureReason("GITHUB_SECRET_WRITE_FAILED")).toBe("storage");
    expect(githubFailureReason("GITHUB_MANIFEST_STATE_INVALID")).toBe("unknown");
    expect(githubFailureReason(undefined)).toBe("unknown");
  });
});

describe("githubFailureCopy", () => {
  it("varies the sentence by reason but never the layout, defaulting to the cause-neutral base", () => {
    expect(githubFailureCopy(undefined)).toBe(GITHUB_FAILURE_BASE);
    expect(githubFailureCopy("unknown")).toBe(GITHUB_FAILURE_BASE);
    expect(githubFailureCopy("exchange")).toMatch(/handshake/);
    expect(githubFailureCopy("permissions")).toMatch(/without the required permissions/);
    expect(githubFailureCopy("storage")).toMatch(/store the credentials on this server/);
  });
});

describe("canSaveGithubCredentials", () => {
  it("requires a numeric App ID and either an empty or PEM private key", () => {
    expect(canSaveGithubCredentials("123", "")).toBe(true);
    expect(canSaveGithubCredentials("123", "-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(canSaveGithubCredentials("abc", "")).toBe(false);
    expect(canSaveGithubCredentials("123", "not-a-pem")).toBe(false);
  });
});

describe("saveGithubCredentialsPayload", () => {
  it("omits untouched secrets so the server keeps the stored value", () => {
    expect(saveGithubCredentialsPayload({ appId: "123", pemText: "", secret: "", secretTouched: false })).toEqual({ appId: "123" });
  });

  it("rides the typed secret and PEM along", () => {
    expect(saveGithubCredentialsPayload({ appId: "123", pemText: "-----BEGIN", secret: "shh", secretTouched: true })).toEqual({
      appId: "123",
      privateKey: "-----BEGIN",
      webhookSecret: "shh",
    });
  });
});

describe("webhookUrlNow", () => {
  it("derives the HMAC-verified webhook URL from the host", () => {
    expect(webhookUrlNow()).toBe(`${window.location.origin}/api/webhooks/github`);
  });
});
