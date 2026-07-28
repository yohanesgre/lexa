import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useProjects } from "./queries";

interface ProjectSelectionContextValue {
  selectedSlug: string | undefined;
  selectedProjectName: string | undefined;
  setSelectedSlug: (slug: string) => void;
}

const ProjectSelectionContext = createContext<ProjectSelectionContextValue | null>(null);

export function ProjectSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(undefined);
  const { data: projects, isLoading } = useProjects();
  const params = useParams({ strict: false }) as { slug?: string };
  const routeSlug = params?.slug;

  useEffect(() => {
    if (routeSlug) {
      setSelectedSlug(routeSlug);
    }
  }, [routeSlug]);

  useEffect(() => {
    if (!isLoading && !selectedSlug && projects && projects.length > 0) {
      setSelectedSlug(projects[0].slug);
    }
  }, [isLoading, selectedSlug, projects]);

  const selectedProjectName = useMemo(
    () => projects?.find((p) => p.slug === selectedSlug)?.name,
    [projects, selectedSlug]
  );

  return (
    <ProjectSelectionContext.Provider
      value={{ selectedSlug, selectedProjectName, setSelectedSlug }}
    >
      {children}
    </ProjectSelectionContext.Provider>
  );
}

export function useProjectSelection() {
  const ctx = useContext(ProjectSelectionContext);
  if (!ctx) {
    throw new Error("useProjectSelection must be used within ProjectSelectionProvider");
  }
  return ctx;
}
