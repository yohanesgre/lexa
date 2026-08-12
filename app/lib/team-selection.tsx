import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "lexa:selectedTeam";

interface TeamSelectionContextValue {
  activeTeamId: string | undefined;
  setActiveTeamId: (teamId: string) => void;
}

const TeamSelectionContext = createContext<TeamSelectionContextValue | null>(null);

// Active team for the settings/team surface (superadmin switcher). Persisted
// across sessions like the project selection.
export function TeamSelectionProvider({ children }: { children: React.ReactNode }) {
  const [activeTeamId, setActiveTeamIdState] = useState<string | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || activeTeamId) return;
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (stored) setActiveTeamIdState(stored);
  }, [hydrated, activeTeamId]);

  const setActiveTeamId = useCallback((teamId: string) => {
    setActiveTeamIdState(teamId);
    try {
      localStorage.setItem(STORAGE_KEY, teamId);
    } catch {
      // ignore storage errors
    }
  }, []);

  const contextValue = useMemo(() => ({ activeTeamId, setActiveTeamId }), [activeTeamId, setActiveTeamId]);

  return (
    <TeamSelectionContext.Provider value={contextValue}>
      {children}
    </TeamSelectionContext.Provider>
  );
}

export function useTeamSelection() {
  const ctx = useContext(TeamSelectionContext);
  if (!ctx) {
    throw new Error("useTeamSelection must be used within TeamSelectionProvider");
  }
  return ctx;
}
