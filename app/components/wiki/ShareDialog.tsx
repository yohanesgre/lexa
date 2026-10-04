import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Link as LinkIcon, Plus, Share2, X } from "lucide-react";
import { DatePicker } from "../ui/DatePicker";
import { useCreateWikiShareLink, useRevokeWikiShareLink, useWikiShareLinks } from "../../lib/queries";
import type { WikiShareLink } from "../../lib/api";
import { parseApiDate } from "../../lib/date";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";

interface ShareDialogProps {
  slug: string;
  pageSlug: string;
  isOpen: boolean;
  onClose: () => void;
}

const EXPIRY_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function formatDate(iso: string): string {
  return EXPIRY_FMT.format(parseApiDate(iso));
}

export function ShareDialog({ slug, pageSlug, isOpen, onClose }: ShareDialogProps) {
  const links = useWikiShareLinks(slug, pageSlug);
  const displayLinks = useMemo(
    () =>
      (links.data ?? []).map((l) => ({
        ...l,
        created: formatDate(l.createdAt),
        expires: l.expiresAt !== null ? formatDate(l.expiresAt) : null,
      })),
    [links.data],
  );
  const createLink = useCreateWikiShareLink(slug, pageSlug);
  const revokeLink = useRevokeWikiShareLink(slug, pageSlug);

  const [expiry, setExpiry] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // The DatePicker inside the dialog portals its calendar to document.body, so
  // the trap must be told to treat that popover as part of the cycle.
  const getPortaledPopover = useCallback(
    () => [document.querySelector<HTMLElement>(".datepicker-popover")],
    []
  );
  // Focus contract: initial focus inside, Tab trapped while open (including the
  // portaled DatePicker popover), focus returned to the Share trigger on close.
  useOverlayFocusTrap(isOpen, dialogRef, undefined, getPortaledPopover);
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // While the portaled DatePicker popover is open it owns Escape;
        // closing the dialog here would dismiss both layers at once.
        if (document.querySelector(".datepicker-popover")) return;
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const copyUrl = async (link: WikiShareLink) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedId(link.id);
      window.setTimeout(() => setCopiedId((current) => (current === link.id ? null : current)), 2000);
    } catch {
      setError("Copy failed — select the URL manually");
    }
  };

  const handleCreate = async () => {
    if (createLink.isPending) return;
    setError(null);
    try {
      // DatePicker emits YYYY-MM-DD (or null = never); the API contract
      // requires a full ISO-8601 UTC instant — end-of-day UTC matches
      // "expires on that date" intent.
      const wireExpiry = expiry === null ? undefined : new Date(`${expiry}T23:59:59.999Z`).toISOString();
      const { link } = await createLink.mutateAsync(wireExpiry);
      setExpiry("");
      // Auto-copy is best-effort — a clipboard rejection must not surface as
      // an API failure.
      try {
        await navigator.clipboard.writeText(link.url);
        setCopiedId(link.id);
        window.setTimeout(() => setCopiedId((current) => (current === link.id ? null : current)), 2000);
      } catch {
        /* link created; user can copy manually */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create link");
    }
  };

  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <dialog
          ref={dialogRef}
          open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="share-page-title"
        >
          <div className="p-4 flex items-center justify-between">
            <h2 id="share-page-title" className="font-display text-lg font-semibold text-lx-text-primary">
              Share page
            </h2>
            <button type="button" className="btn btn-ghost w-8 h-8 p-0" onClick={onClose} aria-label="Close">
              <X size={18} strokeWidth={1.5} />
            </button>
          </div>

          <div className="p-4 pt-0">
            {error && (
              <div className="text-sm text-lx-text-danger mb-3 bg-lx-bg-danger-subtle rounded-md px-3 py-2">{error}</div>
            )}

          <span className="field-label block mb-1.5">Links</span>

            {(displayLinks).map((link) => (
              <div key={link.id} className="github-issue-row" title={link.url}>
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2">
                    <LinkIcon size={12} strokeWidth={1.5} className="text-lx-text-muted shrink-0" />
                    <span className="font-mono text-xs text-lx-text-primary truncate">{link.url.replace(/^https?:\/\//, "")}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-lx-text-secondary">Created {link.created}</span>
                    {link.expires ? (
                      <span className="card-due" style={{ height: 18, padding: "0 6px", fontSize: 10 }}>
                        Expires {link.expires}
                      </span>
                    ) : (
                      <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Never expires</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1" style={{ flexShrink: 0 }}>
                  {copiedId === link.id ? (
                    <button type="button" className="btn btn-sm" style={{ background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", borderColor: "transparent" }}>
                      <Check size={12} strokeWidth={2} />
                      Copied
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyUrl(link)}>
                      <Copy size={12} strokeWidth={1.5} />
                      Copy
                    </button>
                  )}
                  <button type="button" className="btn btn-danger btn-sm" disabled={revokeLink.isPending} onClick={() => revokeLink.mutate(link.id)}>
                    Revoke
                  </button>
                </div>
              </div>
            ))}

            <div style={{ borderTop: "1px solid var(--lx-border-subtle)", marginTop: 16, paddingTop: 16 }}>
              <label htmlFor="share-expiry-input" className="field-label block mb-1.5">
                Create link
              </label>
              <div className="flex items-center gap-2">
                <div style={{ width: 170 }}>
                  <DatePicker value={expiry} onChange={setExpiry} placeholder="No expiry" />
                </div>
                <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={createLink.isPending} onClick={() => void handleCreate()}>
                  <Plus size={14} strokeWidth={1.5} />
                  Create link
                </button>
              </div>
              <div className="field-hint mt-1">Expiry is optional — leave empty and the link never expires.</div>
            </div>
          </div>
        </dialog>
      </div>
    </>
  );
}
