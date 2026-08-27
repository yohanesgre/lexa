import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useProjects } from "./queries";

const STORAGE_KEY = "lexa:selectedProject";

// Auth/setup surfaces render without app chrome and never have a session —
// fetching the project list there would 401 (and retry-spam the console).
const PUBLIC_PATHS = new Set(["/login", "/set-password", "/invite", "/setup"]);
// Public wiki share reads: token-authenticated, no session — same 401 logic.
const PUBLIC_PREFIXES = ["/share/"];

interface ProjectSelectionContextValue {
  selectedSlug: string | undefined;
  selectedProjectName: string | undefined;
  setSelectedSlug: (slug: string) => void;
}

const ProjectSelectionContext = createContext<ProjectSelectionContextValue | null>(null);

export function ProjectSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isPublic = PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  // On public pages there is no session, so the project list would 401 — skip
  // the fetch entirely (the provider isn't consumed by bare surfaces anyway).
  const { data: projects, isLoading } = useProjects({ enabled: !isPublic });
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
      setSelectedSlug(projects[0]!.slug);
    }
  }, [hydrated, isLoading, projects, selectedSlug]);

  const wrappedSetSelectedSlug = useCallback(
    (slug: string) => {
      setSelectedSlug(slug);
      try {
        localStorage.setItem(STORAGE_KEY, slug);
      } catch {
        // ignore storage errors
      }
    },
    []
  );

  const selectedProjectName = useMemo(
    () => projects?.find((p) => p.slug === selectedSlug)?.name,
    [projects, selectedSlug]
  );

  const contextValue = useMemo(
    () => ({ selectedSlug, selectedProjectName, setSelectedSlug: wrappedSetSelectedSlug }),
    [selectedSlug, selectedProjectName, wrappedSetSelectedSlug]
  );

  return (
    <ProjectSelectionContext.Provider value={contextValue}>
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
