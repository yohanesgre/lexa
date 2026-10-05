import { createFileRoute } from "@tanstack/react-router";
import { GithubCallbackPage } from "../../components/settings/GithubCallbackPage";

export const Route = createFileRoute("/settings/github/callback")({
  validateSearch: (search: Record<string, unknown>): { code?: string | undefined; state?: string | undefined; error?: string | undefined } => ({
    code: typeof search.code === "string" && search.code ? search.code : undefined,
    state: typeof search.state === "string" && search.state ? search.state : undefined,
    error: typeof search.error === "string" && search.error ? search.error : undefined,
  }),
  ssr: false,
  component: GithubCallbackRoute,
});

function GithubCallbackRoute() {
  const { code, state, error } = Route.useSearch();
  return <GithubCallbackPage code={code} state={state} error={error} />;
}
