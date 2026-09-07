import { useState } from "react";
import { ArrowLeft, ArrowRight, Database } from "lucide-react";
import { completeSetup, seedSampleData, type SeedFlavor } from "../../lib/api";

// Step 3 (dev + staging) — optional sample data before completing setup.
// Wireframe: wireframes/src/setup-wizard.html step 3.
const OPTIONS: { flavor: SeedFlavor | "none"; title: string; description: string }[] = [
  {
    flavor: "minimal",
    title: "Minimal",
    description: "1 starter project: Backlog / In Progress / Done, 5 tasks, 1 wiki page — shows the core workflow.",
  },
  {
    flavor: "full",
    title: "Full",
    description: "4 projects, 15 tasks, swimlanes, wiki tree, and GitHub link examples.",
  },
  {
    flavor: "none",
    title: "Empty",
    description: "No sample data. The Backlog swimlane and default columns appear when you create a project.",
  },
];

export function SetupStepSeed({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [choice, setChoice] = useState<SeedFlavor | "none">("minimal");
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    try {
      if (choice !== "none") {
        await seedSampleData(choice).catch(() => {});
      }
      await completeSetup().catch(() => {});
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Database size={16} strokeWidth={1.5} className="text-lx-text-link" />
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Sample data</h2>
      </div>
      <p className="text-sm text-lx-text-secondary leading-5 mb-4">
        Optional demo data so you can explore Lexa right away. Pick how much to load — you can delete it later.
      </p>

      <div role="radiogroup" aria-label="Sample data" className="flex flex-col gap-2 mb-4">
        {OPTIONS.map((option) => (
          <button
            key={option.flavor}
            type="button"
            role="radio"
            aria-checked={choice === option.flavor}
            className="check-row"
            style={{ alignItems: "flex-start", textAlign: "left", width: "100%" }}
            onClick={() => setChoice(option.flavor)}
          >
            <span className={`radio ${choice === option.flavor ? "checked" : ""}`} style={{ marginTop: 3 }} />
            <span>
              <span className="text-sm text-lx-text-primary" style={{ display: "block" }}>{option.title}</span>
              <span className="text-xs text-lx-text-muted" style={{ display: "block", marginTop: 2 }}>{option.description}</span>
            </span>
          </button>
        ))}
      </div>

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
