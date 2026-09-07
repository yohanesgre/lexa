import type { ReactNode } from "react";

export function NoticeDanger({ children }: { children: ReactNode }) {
  return (
    <div className="notice notice-danger mb-4">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
      <span>{children}</span>
    </div>
  );
}
