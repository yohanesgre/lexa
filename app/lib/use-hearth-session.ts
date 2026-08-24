import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";
import type { HearthSession } from "../../shared/types";
import { parseApiDate } from "./date";
import { useToast } from "../components/ui/Toast";

// Relative age for the "Continuing session from <age>" line — updated_at of
// the mapped session (SQLite UTC datetimes via parseApiDate).
export function formatSessionAge(iso: string, now: Date = new Date()): string {
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60000) return "just now";
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
  return `${Math.floor(diffMs / 86400000)}d ago`;
}

// Session mappings for one document across runtimes: which opencode serve
// conversation the next Hearth run continues. Refetched on popover open so a
// background run that minted a session shows up.
export function useHearthSession(documentType: "task" | "wiki", documentId: string, enabled = true) {
  return useQuery({
    queryKey: ["hearth-sessions", documentType, documentId],
    queryFn: () => api.listHearthSessions(documentType, documentId).then((r) => r.data),
    enabled,
  });
}

// Drops the mapping for (document, runtime); the reset returns 204, so the
// session list is mutated directly — never invalidated on the mutation path.
export function useResetHearthSession() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.resetHearthSession,
    onSuccess: (_res, vars) => {
      qc.setQueryData<HearthSession[]>(["hearth-sessions", vars.documentType, vars.documentId], []);
    },
    onError: (err) => {
      toast.push("error", "Could not reset session", toastMessage(err));
    },
  });
}

function toastMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return e.message || "Something went wrong";
}
