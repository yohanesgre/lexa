import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Mail, Database, ArrowRight, ArrowLeft, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { getSetupStatus, setSetupAdmin, createSetupApiKey, seedSampleData, type SetupStatus } from "../lib/api";
import { cn } from "../components/ui/cn";

export const Route = createFileRoute("/setup")({
  component: SetupWizard,
});

const STEPS = ["Admin email", "API key", "Sample data", "Done"];

function SetupWizard() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [seed, setSeed] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSetupStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // If already configured, bounce to the dashboard.
  useEffect(() => {
    if (status?.configured && !status?.needsAdmin && status?.hasApiKey) {
      navigate({ to: "/" });
    }
  }, [status, navigate]);

  if (!status) {
    return (
      <main className="page-frame flex items-center justify-center" style={{ minHeight: "100vh" }}>
        <div className="text-center">
          <div className="skeleton" style={{ width: 200, height: 18, margin: "0 auto" }} />
        </div>
      </main>
    );
  }

  const isRemote = typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname);

  const submitAdmin = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmailError("");
    setBusy(true);
    try {
      await setSetupAdmin(trimmed);
      setStep(1);
    } catch {
      setEmailError("Could not save the admin email. Is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const generateKey = async () => {
    setBusy(true);
    try {
      const res = await createSetupApiKey();
      setApiKey(res.key);
      setStep(2);
    } catch {
      setEmailError("Could not create the API key.");
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      if (seed) {
        await seedSampleData().catch(() => {});
      }
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    if (!apiKey) return;
    await navigator.clipboard.writeText(apiKey).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const goToApp = () => {
    if (apiKey) {
      // Persist the key for the browser's API calls (dev convenience).
      try {
        localStorage.setItem("lxk_dev_api_key", apiKey);
      } catch { /* ignore */ }
    }
    navigate({ to: "/" });
  };

  return (
    <main className="page-frame flex items-center justify-center" style={{ minHeight: "100vh" }}>
      <div className="w-full" style={{ maxWidth: 520 }}>
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="font-display text-2xl font-semibold text-lx-text-primary">Lexa Setup</div>
          <div className="font-micro text-2xs text-lx-text-muted mt-1 uppercase tracking-[0.04em]">Install wizard</div>
        </div>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              {i > 0 && <div className="w-6 h-px bg-lx-border-default" />}
              <div className={cn("flex items-center gap-1.5", i === step ? "text-lx-text-primary" : i < step ? "text-lx-text-success" : "text-lx-text-muted")}>
                <span className={cn("w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-medium", i === step ? "border-lx-border-focus text-lx-text-link" : i < step ? "border-lx-text-success" : "border-lx-border-default")}>
                  {i < step ? <Check size={10} strokeWidth={3} /> : i + 1}
                </span>
                <span className="text-xs font-body hidden sm:inline">{label}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-lx-surface-card border border-lx-border-subtle rounded-lg p-6">
          {/* Step 0 — Admin email */}
          {step === 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Mail size={16} strokeWidth={1.5} className="text-lx-text-link" />
                <h2 className="font-display text-lg font-medium text-lx-text-primary">Admin email</h2>
              </div>
              <p className="text-sm text-lx-text-secondary leading-5 mb-4">
                The first person to log in with this email becomes an admin. They can invite teammates and manage settings.
              </p>
              <label className="prop-label block mb-1.5">Email address</label>
              <input
                className="prop-input w-full"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && submitAdmin()}
                placeholder="you@example.com"
                autoFocus
              />
              {emailError && <p className="text-xs text-lx-text-danger mt-2">{emailError}</p>}
              {isRemote && (
                <p className="text-xs text-lx-text-warning mt-3 leading-4">
                  Staging/prod: this email must be a tester in your Google Cloud OAuth consent screen (internal test mode) and inside the Cloudflare Access allow policy, or the first login will fail.
                </p>
              )}
              <div className="flex justify-end mt-5">
                <button type="button" className="btn btn-primary" onClick={submitAdmin} disabled={busy || !email.trim()}>
                  Continue <ArrowRight size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          )}

          {/* Step 1 — API key */}
          {step === 1 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <KeyRound size={16} strokeWidth={1.5} className="text-lx-text-link" />
                <h2 className="font-display text-lg font-medium text-lx-text-primary">API key</h2>
              </div>
              <p className="text-sm text-lx-text-secondary leading-5 mb-4">
                Machine access (MCP agents, scripts) authenticates with a Bearer key. Generate one now — you'll see it only once.
              </p>
              {apiKey ? (
                <div className="flex items-center gap-2">
                  <code className="font-mono text-xs bg-lx-surface-elevated border border-lx-border-default rounded-md px-3 py-2 flex-1 overflow-x-auto whitespace-nowrap">{apiKey}</code>
                  <button type="button" className="btn btn-ghost !w-9 !h-9 !p-0" onClick={copyKey} title="Copy API key" aria-label="Copy API key">
                    {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-primary w-full" onClick={generateKey} disabled={busy}>
                  <KeyRound size={14} strokeWidth={2} />
                  {busy ? "Generating…" : "Generate API key"}
                </button>
              )}
              {apiKey && (
                <p className="text-xs text-lx-text-muted mt-3 leading-4">
                  Copy it now. It won't be shown again. Add it to MCP clients as <code className="font-mono">Bearer {apiKey.slice(0, 6)}…</code>
                </p>
              )}
              <div className="flex justify-between mt-5">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>
                  <ArrowLeft size={14} strokeWidth={2} /> Back
                </button>
                {apiKey && (
                  <button type="button" className="btn btn-primary" onClick={() => setStep(2)}>
                    Continue <ArrowRight size={14} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Step 2 — Sample data */}
          {step === 2 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Database size={16} strokeWidth={1.5} className="text-lx-text-link" />
                <h2 className="font-display text-lg font-medium text-lx-text-primary">Sample data</h2>
              </div>
              <p className="text-sm text-lx-text-secondary leading-5 mb-4">
                Seed the database with demo projects, tasks, and wiki pages so you can explore the board immediately.
              </p>
              <label className="flex items-center justify-between bg-lx-surface-elevated border border-lx-border-default rounded-md px-4 py-3 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-lx-text-primary">Include sample data</div>
                  <div className="text-xs text-lx-text-muted mt-0.5">4 projects, 15 tasks, wiki tree, GitHub link examples</div>
                </div>
                <input type="checkbox" className="w-4 h-4 accent-[var(--lx-accent)]" checked={seed} onChange={(e) => setSeed(e.target.checked)} />
              </label>
              <div className="flex justify-between mt-5">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
                  <ArrowLeft size={14} strokeWidth={2} /> Back
                </button>
                <button type="button" className="btn btn-primary" onClick={finish} disabled={busy}>
                  {busy ? "Setting up…" : "Finish setup"} <ArrowRight size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          )}

          {/* Step 3 — Done */}
          {step === 3 && (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-lx-surface-selected flex items-center justify-center mx-auto mb-4">
                <Sparkles size={20} strokeWidth={1.5} className="text-lx-text-link" />
              </div>
              <h2 className="font-display text-lg font-medium text-lx-text-primary">You're all set</h2>
              <p className="text-sm text-lx-text-secondary mt-2 leading-5" style={{ maxWidth: 340, margin: "0 auto" }}>
                Lexa is configured. Open the dashboard to create projects, or add teammates once they've logged in via Cloudflare Access.
              </p>
              <button type="button" className="btn btn-primary mt-5" onClick={goToApp}>
                Open dashboard <ArrowRight size={14} strokeWidth={2} />
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
