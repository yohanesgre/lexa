import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/herald/usage")({
  validateSearch: (search: Record<string, unknown>): { from?: string | undefined; to?: string | undefined } => ({
    from: typeof search.from === "string" && search.from ? search.from : undefined,
    to: typeof search.to === "string" && search.to ? search.to : undefined,
  }),
  ssr: false,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/hearth/usage",
      search: search as never,
    } as never);
  },
  component: LegacyRedirect,
});

function LegacyRedirect() {
  const search = Route.useSearch() as { from?: string | undefined; to?: string | undefined };
  return <Navigate to="/hearth/usage" search={search as never} replace />;
}
