export function IconFrame({ children, tone }: { children: React.ReactNode; tone: "neutral" | "success" | "warning" }) {
  const style =
    tone === "success"
      ? { background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", borderRadius: 9999, width: 36, height: 36 }
      : tone === "warning"
        ? { background: "var(--lx-bg-warning-subtle)", border: "1px solid rgba(240,192,64,0.15)", color: "var(--lx-text-warning)", borderRadius: 12, width: 48, height: 48 }
        : { background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", color: "var(--lx-text-muted)", borderRadius: 12, width: 48, height: 48 };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", ...style }}>
      {children}
    </div>
  );
}