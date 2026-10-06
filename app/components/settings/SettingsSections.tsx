import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, Info, Key, Lock, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useApiKeys, useCreateApiKey, useDeleteApiKey, useRateLimit, useUpdateRateLimit, useGithubSettings, useCreateGithubManifest, useClearGithubSettings, useGithubInstallations } from "../../lib/queries";
import { copyToClipboard } from "../../lib/clipboard";
import { formatRelative } from "../../lib/relative-time";
import { Field } from "../ui/Field";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { GithubSyncCredentialsCard } from "./GithubSyncCredentialsCard";
import { githubAppSettingsUrl, githubFailureCopy, hasGithubAppSlug, installStatusPresentation, isGithubConfigured, submitManifestForm, webhookUrlNow } from "./github-sync-logic";

// Workspace-scope settings sections, extracted from the old monolithic
// SettingsPage. All superadmin-gated server-side.

export function InlineDropdown({ items, onSelect, onClose }: { items: { name: string; email: string }[]; onSelect: (email: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  if (items.length === 0) return null;
  return (
    <div ref={ref} className="dropdown-menu" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 10 }}>
      <div className="dropdown-label">Users</div>
      {items.map((u) => (
        <button key={u.email} type="button" className="dropdown-item w-full text-left" onClick={() => onSelect(u.email)}>
          <span>{u.name}</span>
          <span className="text-xs text-lx-text-secondary">{u.email}</span>
        </button>
      ))}
    </div>
  );
}

function ApiKeyRevealModal({ name, fullKey, onDone }: { name: string; fullKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopyKey = async () => {
    const ok = await copyToClipboard(fullKey);
    if (ok) {
      setCopied(true);
    } else {
      setCopyFailed(true);
    }
  };

  return (
    <>
      <div className="slideover-overlay" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto p-0" aria-modal="true" aria-labelledby="api-key-reveal-title" style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}>
          <div className="modal-header">
            <span className="modal-title" id="api-key-reveal-title">API Key Created</span>
            <span className="wip-badge wip-ok">NEW</span>
          </div>

          <div className="modal-body">
            <div className="mb-4">
              <div className="field-label">Name</div>
              <div className="text-sm font-medium text-lx-text-primary">{name}</div>
            </div>

            <div className="mb-4">
              <div className="field-label">Key</div>
              <div className="key-display">
                <code style={{ userSelect: "all" }}>{fullKey}</code>
                <button
                  type="button"
                  className="btn btn-ghost flex-shrink-0"
                  style={{ height: 28, padding: "0 10px", fontSize: 12 }}
                  onClick={handleCopyKey}
                  autoFocus
                >
                  {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="field-hint">Full key is shown here exactly once — in the table it is always masked.</div>
              {copyFailed && (
                <div className="field-hint field-hint-danger">Clipboard blocked — select the key below and copy it manually.</div>
              )}
            </div>

            <div className="notice notice-warning">
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>Shown once. Copy it now.</span>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={onDone}>Done</button>
          </div>
        </dialog>
      </div>
    </>
  );
}

export { ApiKeyRevealModal };

function DeleteKeyModal({ name, owner, onCancel, onConfirm }: { name: string; owner?: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      title="Delete API key?"
      body={<>This will permanently delete{" "}<span className="chip font-mono text-xs text-lx-text-primary">{name}</span>{owner ? <>{" "}<span className="text-xs text-lx-text-secondary">(owned by {owner})</span></> : null} — agents and integrations using this key will lose access immediately. This action cannot be undone.</>}
      confirmLabel="Delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export { DeleteKeyModal };

function RemoveGithubSyncModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Remove GitHub sync?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            This removes the stored App ID, private key, and webhook secret. GitHub sync stops immediately — already-linked issues stay linked but stop syncing. This action cannot be undone.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Remove
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

// API Keys (workspace scope — superadmin gated)
export function ApiKeysSection() {
  const { data: keys = [], isLoading, isError } = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();
  const [keyName, setKeyName] = useState("");
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string; owner: string | null } | null>(null);
  const generateBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">API Keys</h2>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Machine authentication for agents and integrations. Keys are stored securely — never in plain text. Keys with no owner are server keys. Only the full key is shown once on creation.
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load API keys.</div>
      ) : keys.length === 0 ? (
        <div className="card-panel flex flex-col items-center gap-1.5 text-center mb-4" style={{ borderStyle: "dashed", borderColor: "var(--lx-border-strong)", padding: 32 }}>
          <Key size={20} strokeWidth={1.5} className="text-lx-text-muted" />
          <div className="text-sm font-medium text-lx-text-primary mt-1">No API keys yet</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 360 }}>
            Generate a key below to connect Hermes, OpenCode, or other agents to this project.
          </p>
        </div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden", marginBottom: 16 }}>
          <table className="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last Used</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} style={deleting?.id === k.id ? { background: "var(--lx-bg-danger-subtle)" } : undefined}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Key size={14} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />
                      <span className="text-sm font-medium">{k.name}</span>
                    </div>
                  </td>
                  <td>
                    {k.ownerEmail ? (
                      <>
                        <div className="flex items-center gap-2">
                          <div className="avatar">{(k.ownerName ?? "?")[0]?.toUpperCase()}</div>
                          <span className="text-xs font-medium">{k.ownerName}</span>
                        </div>
                        <div className="text-xs text-lx-text-muted">{k.ownerEmail}</div>
                      </>
                    ) : (
                      <span style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>Server key</span>
                    )}
                  </td>
                  <td>
                    <span className="font-mono text-xs text-lx-text-muted">lxk_••••••••••••••••••••••••••••••••</span>
                  </td>
                  <td className="text-xs text-lx-text-secondary">{k.createdAt.slice(0, 10)}</td>
                  <td className="text-xs text-lx-text-secondary">
                    {k.lastUsedAt ? formatRelative(k.lastUsedAt) : <span className="text-lx-text-muted">Never</span>}
                  </td>
                  <td>
                    <button type="button" className="btn btn-danger btn-sm" aria-label={`Delete key ${k.name}`} title="Revoke key" onClick={() => setDeleting({ id: k.id, name: k.name, owner: k.ownerEmail ? `${k.ownerName ?? "?"} · ${k.ownerEmail}` : null })}>
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card-panel card-panel--elevated">
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Create New Key</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            className="prop-input"
            aria-label="Key name"
            placeholder="Key name (e.g. Hermes Staging)"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            style={{ minWidth: 240 }}
          />
          <button
            ref={generateBtnRef}
            type="button"
            className="btn btn-primary"
            disabled={!keyName.trim() || createKey.isPending}
            onClick={() =>
              createKey.mutate(keyName.trim(), {
                onSuccess: (data) => {
                  setReveal({ name: data.key.name, key: data.rawKey });
                  setKeyName("");
                },
              })
            }
          >
            <Plus size={14} strokeWidth={1.5} />
            {createKey.isPending ? "Generating…" : "Generate Key"}
          </button>
        </div>
        <div className="field-hint" style={{ marginTop: 8 }}>The new key binds to your account — you'll own it, and it appears under Settings → Me → API keys.</div>
      </div>

      {reveal && (
        <ApiKeyRevealModal
          name={reveal.name}
          fullKey={reveal.key}
          onDone={() => {
            setReveal(null);
            generateBtnRef.current?.focus();
          }}
        />
      )}

      {deleting && (
        <DeleteKeyModal
          name={deleting.name}
          {...(deleting.owner ? { owner: deleting.owner } : {})}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deleteKey.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
          }}
        />
      )}
    </section>
  );
}

// Rate Limiting (workspace scope — superadmin gated)
export function RateLimitSection() {
  const { data, isLoading, isError } = useRateLimit();
  const save = useUpdateRateLimit();
  const [max, setMax] = useState("");
  const [windowMin, setWindowMin] = useState("");
  const synced = useRef(false);

  useEffect(() => {
    if (data && !synced.current) {
      synced.current = true;
      setMax(String(data.max));
      setWindowMin(String(data.windowMs / 60000));
    }
  }, [data]);

  const maxNum = Number(max);
  const windowNum = Number(windowMin);
  // Mirrors the server validation (integers, max >= 1, windowMs >= 1000) so
  // Save is only offered once the inputs can succeed; the server stays
  // authoritative and surfaces 422s via the error toast.
  const canSave = Number.isInteger(maxNum) && maxNum >= 1 && Number.isFinite(windowNum) && windowNum * 60000 >= 1000;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Rate Limiting</h2>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Per-client-IP request budget for the API surface. Applies to all API requests; AI machine surfaces are exempt. Changes apply immediately — no restart needed.
      </p>

      {data?.envOverride && (
        <p className="text-xs text-lx-text-muted mb-2">
          Server environment variables override these when set. Saving new values below overrides them.
        </p>
      )}

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load rate limits.</div>
      ) : (
        <div className="card-panel card-panel--elevated">
          <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Request Budget</h3>
          <div className="flex items-end gap-3 flex-wrap">
            <Field label="Max requests" htmlFor="rate-limit-max" className="field mb-0">
              <div className="flex items-center gap-2">
                <input
                  id="rate-limit-max"
                  className="prop-input"
                  type="number"
                  min={1}
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  style={{ width: 96, textAlign: "right" }}
                />
                <span className="text-xs text-lx-text-secondary">per IP per window</span>
              </div>
            </Field>
            <Field label="Window" htmlFor="rate-limit-window" className="field mb-0">
              <div className="flex items-center gap-2">
                <input
                  id="rate-limit-window"
                  className="prop-input"
                  type="number"
                  value={windowMin}
                  onChange={(e) => setWindowMin(e.target.value)}
                  style={{ width: 96, textAlign: "right" }}
                />
                <span className="text-xs text-lx-text-secondary">minutes</span>
              </div>
            </Field>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSave || save.isPending}
              onClick={() => save.mutate({ max: maxNum, windowMs: Math.round(windowNum * 60000) })}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// Return result the callback lands with on /settings/workspace
// (?github=connected | ?github=failed&reason=…).
export interface GithubReturnResult {
  status: "connected" | "failed";
  reason?: string | undefined;
}

function GithubStatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return <span className="font-micro text-2xs" style={{ background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", padding: "2px 8px", borderRadius: 9999 }}>connected</span>;
  }
  return <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", border: "1px solid var(--lx-border-default)", padding: "2px 8px", borderRadius: 9999 }}>not connected</span>;
}

function GithubAppConnectedCard({ data, onConnect, connecting }: { data: { appId: string; appSlug: string }; onConnect: () => void; connecting: boolean }) {
  const [copied, setCopied] = useState(false);
  const webhookUrl = webhookUrlNow();
  const probe = useGithubInstallations(true);
  const install = probe.data ? installStatusPresentation(probe.data, data.appSlug) : null;

  const handleCopy = async () => {
    const ok = await copyToClipboard(webhookUrl);
    if (ok) setCopied(true);
  };

  return (
    <div className="card-panel card-panel--elevated mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-base font-medium text-lx-text-primary">GitHub App</h3>
        <GithubStatusBadge connected />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="App ID" htmlFor="github-app-id" className="field mb-0">
          <input id="github-app-id" className="prop-input font-mono" value={data.appId} readOnly style={{ width: "100%" }} />
        </Field>
        {hasGithubAppSlug(data) && (
          <Field label="App slug" htmlFor="github-app-slug" className="field mb-0">
            <input id="github-app-slug" className="prop-input font-mono" value={data.appSlug} readOnly style={{ width: "100%" }} />
          </Field>
        )}
      </div>

      <Field label="Webhook URL" htmlFor="github-webhook-url" className="field mt-3 mb-0" hint="Auto-set by the connect flow — nothing to paste. Incoming events are HMAC-verified with the generated secret.">
        <div className="flex items-center gap-2">
          <input id="github-webhook-url" className="prop-input font-mono" value={webhookUrl} readOnly style={{ flex: 1, fontSize: 12 }} />
          <button type="button" className="btn btn-ghost" style={{ height: 32, padding: "0 12px", fontSize: 12 }} onClick={handleCopy}>
            <Copy size={12} strokeWidth={1.5} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </Field>

      <div className="notice mt-3" style={{ marginBottom: 0 }}>
        <Lock size={14} strokeWidth={1.5} />
        <span>The private key and webhook secret were generated by GitHub and stored encrypted at rest (AES-256-GCM, server master key) — never shown again, never returned by the API.</span>
      </div>

      {install && probe.data && (
        <div className="field mt-3" style={{ marginBottom: 0 }}>
          <label className="field-label" style={{ marginBottom: 6 }}>Install status</label>
          {probe.data.status === "installed" ? (
            <div className="gh-install">
              <div className="flex items-center justify-between gap-2" style={{ flexWrap: "wrap" }}>
                <span className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                  {probe.data.accounts.map((account) => (
                    <span key={account} className="gh-install-account">{account}</span>
                  ))}
                </span>
                <span className="font-micro text-2xs" style={{ background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", padding: "2px 8px", borderRadius: 9999 }}>installed</span>
              </div>
              <div className="field-hint" style={{ marginTop: 0 }}>
                {install.text}{" "}
                <a href={install.href} target="_blank" rel="noreferrer" className="text-lx-text-link">Manage installations on GitHub</a>.
              </div>
            </div>
          ) : probe.data.status === "not_installed" ? (
            <div className="gh-install">
              <div className="flex items-center justify-between gap-2" style={{ flexWrap: "wrap" }}>
                <span className="text-xs text-lx-text-secondary">{install.text}</span>
                <a className="btn btn-primary btn-sm" href={install.href} target="_blank" rel="noreferrer" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>Install App</a>
              </div>
              <div className="field-hint" style={{ marginTop: 0 }}>Opens GitHub to pick the account and repos. Until installed, the project Linked repos search stays empty.</div>
            </div>
          ) : (
            <div className="gh-install">
              <div className="flex items-center justify-between gap-2" style={{ flexWrap: "wrap" }}>
                <span className="text-xs text-lx-text-muted">{install.text}</span>
                <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", border: "1px solid var(--lx-border-default)", padding: "2px 8px", borderRadius: 9999 }}>unknown</span>
              </div>
              <div className="field-hint" style={{ marginTop: 0 }}>GitHub didn&apos;t answer the installation probe. Repo search may be incomplete until it recovers.</div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-3">
        <a
          className="btn btn-ghost"
          href={githubAppSettingsUrl(data.appSlug)}
          target="_blank"
          rel="noreferrer"
          style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 14px", fontSize: 12 }}
        >
          Manage on GitHub
          <ExternalLink size={12} strokeWidth={1.5} />
        </a>
        <button type="button" className="btn btn-ghost" style={{ height: 32, padding: "0 14px", fontSize: 12 }} onClick={onConnect} disabled={connecting}>
          Connect GitHub App
        </button>
      </div>
    </div>
  );
}

function GithubAppIdleCard({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="card-panel card-panel--elevated mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-base font-medium text-lx-text-primary">GitHub App</h3>
        <GithubStatusBadge connected={false} />
      </div>
      <p className="text-sm text-lx-text-secondary mb-3" style={{ maxWidth: 520 }}>
        Connect a GitHub App so Lexa can sync issues both ways. GitHub walks you through creating the App; you come back here when it&apos;s done.
      </p>
      <button type="button" className="btn btn-primary" onClick={onConnect}>
        <Plus size={14} strokeWidth={1.5} />
        Connect GitHub App
      </button>
    </div>
  );
}

function GithubAppRedirectingCard() {
  return (
    <div className="card-panel card-panel--elevated mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-base font-medium text-lx-text-primary">GitHub App</h3>
        <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", border: "1px solid var(--lx-border-default)", padding: "2px 8px", borderRadius: 9999 }}>redirecting</span>
      </div>
      <button type="button" className="btn btn-primary" disabled>
        <span className="spinner" style={{ width: 12, height: 12 }} />
        Connecting…
      </button>
      <div className="notice mt-3" style={{ marginBottom: 0 }}>
        <Info size={14} strokeWidth={1.5} />
        <span>Redirecting to GitHub… don&apos;t close this tab. You&apos;ll return here automatically.</span>
      </div>
    </div>
  );
}

function GithubAppFailedCard({ reason, onRetry, onManual, retrying }: { reason?: string | undefined; onRetry: () => void; onManual: () => void; retrying: boolean }) {
  return (
    <div className="card-panel card-panel--elevated mt-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-base font-medium text-lx-text-primary">GitHub App</h3>
        <span className="font-micro text-2xs" style={{ background: "var(--lx-bg-danger-subtle)", color: "var(--lx-text-danger)", padding: "2px 8px", borderRadius: 9999 }}>not connected</span>
      </div>
      <div className="notice notice-danger" style={{ marginBottom: 12 }}>
        <AlertCircle size={14} strokeWidth={1.5} />
        <span>{githubFailureCopy(reason)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={onRetry} disabled={retrying}>
          <RefreshCw size={12} strokeWidth={1.5} />
          Retry
        </button>
        <button type="button" className="btn btn-ghost" onClick={onManual}>Use manual credentials</button>
      </div>
    </div>
  );
}

// GitHub Sync (workspace scope — superadmin gated)
export function GithubSyncSection({ githubResult }: { githubResult?: GithubReturnResult | undefined }) {
  const { data, isLoading, isError } = useGithubSettings();
  const remove = useClearGithubSettings();
  const manifest = useCreateGithubManifest();
  const [removing, setRemoving] = useState(false);
  const [manifestFailed, setManifestFailed] = useState(false);
  const [showConnectedBanner, setShowConnectedBanner] = useState(githubResult?.status === "connected");
  const manualRef = useRef<HTMLDetailsElement>(null);

  // Success banner auto-dismisses after 5s; a failure stays until navigation.
  useEffect(() => {
    if (githubResult?.status !== "connected") return;
    setShowConnectedBanner(true);
    const timer = setTimeout(() => setShowConnectedBanner(false), 5000);
    return () => clearTimeout(timer);
  }, [githubResult]);

  const startConnect = () => {
    setManifestFailed(false);
    manifest.mutate(undefined, {
      // Success hands off to a hard form POST to GitHub (window unload follows).
      onSuccess: (res) => submitManifestForm(res.url, res.manifest),
      onError: () => setManifestFailed(true),
    });
  };

  const configured = isGithubConfigured(data);
  const failed = githubResult?.status === "failed" || manifestFailed;
  const redirecting = manifest.isPending && !failed;

  // Disclosure state is UI-only and never persisted: collapsed once the App is
  // configured, expanded when it is not, and force-expanded on a connect failure.
  // `isLoading` is in the deps because the <details> only mounts after the
  // settings read resolves — without it the first uncached load leaves the
  // initial (collapsed) state in place, since `configured`/`failed` never
  // change on that render.
  useEffect(() => {
    if (manualRef.current) manualRef.current.open = !configured;
  }, [configured, isLoading]);
  useEffect(() => {
    if (failed && manualRef.current) manualRef.current.open = true;
  }, [failed, isLoading]);

  // Escape hatch from the failed card: expand the disclosure and scroll to it.
  const openManual = () => {
    const el = manualRef.current;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">GitHub Sync</h2>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Two-way issue sync between GitHub and Lexa boards. Configured with GitHub App credentials; incoming events are verified with your webhook secret. Per-project repo linking lives in the project settings surface (project switcher → Project settings).
      </p>

      {showConnectedBanner && (
        <div className="notice notice-success mb-3">
          <CheckCircle2 size={14} strokeWidth={1.5} />
          <span>GitHub App connected — secrets stored and webhook configured.</span>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load GitHub sync.</div>
      ) : (
        <>
          {failed ? (
            <GithubAppFailedCard
              reason={githubResult?.reason}
              onRetry={startConnect}
              retrying={manifest.isPending}
              onManual={openManual}
            />
          ) : redirecting ? (
            <GithubAppRedirectingCard />
          ) : configured && data ? (
            <GithubAppConnectedCard data={data} onConnect={startConnect} connecting={false} />
          ) : (
            <GithubAppIdleCard onConnect={startConnect} />
          )}

          <details className="health-details mt-4" id="github-manual-credentials" ref={manualRef}>
            <summary>
              <svg className="health-details-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              Advanced: manual credentials
            </summary>
            <div className="health-details-body health-details-body--card">
              <GithubSyncCredentialsCard onRemove={() => setRemoving(true)} />
            </div>
          </details>
        </>
      )}

      {removing && (
        <RemoveGithubSyncModal
          onCancel={() => setRemoving(false)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => setRemoving(false),
            })
          }
        />
      )}
    </section>
  );
}
