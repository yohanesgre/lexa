import { useEffect, useState } from "react";

// Keep a value back by `delayMs` so a query key built from it stops
// thrashing while the user types (chat history search box).
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
