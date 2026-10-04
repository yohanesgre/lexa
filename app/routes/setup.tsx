import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getSetupStatus, type SetupStatus } from "../lib/api";
import { SetupStepper } from "../components/setup/SetupStepper";
import { SetupStepEmail } from "../components/setup/SetupStepEmail";
import { SetupStepSeed } from "../components/setup/SetupStepSeed";
import { SetupStepDone } from "../components/setup/SetupStepDone";

export const Route = createFileRoute("/setup")({
  ssr:false,
  component: SetupWizard,
});

const STEPS = ["Admin email", "Sample data", "Done"];
const REMOTE_STEPS = ["Admin email", "Done"];

function isRemoteHost(): boolean {
  return typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname);
}

// Already configured (superadmin set) → the wizard has nothing left
// to do.
function setupComplete(status: SetupStatus): boolean {
  return status.configured && !status.needsAdmin;
}

function SetupWizard() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [statusNonce, setStatusNonce] = useState(0);
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let alive = true;
    setStatusError(false);
    getSetupStatus()
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { if (alive) setStatusError(true); });
    return () => { alive = false; };
  }, [statusNonce]);

  // If already configured, bounce to the dashboard.
  useEffect(() => {
    if (status && setupComplete(status)) {
      navigate({ to: "/" });
    }
  }, [status, navigate]);

  if (statusError && !status) {
    return (
      <main className="page-frame flex items-center justify-center" style={{ minHeight: "100vh" }}>
        <div className="text-center">
          <p className="text-sm text-lx-text-secondary">Could not load setup status.</p>
          <button type="button" className="btn btn-primary btn-sm mt-3" onClick={() => setStatusNonce((n) => n + 1)}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="page-frame flex items-center justify-center" style={{ minHeight: "100vh" }}>
        <div className="text-center">
          <div className="skeleton" style={{ width: 200, height: 18, margin: "0 auto" }} />
        </div>
      </main>
    );
  }

  const isRemote = isRemoteHost();
  const steps = isRemote ? REMOTE_STEPS : STEPS;
  const doneStep = isRemote ? 1 : 2;

  return (
    <main className="page-frame flex items-center justify-center" style={{ minHeight: "100vh" }}>
      <div className="w-full" style={{ maxWidth: 520 }}>
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="font-display text-2xl font-semibold text-lx-text-primary">Lexa Setup</div>
          <div className="font-micro text-2xs text-lx-text-muted mt-1 uppercase tracking-[0.04em]">Install wizard</div>
        </div>

        <SetupStepper steps={steps} step={step} />

        <div className="card-panel">
          {/* Step 0 — Admin email */}
          {step === 0 && (
            <SetupStepEmail email={email} onEmailChange={setEmail} isRemote={isRemote} onDone={() => setStep(1)} />
          )}

          {/* Step 1 — Sample data (local installs only) */}
          {step === 1 && !isRemote && (
            <SetupStepSeed onDone={() => setStep(2)} onBack={() => setStep(0)} />
          )}

          {/* Done (step 1 when remote skips sample data) */}
          {step === doneStep && <SetupStepDone onGoToApp={() => navigate({ to: "/" })} />}
        </div>
      </div>
    </main>
  );
}
