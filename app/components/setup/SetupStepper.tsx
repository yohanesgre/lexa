import { Check } from "lucide-react";
import { cn } from "../ui/cn";

// Install-wizard stepper: current step accent-filled, done steps green, future muted.
export function SetupStepper({ steps, step }: { steps: string[]; step: number }) {
  return (
    <div className="flex items-center justify-center gap-6 mb-8">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-1.5">
          <span
            className={cn(
              "w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-medium",
              i === step ? "border-transparent" : i < step ? "border-lx-text-success" : "border-lx-border-default",
            )}
            style={i === step ? { background: "var(--lx-border-focus)", color: "var(--lx-text-inverse)" } : undefined}
          >
            {i < step ? <Check size={10} strokeWidth={3} /> : i + 1}
          </span>
          <span className={cn("text-xs font-body hidden sm:inline", i === step ? "text-lx-text-primary" : i < step ? "text-lx-text-success" : "text-lx-text-muted")}>{label}</span>
        </div>
      ))}
    </div>
  );
}
