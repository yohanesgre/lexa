import { createFileRoute } from "@tanstack/react-router";
import { InvalidTokenState, SetPasswordForm } from "../components/auth/SetPasswordForm";

// A valid token is the authority on this surface: a browser with a cached
// session must still be able to finish a self-service or admin-issued reset.
// The reset itself revokes sessions and starts no new one.
export const Route = createFileRoute("/set-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string | undefined } => ({
    token: typeof search.token === "string" && search.token ? search.token : undefined,
  }),
  ssr: false,
  component: SetPasswordPage,
});

function SetPasswordPage() {
  const { token } = Route.useSearch();

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div>
          <div className="font-display mb-1" style={{ textAlign: "center", fontSize: 24, fontWeight: 600 }}>Lexa</div>
          <p className="text-sm text-lx-text-secondary mb-4" style={{ textAlign: "center" }}>Set your password</p>
        </div>
        {token ? <SetPasswordForm token={token} /> : <InvalidTokenState />}
      </div>
    </main>
  );
}