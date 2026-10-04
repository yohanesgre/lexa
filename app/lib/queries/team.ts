import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import { useToast } from "../../components/ui/Toast";
import type { Team } from "../../../shared/types";

function toastMessage(err: unknown): string {
  const e = err as { message?: string | undefined };
  return e.message || "Something went wrong";
}

// Renames a team. The PATCH response is authoritative — seed the ["teams"]
// list from it (invariant #6), never invalidate on the mutation path.
export function useUpdateTeam() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ teamId, name }: { teamId: string; name: string }) => api.updateTeam(teamId, { name }),
    onSuccess: (team) => {
      qc.setQueryData<Team[]>(["teams"], (old) => (old ?? []).map((t) => (t.id === team.id ? team : t)));
      toast.push("success", "Team updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update team", toastMessage(err));
    },
  });
}
