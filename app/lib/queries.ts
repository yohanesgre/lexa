import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task, Board, TipTapDoc } from "../../shared/types";
import * as api from "./api";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects().then((r) => r.data) });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createProject,
    onSuccess: (project) => {
      qc.setQueryData(["projects"], (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return [project, ...old];
      });
    },
  });
}

export function useBoard(slug: string) {
  return useQuery({ queryKey: ["board", slug], queryFn: () => api.getBoard(slug) });
}

export function useUpdateTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; title?: string; description?: TipTapDoc; priority?: string; type?: string; assignee?: string | null }) =>
      api.updateTask(slug, id, input),
    onSuccess: (task) => {
      qc.setQueryData(["tasks", slug, task.id], task);
      qc.setQueryData(["board", slug], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
    },
  });
}

export function useCreateTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createTask>[1]) => api.createTask(slug, input),
    onSuccess: (task) => {
      qc.setQueryData(["board", slug], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: [...old.tasks, task] };
      });
    },
  });
}

export function useMoveTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...target }: { id: string; columnId: string; swimlaneId?: string | null; beforeTaskId?: string; afterTaskId?: string }) =>
      api.moveTask(slug, id, target),
    onSuccess: (task) => {
      qc.setQueryData(["board", slug], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
    },
  });
}
