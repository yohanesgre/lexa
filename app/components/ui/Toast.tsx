import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

export type ToastVariant = "success" | "warning" | "error";

interface ToastItem {
  id: number;
  variant: ToastVariant;
  title: string;
  body?: React.ReactNode;
}

interface ToastContextValue {
  push: (variant: ToastVariant, title: string, body?: React.ReactNode) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue>({
  push: () => {},
  dismiss: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

const AUTO_DISMISS: Record<ToastVariant, number | null> = {
  success: 5000,
  warning: 5000,
  error: null,
};

const MAX_VISIBLE = 3;

let nextId = 1;

function Icon({ variant }: { variant: ToastVariant }) {
  if (variant === "success") {
    return (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (variant === "warning") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 9v4" strokeLinecap="round" />
        <path d="M12 17h.01" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" strokeLinecap="round" />
      <path d="m9 9 6 6" strokeLinecap="round" />
    </svg>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, number>>(new Map());
  // Client-only render: SSR snapshot is false, client snapshot is true —
  // no effect, no hydration flicker.
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant: ToastVariant, title: string, body?: React.ReactNode) => {
      const id = nextId++;
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, variant, title, body }]);
      const timeout = AUTO_DISMISS[variant];
      if (timeout !== null) {
        timers.current.set(id, window.setTimeout(() => dismiss(id), timeout));
      }
    },
    [dismiss]
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
    },
    []
  );

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div className="toast-stack" role="status" aria-live="polite">
            {toasts.map((toast) => (
              <div key={toast.id} className={`toast toast-${toast.variant} toast-enter`}>
                <span className="toast-icon">
                  <Icon variant={toast.variant} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="toast-title">{toast.title}</div>
                  {toast.body !== undefined && <div className="toast-body">{toast.body}</div>}
                </div>
                <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
                  <svg viewBox="0 0 24 24">
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}
