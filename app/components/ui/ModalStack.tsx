import React from "react";
import { createPortal } from "react-dom";

export function ModalPortal({ children, overlayZ, dialogZ }: { children: React.ReactNode; overlayZ: number; dialogZ: number }) {
  const portalTarget = typeof document !== "undefined" ? document.body : null;
  if (!portalTarget) return null;
  return createPortal(
    <>
      <div className="dialog-overlay" style={{ zIndex: overlayZ }} />
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: dialogZ }}>
        {children}
      </div>
    </>,
    portalTarget,
  );
}
