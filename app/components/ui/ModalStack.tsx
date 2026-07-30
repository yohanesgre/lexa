import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";

interface ModalStackState {
  open: () => number;
  close: () => void;
}

const ModalStackContext = createContext<ModalStackState>({
  open: () => 0,
  close: () => {},
});

export function useModalStack() {
  const ctx = useContext(ModalStackContext);
  const [z, setZ] = React.useState({ overlayZ: 70, dialogZ: 71 });

  React.useEffect(() => {
    const depth = ctx.open();
    setZ({ overlayZ: 70 + depth * 10, dialogZ: 71 + depth * 10 });
    return () => ctx.close();
  }, [ctx]);

  return z;
}

export function ModalStackProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);

  const open = useCallback(() => {
    setCount((c) => c + 1);
    return count + 1;
  }, [count]);

  const close = useCallback(() => {
    setCount((c) => Math.max(0, c - 1));
  }, []);

  const value = useMemo(() => ({ depth: count, open, close }), [count, open, close]);

  return React.createElement(ModalStackContext.Provider, { value }, children);
}

export function ModalPortal({ children, overlayZ, dialogZ }: { children: React.ReactNode; overlayZ: number; dialogZ: number }) {
  return createPortal(
    <>
      <div className="dialog-overlay" style={{ zIndex: overlayZ }} />
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: dialogZ }}>
        {children}
      </div>
    </>,
    document.body,
  );
}
