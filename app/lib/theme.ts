import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "lexa:theme";

// Hydration flag without state: false on the server snapshot, true on the
// client after the first paint — no effect-driven setState initialization.
const subscribeNoop = () => () => {};
const getMounted = () => true;
const getMountedServer = () => false;

export function useTheme(): { theme: Theme; toggleTheme: () => void; mounted: boolean } {
  const [theme, setTheme] = useState<Theme>("dark");
  const mounted = useSyncExternalStore(subscribeNoop, getMounted, getMountedServer);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") setTheme(stored);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  return { theme, toggleTheme, mounted };
}
