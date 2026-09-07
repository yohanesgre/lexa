import { useEffect } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { completeSetup } from "../../lib/api";

// Final step — confirmation; signing in happens on /login with the session
// cookie (the wizard only provisions the superadmin account). Marks the
// instance complete (setup_complete=1 locks all mutating setup endpoints);
// a locked instance (env-configured) ignores the failure — boot auto-locks.
export function SetupStepDone({ onGoToApp }: { onGoToApp: () => void }) {
  useEffect(() => {
    void completeSetup().catch(() => {});
  }, []);
  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 rounded-full bg-lx-surface-selected flex items-center justify-center mx-auto mb-4">
        <Sparkles size={20} strokeWidth={1.5} className="text-lx-text-link" />
      </div>
      <h2 className="font-display text-lg font-medium text-lx-text-primary">You're all set</h2>
      <p className="text-sm text-lx-text-secondary mt-2 leading-5" style={{ maxWidth: 340, margin: "0 auto" }}>
        Lexa is configured. Open the dashboard to create projects, or invite teammates from workspace settings.
      </p>
      <button type="button" className="btn btn-primary mt-5" onClick={onGoToApp}>
        Open dashboard <ArrowRight size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
