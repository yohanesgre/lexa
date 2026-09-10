import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { InvalidTokenState, SetPasswordForm } from "../components/auth/SetPasswordForm";
import { useSession } from "../lib/queries";

export const Route = createFileRoute("/set-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string | undefined } => ({
    token: typeof search.token === "string" && search.token ? search.token : undefined,
  }),
  ssr: false,
  component: SetPasswordPage,
});

export function SetPasswordPage() {
  const { token } = Route.useSearch();
  const { data: session, isLoading } = useSession();
  const [completed, setCompleted] = useState(false);

  if (isLoading) return null;
  if (session?.user && !completed) return <Navigate to="/" replace />;

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div>
          <div className="font-display mb-1" style={{ textAlign: "center", fontSize: 24, fontWeight: 600 }}>Lexa</div>
          <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>Set your password</p>
        </div>
        {token ? <SetPasswordForm token={token} onDone={() => setCompleted(true)} /> : <InvalidTokenState />}
      </div>
    </main>
  );
}