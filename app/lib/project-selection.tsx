import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useProjects } from "./queries";

const STORAGE_KEY = "lexa:selectedProject";

interface ProjectSelectionContextValue {
  selectedSlug: string | undefined;
  selectedProjectName: string | undefined;
  setSelectedSlug: (slug: string) => void;
}

const ProjectSelectionContext = createContext<ProjectSelectionContextValue | null>(null);

export function ProjectSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);
  const { data: projects, isLoading } = useProjects();
  const params = useParams({ strict: false }) as { slug?: string };
  const routeSlug = params?.slug;

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (routeSlug) {
      setSelectedSlug(routeSlug);
      try {
        localStorage.setItem(STORAGE_KEY, routeSlug);
      } catch {
        // ignore storage errors
      }
    }
  }, [routeSlug]);

  useEffect(() => {
    if (!hydrated || isLoading || !projects) return;

    const slugs = new Set(projects.map((p) => p.slug));

    if (selectedSlug && slugs.has(selectedSlug)) return;

    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (stored && slugs.has(stored)) {
      setSelectedSlug(stored);
      return;
    }

    if (projects.length > 0) {
      setSelectedSlug(projects[0].slug);
    }
  }, [hydrated, isLoading, projects, selectedSlug]);

  const wrappedSetSelectedSlug = (slug: string) => {
    setSelectedSlug(slug);
    try {
      localStorage.setItem(STORAGE_KEY, slug);
    } catch {
      // ignore storage errors
    }
  };

  const selectedProjectName = useMemo(
    () => projects?.find((p) => p.slug === selectedSlug)?.name,
    [projects, selectedSlug]
  );

  return (
    <ProjectSelectionContext.Provider
      value={{ selectedSlug, selectedProjectName, setSelectedSlug: wrappedSetSelectedSlug }}
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
