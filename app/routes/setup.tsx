import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getSetupStatus, type SetupStatus } from "../lib/api";
import { SetupStepper } from "../components/setup/SetupStepper";
import { SetupStepEmail } from "../components/setup/SetupStepEmail";
import { SetupStepKey } from "../components/setup/SetupStepKey";
import { SetupStepSeed } from "../components/setup/SetupStepSeed";
import { SetupStepDone } from "../components/setup/SetupStepDone";

export const Route = createFileRoute("/setup")({
  ssr:false,
  component: SetupWizard,
});

const STEPS = ["Admin email", "API key", "Sample data", "Done"];
const REMOTE_STEPS = ["Admin email", "API key", "Done"];

function isRemoteHost(): boolean {
  return typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname);
}

// Already configured (admin set + key issued) → the wizard has nothing left
// to do.
function setupComplete(status: SetupStatus): boolean {
  return status.configured && !status.needsAdmin && status.hasApiKey;
}

function SetupWizard() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState("");

  useEffect(() => {
    getSetupStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // If already configured, bounce to the dashboard.
  useEffect(() => {
    if (status && setupComplete(status)) {
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

  const isRemote = isRemoteHost();
  const steps = isRemote ? REMOTE_STEPS : STEPS;
  const doneStep = isRemote ? 2 : 3;

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

          {/* Step 1 — API key */}
          {step === 1 && (
            <SetupStepKey hasApiKey={status.hasApiKey} onDone={() => setStep(2)} onBack={() => setStep(0)} />
          )}

          {/* Step 2 — Sample data (dev only) */}
          {step === 2 && !isRemote && (
            <SetupStepSeed onDone={() => setStep(3)} onBack={() => setStep(1)} />
          )}

          {/* Done (step 2 when remote skips sample data) */}
          {step === doneStep && <SetupStepDone onGoToApp={() => navigate({ to: "/" })} />}
        </div>
      </div>
    </main>
  );
}
