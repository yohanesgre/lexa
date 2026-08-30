import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useHearthRole } from "../lib/useHearthRole";
import { useToast } from "../components/ui/Toast";
import { HeraldProvidersSection } from "../components/settings/HeraldProvidersSection";

export const Route = createFileRoute("/hearth/providers")({
  ssr:false,
  component: HearthProvidersRoute,
});

function HearthProvidersRoute() {
  const { canViewProviders, isLoading } = useHearthRole();
  const toast = useToast();

  useEffect(() => {
    if (!isLoading && !canViewProviders) {
      toast.push("warning", "You don't have access");
    }
  }, [isLoading, canViewProviders, toast]);

  if (isLoading) return null;
  if (!canViewProviders) {
    return <Navigate to="/hearth/runs" replace />;
  }

  return (
    <section className="mt-4">
      <HeraldProvidersSection />
    </section>
  );
}
