import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task, Board, Column, Swimlane, TipTapDoc, WikiPageMeta, ApiKey, ApiKeyCreateResult, Dashboard } from "../../shared/types";
import * as api from "./api";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects().then((r) => r.data) });
}

export function useDashboard() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard() });
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

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.deleteProject(slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, ...input }: { slug: string; name?: string; description?: string; githubRepo?: string | null }) => api.updateProject(slug, input),
    onSuccess: (project) => {
      qc.setQueryData<Project[]>(["projects"], (old) => {
        if (!old) return [project];
        return old.map((p) => (p.id === project.id ? project : p));
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
    mutationFn: ({ id, ...input }: { id: string; title?: string; description?: TipTapDoc; priority?: string; type?: string; assignees?: string[] }) =>
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
    mutationFn: ({ id, ...target }: { id: string; columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string }) =>
      api.moveTask(slug, id, target),
    onSuccess: (task) => {
      qc.setQueryData(["board", slug], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
    },
  });
}

export function useDeleteTask(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.deleteTask(slug, id),
    onSuccess: (_, { id }) => {
      qc.setQueryData(["board", slug], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.filter((t: Task) => t.id !== id) };
      });
      qc.removeQueries({ queryKey: ["tasks", slug, id] });
    },
  });
}

export function useWikiPages(slug: string) {
  return useQuery({ queryKey: ["wiki", slug], queryFn: () => api.listWikiPages(slug).then((r) => r.data) });
}

export function useWikiPage(slug: string, pageSlug: string) {
  return useQuery({ queryKey: ["wikiPage", slug, pageSlug], queryFn: () => api.getWikiPage(slug, pageSlug) });
}

export function useSearchWikiPages(slug: string, query: string) {
  return useQuery({
    queryKey: ["wikiSearch", slug, query],
    queryFn: () => api.searchWikiPages(slug, query).then((r) => r.data),
    enabled: query.length > 0,
  });
}

export function useCreateWikiPage(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createWikiPage>[1]) => api.createWikiPage(slug, input),
    onSuccess: (page) => {
      qc.setQueryData<WikiPageMeta[]>(["wiki", slug], (old) => {
        if (!old) return [page];
        return [...old, page];
      });
      qc.setQueryData(["wikiPage", slug, page.slug], page);
    },
  });
}

export function useUpdateWikiPage(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageSlug, ...input }: { pageSlug: string } & Parameters<typeof api.updateWikiPage>[2]) =>
      api.updateWikiPage(slug, pageSlug, input),
    onSuccess: (page) => {
      qc.setQueryData<WikiPageMeta[]>(["wiki", slug], (old) => {
        if (!old) return old;
        return old.map((p) => (p.id === page.id ? page : p));
      });
      qc.setQueryData(["wikiPage", slug, page.slug], page);
    },
  });
}

export function useRevisions(slug: string, pageSlug: string, limit?: number) {
  return useQuery({
    queryKey: ["wikiRevisions", slug, pageSlug, limit],
    queryFn: () => api.listRevisions(slug, pageSlug, limit).then((r) => r.revisions),
  });
}

export function useDeleteWikiPage(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pageSlug: string) => api.deleteWikiPage(slug, pageSlug),
    onSuccess: (_data, pageSlug) => {
      qc.setQueryData<WikiPageMeta[]>(["wiki", slug], (old) => {
        if (!old) return old;
        return old.filter((p) => p.slug !== pageSlug);
      });
      qc.removeQueries({ queryKey: ["wikiPage", slug, pageSlug] });
    },
  });
}

export function useColumns(slug: string) {
  return useQuery({ queryKey: ["projects", slug, "columns"], queryFn: () => api.listColumns(slug).then((r) => r.data) });
}

export function useCreateColumn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createColumn>[1]) => api.createColumn(slug, input),
    onSuccess: (column) => {
      qc.setQueryData(["projects", slug, "columns"], (old: Column[] | undefined) => {
        if (!old) return old;
        return [...old, column];
      });
    },
  });
}

export function useUpdateColumn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof api.updateColumn>[2]) =>
      api.updateColumn(slug, id, input),
    onSuccess: (column) => {
      qc.setQueryData(["projects", slug, "columns"], (old: Column[] | undefined) => {
        if (!old) return old;
        return old.map((c) => (c.id === column.id ? column : c));
      });
    },
  });
}

export function useDeleteColumn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.deleteColumn(slug, id),
    onSuccess: (_, { id }) => {
      qc.setQueryData(["projects", slug, "columns"], (old: Column[] | undefined) => {
        if (!old) return old;
        return old.filter((c) => c.id !== id);
      });
    },
  });
}

export function useSwimlanes(slug: string) {
  return useQuery({ queryKey: ["projects", slug, "swimlanes"], queryFn: () => api.listSwimlanes(slug).then((r) => r.data) });
}

export function useCreateSwimlane(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createSwimlane>[1]) => api.createSwimlane(slug, input),
    onSuccess: (swimlane) => {
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => {
        if (!old) return old;
        return [...old, swimlane];
      });
    },
  });
}

export function useUpdateSwimlane(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof api.updateSwimlane>[2]) =>
      api.updateSwimlane(slug, id, input),
    onSuccess: (swimlane) => {
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => {
        if (!old) return old;
        return old.map((s) => (s.id === swimlane.id ? swimlane : s));
      });
    },
  });
}

export function useDeleteSwimlane(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.deleteSwimlane(slug, id),
    onSuccess: (_, { id }) => {
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => {
        if (!old) return old;
        return old.filter((s) => s.id !== id);
      });
    },
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.listApiKeys().then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createApiKey(name),
    onSuccess: (result) => {
      qc.setQueryData<ApiKey[]>(["api-keys"], (old) => {
        if (!old) return [result.key];
        return [result.key, ...old];
      });
    },
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: (_, id) => {
      qc.setQueryData<ApiKey[]>(["api-keys"], (old) => {
        if (!old) return old;
        return old.filter((k) => k.id !== id);
      });
    },
  });
}

// ---- users & project members ----

export function useProject(slug: string) {
  return useQuery({ queryKey: ["project", slug], queryFn: () => api.getProject(slug) });
}

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => api.listUsers().then((r) => r.data) });
}

export function useUpdateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: "admin" | "member" }) => api.updateUserRole(id, role),
    onSuccess: (user) => {
      qc.setQueryData<{ id: string; email: string; name: string; role: string }[]>(["users"], (old) => {
        if (!old) return old;
        return old.map((u) => (u.id === user.id ? user : u));
      });
      qc.invalidateQueries({ queryKey: ["project-members"] });
    },
  });
}

export function useProjectMembers(slug: string) {
  return useQuery({ queryKey: ["project-members", slug], queryFn: () => api.listProjectMembers(slug).then((r) => r.data) });
}

export function useAddProjectMember(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, projectId }: { userId: string; projectId: string }) => api.addProjectMember(userId, projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-members", slug] });
    },
  });
}

export function useRemoveProjectMember(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, projectId }: { userId: string; projectId: string }) => api.removeProjectMember(userId, projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-members", slug] });
    },
  });
}
