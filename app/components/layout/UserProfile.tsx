import { useEffect, useRef, useState } from "react";
import { ChevronIcon } from "./ChevronIcon";

// Placeholder identity — production identity arrives via the
// Cf-Access-Authenticated-User-Email header (server/api/auth.ts).
const USER = { name: "Yohanes", email: "yohanesgre@gmail.com", role: "admin" as const };

export function UserProfile() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const initial = USER.name[0].toUpperCase();

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8, height: 28,
          padding: "0 8px 0 6px", background: "transparent",
          border: "1px solid var(--lx-border-default)", borderRadius: 6,
          color: "var(--lx-text-primary)", cursor: "pointer",
        }}
      >
        <div className="avatar" style={{ width: 20, height: 20, fontSize: 10 }}>{initial}</div>
        <span className="text-sm font-medium" style={{ lineHeight: 1 }}>{USER.name}</span>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 180, zIndex: 40 }}>
          <div className="dropdown-label">Account</div>
          <div className="dropdown-item" style={{ gap: 8 }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Profile
          </div>
          <div className="dropdown-separator" />
          <button type="button" className="dropdown-item" style={{ color: "var(--lx-text-danger)", gap: 8, width: "100%", textAlign: "left", border: "none", background: "none", font: "inherit", padding: "8px 12px", cursor: "pointer" }} onClick={() => { setOpen(false); }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

