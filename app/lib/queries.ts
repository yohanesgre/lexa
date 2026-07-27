import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task } from "../../shared/types";
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

export function useColumns(slug: string) {
  return useQuery({ queryKey: ["columns", slug], queryFn: () => api.listColumns(slug).then((r) => r.data) });
}

export function useCreateColumn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createColumn>[1]) => api.createColumn(slug, input),
    onSuccess: (column) => {
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, columns: [...old.columns, column] };
      });
    },
  });
}

export function useDeleteColumn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteColumn(slug, id),
    onSuccess: (_data, id) => {
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, columns: old.columns.filter((c: { id: string }) => c.id !== id) };
      });
    },
  });
}

export function useSwimlanes(slug: string) {
  return useQuery({ queryKey: ["swimlanes", slug], queryFn: () => api.listSwimlanes(slug).then((r) => r.data) });
}

export function useCreateSwimlane(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createSwimlane>[1]) => api.createSwimlane(slug, input),
    onSuccess: (swimlane) => {
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, swimlanes: [...old.swimlanes, swimlane] };
      });
    },
  });
}

export function useDeleteSwimlane(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSwimlane(slug, id),
    onSuccess: (_data, id) => {
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, swimlanes: old.swimlanes.filter((s: { id: string }) => s.id !== id) };
      });
    },
  });
}

export function useTasks(slug: string, params?: { columnId?: string; swimlaneId?: string; assignee?: string; type?: string; limit?: number; cursor?: string }) {
  return useQuery({ queryKey: ["tasks", slug, params], queryFn: () => api.listTasks(slug, params) });
}

export function useTask(slug: string, id: string) {
  return useQuery({ queryKey: ["tasks", slug, id], queryFn: () => api.getTask(slug, id) });
}

export function useCreateTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { columnId: string; swimlaneId?: string | null; title: string; description?: string; priority?: string; type?: string; assignee?: string | null }) =>
      api.createTask(slug, input),
    onSuccess: (task) => {
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, tasks: [...old.tasks, task] };
      });
    },
  });
}

export function useUpdateTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; title?: string; description?: string; priority?: string; type?: string; assignee?: string | null }) =>
      api.updateTask(slug, id, input),
    onSuccess: (task) => {
      qc.setQueryData(["tasks", slug, task.id], task);
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
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
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
    },
  });
}

export function useDeleteTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(slug, id),
    onSuccess: (_data, id) => {
      qc.setQueryData(["board", slug], (old: any) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.filter((t: { id: string }) => t.id !== id) };
      });
    },
  });
}
