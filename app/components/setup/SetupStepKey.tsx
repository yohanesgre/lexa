import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, KeyRound } from "lucide-react";
import { createSetupApiKey } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";

// Step 1 — generate the machine Bearer key; shown once, then copy. When the
// instance already runs with an env-provided key (LXK_API_KEY), minting is
// locked server-side — the step degrades to a notice + Continue.
export function SetupStepKey({ onDone, onBack, hasApiKey }: { onDone: () => void; onBack: () => void; hasApiKey: boolean }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    setBusy(true);
    try {
      const res = await createSetupApiKey();
      setApiKey(res.key);
    } catch {
      setError("Could not create the API key.");
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    if (!apiKey) return;
    await copyToClipboard(apiKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <KeyRound size={16} strokeWidth={1.5} className="text-lx-text-link" />
        <h2 className="font-display text-lg font-medium text-lx-text-primary">API key</h2>
      </div>
      {hasApiKey && !apiKey ? (
        <>
          <p className="text-sm text-lx-text-secondary leading-5 mb-4">
            This instance already runs with an admin API key provided through the environment. Nothing to mint here — you can add more keys later in Settings → API Keys.
          </p>
          <div className="flex justify-between mt-5">
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              <ArrowLeft size={14} strokeWidth={2} /> Back
            </button>
            <button type="button" className="btn btn-primary" onClick={onDone}>
              Continue <ArrowRight size={14} strokeWidth={2} />
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-lx-text-secondary leading-5 mb-4">
            Machine access (agents, scripts) authenticates with a Bearer key. Generate one now — you'll see it only once.
          </p>
          {error && <p className="text-xs text-lx-text-danger mt-2">{error}</p>}
          {apiKey ? (
            <div className="flex items-center gap-2">
              <code className="font-mono text-xs bg-lx-surface-elevated border border-lx-border-default rounded-md px-3 py-2 flex-1 overflow-x-auto whitespace-nowrap">{apiKey}</code>
              <button type="button" className="btn btn-ghost !w-9 !h-9 !p-0" onClick={copyKey} title="Copy API key" aria-label="Copy API key">
                {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary w-full" onClick={generate} disabled={busy}>
              <KeyRound size={14} strokeWidth={2} />
              {busy ? "Generating…" : "Generate API key"}
            </button>
          )}
          {apiKey && (
            <p className="text-xs text-lx-text-muted mt-3 leading-4">
              Copy it now. It won't be shown again. Add it to clients as <code className="font-mono">Bearer {apiKey.slice(0, 6)}…</code>
            </p>
          )}
          <div className="flex justify-between mt-5">
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              <ArrowLeft size={14} strokeWidth={2} /> Back
            </button>
            {apiKey && (
              <button type="button" className="btn btn-primary" onClick={onDone}>
                Continue <ArrowRight size={14} strokeWidth={2} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
