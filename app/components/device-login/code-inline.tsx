// Prepended / inline code chips on the approve surface (wireframe
// device-login.html reference chips).
export function CodeInline({ children }: { children: string }) {
  return (
    <code style={{ fontFamily: "var(--lx-font-mono)", fontSize: 12, background: "var(--lx-surface-elevated)", padding: "2px 4px", borderRadius: 4, color: "var(--lx-text-secondary)" }}>
      {children}
    </code>
  );
}