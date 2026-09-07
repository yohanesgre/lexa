import { Check } from "lucide-react";
import { cn } from "../ui/cn";

// Install-wizard stepper: done steps green, current highlighted, future muted.
export function SetupStepper({ steps, step }: { steps: string[]; step: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((label, i) => (
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
  );
}
