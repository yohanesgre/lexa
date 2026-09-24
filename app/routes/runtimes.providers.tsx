import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useRuntimeRole } from "../lib/useRuntimeRole";
import { useToast } from "../components/ui/Toast";
import { HeraldProvidersSection } from "../components/settings/HeraldProvidersSection";

export const Route = createFileRoute("/runtimes/providers")({
  ssr:false,
  component: RuntimeProvidersRoute,
});

function RuntimeProvidersRoute() {
  const { canViewProviders, isLoading } = useRuntimeRole();
  const toast = useToast();

  useEffect(() => {
    if (!isLoading && !canViewProviders) {
      toast.push("warning", "You don't have access");
    }
  }, [isLoading, canViewProviders, toast]);

  if (isLoading) return null;
  if (!canViewProviders) {
    return <Navigate to="/runtimes/runs" replace />;
  }

  return (
    <section className="mt-4">
      <HeraldProvidersSection />
    </section>
  );
}
