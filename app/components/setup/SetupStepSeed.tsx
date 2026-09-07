import { useState } from "react";
import { ArrowLeft, ArrowRight, Database } from "lucide-react";
import { completeSetup, seedSampleData } from "../../lib/api";

// Step 2 (dev only) — optional demo seed before completing setup.
export function SetupStepSeed({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [seed, setSeed] = useState(true);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    try {
      if (seed) {
        await seedSampleData().catch(() => {});
      }
      await completeSetup().catch(() => {});
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
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
        <input type="checkbox" className="w-4 h-4 accent-[var(--lx-text-link)]" checked={seed} onChange={(e) => setSeed(e.target.checked)} />
      </label>
      <div className="flex justify-between mt-5">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={2} /> Back
        </button>
        <button type="button" className="btn btn-primary" onClick={finish} disabled={busy}>
          {busy ? "Setting up…" : "Finish setup"} <ArrowRight size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
