import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import type { Task, Project, ProjectRepo, Board, Column, Swimlane, Milestone, TipTapDoc, WikiPageMeta, ApiKey, ApiKeyCreateResult, Dashboard, FieldConfig, DocumentSource, HearthTask, TaskLink, Runtime, LexaAgent, LexaSkill, Machine, ActivityItem, ActivityEvent, Team, TeamMember, TeamMemberRole, SessionInfo, WorkspaceInvite, Attachment } from "../../shared/types";
import type { HeraldSettingsMasked, HeraldSettingsInput } from "../../shared/herald";
import type { HeraldMemoryEntry } from "./api";
import * as api from "./api";
import * as auth from "./auth";
import type { TaskMutationResult, ActivityPage, WikiShareLink } from "./api";
import type { RecentHearthTask, HearthHistoryPage } from "./api";
import { useToast } from "../components/ui/Toast";

function toastMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return e.message || "Something went wrong";
}

export function useProjects(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects().then((r) => r.data),
    enabled: opts?.enabled ?? true,
  });
}

export function useDashboard() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard() });
}

export function useCreateProject() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.createProject,
    onSuccess: (project) => {
      qc.setQueryData(["projects"], (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return [project, ...old];
      });
      toast.push("success", "Project created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create project", toastMessage(err));
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (slug: string) => api.deleteProject(slug),
    onSuccess: (_v, slug) => {
      qc.setQueryData<Project[]>(["projects"], (old) => (old ?? []).filter((p) => p.slug !== slug));
      qc.removeQueries({ queryKey: ["board", slug] });
      qc.removeQueries({ queryKey: ["projects", slug] });
      qc.removeQueries({ queryKey: ["project", slug] });
      qc.removeQueries({ queryKey: ["field-config", slug] });
      qc.removeQueries({ queryKey: ["project-members", slug] });
      qc.removeQueries({ queryKey: ["wiki", slug] });
      qc.removeQueries({ queryKey: ["wikiPage", slug] });
      qc.removeQueries({ queryKey: ["tasks", slug] });
      qc.removeQueries({ queryKey: ["task-links", slug] });
      qc.removeQueries({ queryKey: ["task-search", slug] });
      qc.removeQueries({ queryKey: ["sources", slug] });
      qc.removeQueries({ queryKey: ["hearth-recent", slug] });
      toast.push("success", "Project deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete project", toastMessage(err));
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ slug, ...input }: { slug: string; name?: string; description?: string }) => api.updateProject(slug, input),
    onSuccess: (project) => {
      qc.setQueryData<Project[]>(["projects"], (old) => {
        if (!old) return [project];
        return old.map((p) => (p.id === project.id ? project : p));
      });
      qc.setQueryData<Dashboard>(["dashboard"], (old) => {
        if (!old) return old;
        return { ...old, projects: old.projects.map((h) => (h.project.id === project.id ? { ...h, project } : h)) };
      });
      for (const archived of [false, true]) {
        qc.setQueryData<Board>(["board", project.slug, archived], (old) => (old ? { ...old, project } : old));
      }
      toast.push("success", "Project updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update project", toastMessage(err));
    },
  });
}

export function useBoard(slug: string, includeArchived = false) {
  return useQuery({ queryKey: ["board", slug, includeArchived], queryFn: () => api.getBoard(slug, includeArchived) });
}

// ── GitHub repo linking ──

export function useProjectRepos(slug: string) {
  return useQuery({
    queryKey: ["project-repos", slug],
    queryFn: () => api.listProjectRepos(slug).then((r) => r.data),
    enabled: !!slug,
  });
}

export function useReplaceProjectRepos() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ slug, repos }: { slug: string; repos: ProjectRepo[] }) => api.replaceProjectRepos(slug, repos),
    onSuccess: (res, { slug }) => {
      qc.setQueryData<ProjectRepo[]>(["project-repos", slug], res.data);
      toast.push("success", "Linked repos updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update linked repos", toastMessage(err));
    },
  });
}

export function useGithubRepoSearch(q: string) {
  return useQuery({
    queryKey: ["github-repo-search", q],
    queryFn: () => api.searchGithubRepos(q).then((r) => r.data),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
  });
}

export function useGithubIssueSearch(slug: string, repo: string, q: string) {
  return useQuery({
    queryKey: ["github-issues", slug, repo, q],
    queryFn: () => api.listGithubIssues(slug, repo, q || undefined).then((r) => r.data),
    enabled: !!slug && !!repo,
    staleTime: 30_000,
  });
}

// Link an EXISTING GitHub issue to the task (autocomplete flow). The board
// cache is updated from the mutation response (setQueryData — no invalidate).
export function useLinkExistingIssue(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ taskId, repo, issueNumber }: { taskId: string; repo: string; issueNumber: number }) =>
      api.linkExistingIssue(slug, taskId, repo, issueNumber),
    onSuccess: ({ data: task, activity }) => {
      for (const archived of [false, true]) {
        qc.setQueryData<Board>(["board", slug, archived], (old) => {
          if (!old) return old;
          return { ...old, tasks: old.tasks.map((t) => (t.id === task.id ? task : t)) };
        });
      }
      if (activity?.length) prependActivity(qc, slug, task.id, activity.map((a) => ({ kind: "event" as const, ...a })));
      toast.push("success", "Issue linked");
    },
    onError: (err) => {
      toast.push("error", "Failed to link issue", toastMessage(err));
    },
  });
}

export interface TaskListItem {
  id: string;
  key: string;
  title: string;
  priorityId: string;
  priorityLabel: string;
  priorityColor: string;
  typeId: string;
  typeLabel: string;
  typeColor: string;
  columnId: string;
  columnName: string;
  columnColor: string;
  swimlaneId: string;
  swimlaneName: string;
  assignees: string[];
  githubNumber: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Pure derivation of a flat display-ready task list — shares the board query
// cache (same key as useBoard) so board and list never double-fetch.
export function deriveTaskList(board: Board): TaskListItem[] {
  const columnName = new Map(board.columns.map((c) => [c.id, c.name]));
  const columnColor = new Map(board.columns.map((c) => [c.id, c.color]));
  const swimlaneName = new Map(board.swimlanes.map((s) => [s.id, s.name]));
  const priority = new Map(board.fieldConfig.priorities.map((o) => [o.id, o]));
  const type = new Map(board.fieldConfig.types.map((o) => [o.id, o]));
  return board.tasks.map((t) => {
    const p = priority.get(t.priority);
    const ty = type.get(t.type);
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      priorityId: t.priority,
      priorityLabel: p?.label ?? t.priority,
      priorityColor: p?.color ?? "",
      typeId: t.type,
      typeLabel: ty?.label ?? t.type,
      typeColor: ty?.color ?? "",
      columnId: t.columnId,
      columnName: columnName.get(t.columnId) ?? "Unknown column",
      columnColor: columnColor.get(t.columnId) ?? "",
      swimlaneId: t.swimlaneId,
      swimlaneName: swimlaneName.get(t.swimlaneId) ?? "Unknown swimlane",
      assignees: t.assignees,
      githubNumber: t.githubs[0]?.issueNumber ?? null,
      archivedAt: t.archivedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });
}

export function useTasks(slug: string, showArchived = false) {
  const query = useQuery({
    queryKey: ["board", slug, showArchived],
    queryFn: () => api.getBoard(slug, showArchived),
  });
  const board = query.data;
  const tasks = useMemo(() => (board ? deriveTaskList(board) : undefined), [board]);
  return { ...query, board, tasks };
}

export function useTask(slug: string, taskId: string | null) {
  return useQuery({
    queryKey: ["tasks", slug, taskId],
    queryFn: () => api.getTask(slug, taskId as string),
    enabled: taskId !== null,
  });
}

export function useFieldConfig(slug: string) {
  return useQuery({ queryKey: ["field-config", slug], queryFn: () => api.getFieldConfig(slug) });
}

export function useUpdateFieldConfig(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.updateFieldConfig>[1]) => api.updateFieldConfig(slug, input),
    onSuccess: (config) => {
      qc.setQueryData<FieldConfig>(["field-config", slug], config);
      // Cards resolve labels/colors from the board's embedded fieldConfig.
      for (const archived of [false, true]) {
        qc.setQueryData<Board>(["board", slug, archived], (old) => (old ? { ...old, fieldConfig: config } : old));
      }
      toast.push("success", "Task fields updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update task fields", toastMessage(err));
    },
  });
}

export function useUpdateTask(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; title?: string; description?: TipTapDoc; priority?: string; type?: string; assignees?: string[]; dueAt?: string | null }) =>
      api.updateTask(slug, id, input),
    onSuccess: ({ data: task, activity }) => {
      qc.setQueryData(["tasks", slug, task.id], task);
      qc.setQueryData(["board", slug, false], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
      qc.setQueryData(["board", slug, true], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
      if (activity?.length) prependActivity(qc, slug, task.id, activity.map((a) => ({ kind: "event" as const, ...a })));
    },
    onError: (err) => {
      toast.push("error", "Failed to save", toastMessage(err));
    },
  });
}

export function useCreateTask(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createTask>[1]) => api.createTask(slug, input),
    onSuccess: ({ data: task, activity }) => {
      qc.setQueryData(["board", slug, false], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: [...old.tasks, task] };
      });
      qc.setQueryData(["board", slug, true], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: [...old.tasks, task] };
      });
      if (activity?.length) prependActivity(qc, slug, task.id, activity.map((a) => ({ kind: "event" as const, ...a })));
      toast.push("success", "Task created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create task", toastMessage(err));
    },
  });
}

export function useMoveTask(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, ...target }: { id: string; columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string; clearDueAt?: boolean }) =>
      api.moveTask(slug, id, target),
    onSuccess: ({ data: task, activity }) => {
      // Keep both board caches in sync with the authoritative move response.
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
        });
      }
      qc.setQueryData(["tasks", slug, task.id], task);
      if (activity?.length) prependActivity(qc, slug, task.id, activity.map((a) => ({ kind: "event" as const, ...a })));
      toast.push("success", "Task moved");
    },
    onError: (err) => {
      if ((err as { code?: string }).code === "WIP_LIMIT") return;
      toast.push("error", "Move failed", toastMessage(err));
    },
  });
}

export function useDeleteTask(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.deleteTask(slug, id),
    onSuccess: (_, { id }) => {
      qc.setQueryData(["board", slug, false], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.filter((t: Task) => t.id !== id) };
      });
      qc.setQueryData(["board", slug, true], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.filter((t: Task) => t.id !== id) };
      });
      qc.removeQueries({ queryKey: ["tasks", slug, id] });
      qc.removeQueries({ queryKey: ["task-activity", slug, id] });
      toast.push("success", "Task deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete task", toastMessage(err));
    },
  });
}

const byPosition = (a: Task, b: Task) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

export function useArchiveTask(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.archiveTask(slug, id),
    onSuccess: ({ data: task, activity }) => {
      // Live board: remove the card. Archived board: update in place.
      qc.setQueryData(["board", slug, false], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.filter((t: Task) => t.id !== task.id) };
      });
      qc.setQueryData(["board", slug, true], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
      qc.setQueryData(["tasks", slug, task.id], task);
      if (activity?.length) prependActivity(qc, slug, task.id, activity.map((a) => ({ kind: "event" as const, ...a })));
      toast.push("success", "Task archived");
    },
    onError: (err) => {
      toast.push("error", "Failed to archive task", toastMessage(err));
    },
  });
}

export function useRestoreTask(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.restoreTask(slug, id),
    onSuccess: ({ data: task, activity }) => {
      // Archived board: update in place. Live board: re-insert at its column/position.
      qc.setQueryData(["board", slug, true], (old: Board | undefined) => {
        if (!old) return old;
        return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
      });
      qc.setQueryData(["board", slug, false], (old: Board | undefined) => {
        if (!old) return old;
        if (old.tasks.some((t: Task) => t.id === task.id)) {
          return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
        }
        return { ...old, tasks: [...old.tasks, task].sort(byPosition) };
      });
      qc.setQueryData(["tasks", slug, task.id], task);
      if (activity?.length) prependActivity(qc, slug, task.id, activity.map((a) => ({ kind: "event" as const, ...a })));
      toast.push("success", "Task restored");
    },
    onError: (err) => {
      toast.push("error", "Failed to restore task", toastMessage(err));
    },
  });
}

function useGithubLinkMutation(slug: string, apiFn: (slug: string, id: string, key: string) => Promise<TaskMutationResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, key }: { id: string; key: string }) => apiFn(slug, id, key),
    onSuccess: ({ data: task, activity }) => {
      // Mutation responses are authoritative — update both board caches in place.
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, tasks: old.tasks.map((t: Task) => (t.id === task.id ? task : t)) };
        });
      }
      qc.setQueryData(["tasks", slug, task.id], task);
      if (activity?.length) prependActivity(qc, slug, task.id, activity.map((a) => ({ kind: "event" as const, ...a })));
    },
  });
}

export function useLinkGithubIssue(slug: string) {
  const toast = useToast();
  const mutation = useGithubLinkMutation(slug, api.linkGithubIssue);
  return {
    ...mutation,
    mutateAsync: async (input: { id: string; repo: string }): Promise<TaskMutationResult> => {
      try {
        return await mutation.mutateAsync({ id: input.id, key: input.repo });
      } catch (err) {
        toast.push("error", "Failed to link GitHub issue", toastMessage(err));
        throw err;
      }
    },
  };
}

export function useUnlinkGithubIssue(slug: string) {
  const toast = useToast();
  const mutation = useGithubLinkMutation(slug, api.unlinkGithubIssue);
  return {
    ...mutation,
    mutateAsync: async (input: { id: string; issueId: string }): Promise<TaskMutationResult> => {
      try {
        return await mutation.mutateAsync({ id: input.id, key: input.issueId });
      } catch (err) {
        toast.push("error", "Failed to unlink GitHub issue", toastMessage(err));
        throw err;
      }
    },
  };
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
  const toast = useToast();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createWikiPage>[1]) => api.createWikiPage(slug, input),
    onSuccess: (page) => {
      qc.setQueryData<WikiPageMeta[]>(["wiki", slug], (old) => {
        if (!old) return [page];
        return [...old, page];
      });
      qc.setQueryData(["wikiPage", slug, page.slug], page);
      toast.push("success", "Page created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create page", toastMessage(err));
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

export function useRestoreWikiRevision(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pageSlug, revisionId }: { pageSlug: string; revisionId: string }) =>
      api.restoreWikiRevision(slug, pageSlug, revisionId),
    onSuccess: (page, variables) => {
      qc.setQueryData<WikiPageMeta[]>(["wiki", slug], (old) => {
        if (!old) return old;
        return old.map((p) => (p.id === page.id ? page : p));
      });
      qc.setQueryData(["wikiPage", slug, variables.pageSlug], page);
      qc.setQueryData(["wikiPage", slug, page.slug], page);
      void qc.fetchQuery({
        queryKey: ["wikiRevisions", slug, variables.pageSlug, 20],
        queryFn: () => api.listRevisions(slug, variables.pageSlug, 20).then((r) => r.revisions),
      });
    },
  });
}

export function useDeleteWikiPage(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (pageSlug: string) => api.deleteWikiPage(slug, pageSlug),
    onSuccess: (_data, pageSlug) => {
      qc.setQueryData<WikiPageMeta[]>(["wiki", slug], (old) => {
        if (!old) return old;
        return old.filter((p) => p.slug !== pageSlug);
      });
      qc.removeQueries({ queryKey: ["wikiPage", slug, pageSlug] });
      toast.push("success", "Page deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete page", toastMessage(err));
    },
  });
}

export function useWikiShareLinks(slug: string, pageSlug: string) {
  return useQuery({
    queryKey: ["wikiShareLinks", slug, pageSlug],
    queryFn: () => api.listWikiShareLinks(slug, pageSlug).then((r) => r.data),
  });
}

export function useCreateWikiShareLink(slug: string, pageSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (expiresAt?: string) => api.createWikiShareLink(slug, pageSlug, expiresAt),
    onSuccess: ({ link }) => {
      qc.setQueryData<WikiShareLink[]>(["wikiShareLinks", slug, pageSlug], (old) => {
        if (!old) return [link];
        return [...old, link];
      });
    },
  });
}

export function useRevokeWikiShareLink(slug: string, pageSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.revokeWikiShareLink(slug, linkId),
    onSuccess: (_data, linkId) => {
      qc.setQueryData<WikiShareLink[]>(["wikiShareLinks", slug, pageSlug], (old) => {
        if (!old) return old;
        return old.filter((l) => l.id !== linkId);
      });
    },
  });
}

export function useColumns(slug: string) {
  return useQuery({ queryKey: ["projects", slug, "columns"], queryFn: () => api.listColumns(slug).then((r) => r.data) });
}

export function useCreateColumn(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createColumn>[1]) => api.createColumn(slug, input),
    onSuccess: (column) => {
      qc.setQueryData(["projects", slug, "columns"], (old: Column[] | undefined) => {
        if (!old) return old;
        return [...old, column];
      });
      // Column headers render on the board — keep both board caches in sync,
      // or a first-column create leaves the board stuck on "No columns yet".
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, columns: [...old.columns, column] };
        });
      }
      toast.push("success", "Column created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create column", toastMessage(err));
    },
  });
}

export function useUpdateColumn(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof api.updateColumn>[2]) =>
      api.updateColumn(slug, id, input),
    onSuccess: (column) => {
      qc.setQueryData(["projects", slug, "columns"], (old: Column[] | undefined) => {
        if (!old) return old;
        return old.map((c) => (c.id === column.id ? column : c));
      });
      // Column headers render on the board — refresh the board caches too,
      // or a rename shows the stale name until refetch.
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, columns: old.columns.map((c: Column) => (c.id === column.id ? column : c)) };
        });
      }
      toast.push("success", "Column updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update column", toastMessage(err));
    },
  });
}

export function useDeleteColumn(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.deleteColumn(slug, id),
    onSuccess: (_, { id }) => {
      qc.setQueryData(["projects", slug, "columns"], (old: Column[] | undefined) => {
        if (!old) return old;
        return old.filter((c) => c.id !== id);
      });
      toast.push("success", "Column deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete column", toastMessage(err));
    },
  });
}

export function useSwimlanes(slug: string) {
  return useQuery({ queryKey: ["projects", slug, "swimlanes"], queryFn: () => api.listSwimlanes(slug).then((r) => r.data) });
}

export function useCreateSwimlane(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createSwimlane>[1]) => api.createSwimlane(slug, input),
    onSuccess: (swimlane) => {
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => {
        if (!old) return old;
        return [...old, swimlane];
      });
      // Lane headers render on the board — keep both board caches in sync.
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, swimlanes: [...old.swimlanes, swimlane] };
        });
      }
      toast.push("success", "Swimlane created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create swimlane", toastMessage(err));
    },
  });
}

export function useUpdateSwimlane(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof api.updateSwimlane>[2]) =>
      api.updateSwimlane(slug, id, input),
    onSuccess: (swimlane) => {
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => {
        if (!old) return old;
        return old.map((s) => (s.id === swimlane.id ? swimlane : s));
      });
      // The lane header renders the due chip — refresh the board caches too,
      // or the board shows a stale deadline until refetch.
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, swimlanes: old.swimlanes.map((l: Swimlane) => (l.id === swimlane.id ? swimlane : l)) };
        });
      }
      toast.push("success", "Swimlane updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update swimlane", toastMessage(err));
    },
  });
}

export function useArchiveSwimlane(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.archiveSwimlane(slug, id),
    onSuccess: ({ data: lane, activity }) => {
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return {
            ...old,
            swimlanes: old.swimlanes.map((l: Swimlane) => (l.id === lane.id ? lane : l)),
            tasks: old.tasks.map((t: Task) =>
              activity.some((a) => a.taskId === t.id && a.type === "archived") ? { ...t, archivedAt: lane.archivedAt } : t
            ),
          };
        });
      }
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => old?.map((l) => (l.id === lane.id ? lane : l)));
      toast.push("success", activity.length > 0 ? `Swimlane archived (${activity.length} tasks)` : "Swimlane archived");
    },
    onError: (err) => {
      toast.push("error", "Failed to archive swimlane", toastMessage(err));
    },
  });
}

export function useRestoreSwimlane(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.restoreSwimlane(slug, id),
    onSuccess: ({ data: lane }) => {
      // Restore brings the lane back only — tasks stay archived.
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return { ...old, swimlanes: old.swimlanes.map((l: Swimlane) => (l.id === lane.id ? lane : l)) };
        });
      }
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => old?.map((l) => (l.id === lane.id ? lane : l)));
      toast.push("success", "Swimlane restored");
    },
    onError: (err) => {
      toast.push("error", "Failed to restore swimlane", toastMessage(err));
    },
  });
}

export function useDeleteSwimlane(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.deleteSwimlane(slug, id),
    onSuccess: (_, { id }) => {
      qc.setQueryData(["projects", slug, "swimlanes"], (old: Swimlane[] | undefined) => {
        if (!old) return old;
        return old.filter((s) => s.id !== id);
      });
      toast.push("success", "Swimlane deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete swimlane", toastMessage(err));
    },
  });
}

// ── Milestones ──

export function useMilestones(slug: string) {
  return useQuery({
    queryKey: ["milestones", slug],
    queryFn: () => api.listMilestones(slug).then((r) => r.data),
    enabled: !!slug,
  });
}

export function useCreateMilestone(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createMilestone>[1]) => api.createMilestone(slug, input),
    onSuccess: (milestone) => {
      qc.setQueryData(["milestones", slug], (old: Milestone[] | undefined) => {
        if (!old) return old;
        return [...old, milestone].sort((a, b) => a.position - b.position);
      });
      toast.push("success", "Milestone created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create milestone", toastMessage(err));
    },
  });
}

export function useUpdateMilestone(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof api.updateMilestone>[2]) =>
      api.updateMilestone(slug, id, input),
    onSuccess: (milestone) => {
      qc.setQueryData(["milestones", slug], (old: Milestone[] | undefined) => {
        if (!old) return old;
        return old.map((m) => (m.id === milestone.id ? milestone : m));
      });
      toast.push("success", "Milestone updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update milestone", toastMessage(err));
    },
  });
}

export function useDeleteMilestone(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.deleteMilestone(slug, id),
    onSuccess: (_, { id }) => {
      qc.setQueryData(["milestones", slug], (old: Milestone[] | undefined) => {
        if (!old) return old;
        return old.filter((m) => m.id !== id);
      });
      toast.push("success", "Milestone deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete milestone", toastMessage(err));
    },
  });
}

export function useArchiveMilestone(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.archiveMilestone(slug, id),
    onSuccess: ({ data: milestone, activity }) => {
      // Cascade archive touches lanes + tasks — the board cache carries all
      // of them, so mirror the mutation response there too.
      qc.setQueryData(["milestones", slug], (old: Milestone[] | undefined) => {
        if (!old) return old;
        return old.map((m) => (m.id === milestone.id ? milestone : m));
      });
      for (const archived of [false, true]) {
        qc.setQueryData(["board", slug, archived], (old: Board | undefined) => {
          if (!old) return old;
          return {
            ...old,
            swimlanes: old.swimlanes.map((l: Swimlane) =>
              l.milestoneId === milestone.id ? { ...l, archivedAt: milestone.archivedAt } : l
            ),
            tasks: old.tasks.map((t: Task) =>
              activity.some((a) => a.taskId === t.id && a.type === "archived")
                ? { ...t, archivedAt: milestone.archivedAt }
                : t
            ),
          };
        });
      }
      toast.push("success", "Milestone completed");
    },
    onError: (err) => {
      toast.push("error", "Failed to complete milestone", toastMessage(err));
    },
  });
}

export function useRestoreMilestone(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.restoreMilestone(slug, id),
    onSuccess: ({ data: milestone }) => {
      // Milestone only — its sprints stay archived (restore individually).
      qc.setQueryData(["milestones", slug], (old: Milestone[] | undefined) => {
        if (!old) return old;
        return old.map((m) => (m.id === milestone.id ? milestone : m));
      });
      toast.push("success", "Milestone restored");
    },
    onError: (err) => {
      toast.push("error", "Failed to restore milestone", toastMessage(err));
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
  const toast = useToast();
  return useMutation({
    mutationFn: (name: string) => api.createApiKey(name),
    onSuccess: (result) => {
      qc.setQueryData<ApiKey[]>(["api-keys"], (old) => {
        if (!old) return [result.key];
        return [result.key, ...old];
      });
      toast.push("success", "API key created", "Copy it now, it won't be shown again.");
    },
    onError: (err) => {
      toast.push("error", "Failed to create API key", toastMessage(err));
    },
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: (_, id) => {
      qc.setQueryData<ApiKey[]>(["api-keys"], (old) => {
        if (!old) return old;
        return old.filter((k) => k.id !== id);
      });
      toast.push("success", "API key revoked");
    },
    onError: (err) => {
      toast.push("error", "Failed to revoke API key", toastMessage(err));
    },
  });
}

// ── Rate limiting (app scope — admin only) ──

export function useRateLimit() {
  return useQuery({
    queryKey: ["rate-limit"],
    queryFn: () => api.getRateLimit(),
    staleTime: 60_000,
  });
}

export function useUpdateRateLimit() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { max: number; windowMs: number }) => api.updateRateLimit(input),
    onSuccess: (settings) => {
      // Mutation response is authoritative — update the cache from it, never refetch.
      qc.setQueryData(["rate-limit"], settings);
      toast.push("success", "Rate limit updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update rate limit", toastMessage(err));
    },
  });
}

// ── GitHub sync settings (app scope — admin only) ──

export function useGithubSettings() {
  return useQuery({
    queryKey: ["github-settings"],
    queryFn: () => api.getGithubSettings(),
    staleTime: 60_000,
  });
}

export function useUpdateGithubSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { appId: string; privateKey?: string; webhookSecret?: string }) => api.updateGithubSettings(input),
    onSuccess: (settings) => {
      // Mutation response is authoritative — update the cache from it, never refetch.
      qc.setQueryData(["github-settings"], settings);
      toast.push("success", "GitHub sync settings saved");
    },
    onError: (err) => {
      toast.push("error", "Failed to save GitHub sync settings", toastMessage(err));
    },
  });
}

// Remove GitHub sync — same PUT, all three fields as empty strings; the
// server's clear semantics (empty string = delete the settings row).
export function useClearGithubSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.updateGithubSettings({ appId: "", privateKey: "", webhookSecret: "" }),
    onSuccess: (settings) => {
      // Mutation response is authoritative — update the cache from it, never refetch.
      qc.setQueryData(["github-settings"], settings);
      toast.push("success", "GitHub sync removed");
    },
    onError: (err) => {
      toast.push("error", "Failed to remove GitHub sync", toastMessage(err));
    },
  });
}

// ---- session (Better Auth) ----

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => auth.getSession(),
    staleTime: 5 * 60_000,
  });
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => auth.signInEmail({ email, password }),
    onSuccess: (res) => {
      // Mutation response is authoritative — update the session cache from it.
      qc.setQueryData(["session"], res);
    },
    // No onError toast: the login page renders the single inline notice
    // (wireframe: generic "Invalid email or password." copy).
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => auth.signOut(),
    onSuccess: () => {
      qc.setQueryData(["session"], { session: null, user: null });
    },
    onError: (err) => {
      toast.push("error", "Sign out failed", toastMessage(err));
    },
  });
}

export function useSetPassword() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ newPassword, token }: { newPassword: string; token: string }) => auth.setPassword({ newPassword, token }),
    onSuccess: (res) => {
      qc.setQueryData(["session"], res);
      toast.push("success", "Password set — you're signed in");
    },
    onError: (err) => {
      toast.push("error", "Could not set password", toastMessage(err));
    },
  });
}

export function useChangePassword() {
  const toast = useToast();
  return useMutation({
    mutationFn: ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) => auth.changePassword({ currentPassword, newPassword }),
    onSuccess: () => {
      toast.push("success", "Password updated");
    },
    onError: (err) => {
      toast.push("error", "Could not change password", toastMessage(err));
    },
  });
}

// ---- teams ----

export function useTeams() {
  // retry:false — plain members typically get 403 (no teams to administer);
  // the UserMenu mounts on every page and must not retry + log noise.
  return useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams().then((r) => r.data), retry: false });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { name: string; slug?: string }) => api.createTeam(input),
    onSuccess: (team) => {
      qc.setQueryData<Team[]>(["teams"], (old) => (old ? [team, ...old] : [team]));
      toast.push("success", "Team created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create team", toastMessage(err));
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (teamId: string) => api.deleteTeam(teamId),
    onSuccess: (_v, teamId) => {
      qc.setQueryData<Team[]>(["teams"], (old) => (old ?? []).filter((t) => t.id !== teamId));
      toast.push("success", "Team deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete team", toastMessage(err));
    },
  });
}

export function useTeamMembers(teamId: string | undefined) {
  return useQuery({
    queryKey: ["team-members", teamId],
    queryFn: () => api.listTeamMembers(teamId!).then((r) => r.data),
    enabled: !!teamId,
  });
}

export function useAddTeamMember(teamId: string | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { email: string; role: TeamMemberRole }) => api.addTeamMember(teamId!, input),
    onSuccess: (member) => {
      qc.setQueryData<TeamMember[]>(["team-members", teamId], (old) => (old ? [...old, member] : [member]));
      toast.push("success", "Member added");
    },
    onError: (err) => {
      toast.push("error", "Failed to add member", toastMessage(err));
    },
  });
}

export function useUpdateTeamMemberRole(teamId: string | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TeamMemberRole }) => api.updateTeamMemberRole(teamId!, userId, role),
    onSuccess: (member) => {
      qc.setQueryData<TeamMember[]>(["team-members", teamId], (old) => (old ?? []).map((m) => (m.userId === member.userId ? member : m)));
      toast.push("success", "Role updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update role", toastMessage(err));
    },
  });
}

export function useRemoveTeamMember(teamId: string | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (userId: string) => api.removeTeamMember(teamId!, userId),
    onSuccess: (_v, userId) => {
      qc.setQueryData<TeamMember[]>(["team-members", teamId], (old) => (old ?? []).filter((m) => m.userId !== userId));
      toast.push("success", "Member removed");
    },
    onError: (err) => {
      toast.push("error", "Failed to remove member", toastMessage(err));
    },
  });
}

// ---- workspace members, invites, set-password links (superadmin) ----

export function useWorkspaceMembers() {
  return useQuery({ queryKey: ["workspace-members"], queryFn: () => api.listWorkspaceMembers().then((r) => r.data) });
}

export function useUpdateWorkspaceMember() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ userId, action }: { userId: string; action: "deactivate" | "reactivate" }) => api.updateWorkspaceMember(userId, action),
    onSuccess: (user) => {
      qc.setQueryData<api.WorkspaceMember[]>(["workspace-members"], (old) => (old ?? []).map((m) => (m.id === user.id ? { ...m, ...user } : m)));
      toast.push("success", "Member updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update member", toastMessage(err));
    },
  });
}

export function useDeleteWorkspaceMember() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (userId: string) => api.deleteWorkspaceMember(userId),
    onSuccess: (_v, userId) => {
      qc.setQueryData<api.WorkspaceMember[]>(["workspace-members"], (old) => (old ?? []).filter((m) => m.id !== userId));
      toast.push("success", "Member deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete member", toastMessage(err));
    },
  });
}

export function useWorkspaceInvites() {
  // retry:false — GET /api/workspace/invites is not in the contract surface;
  // when the server lacks it the table degrades to mutation-seeded rows.
  return useQuery({
    queryKey: ["workspace-invites"],
    queryFn: () => api.listWorkspaceInvites().then((r) => r.data),
    retry: false,
  });
}

export function useCreateWorkspaceInvite() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (email: string) => api.createWorkspaceInvite(email),
    onSuccess: (result, email) => {
      // No row in the response ({ link } only) — seed the cache with a
      // pending row built from the inputs; the server list replaces it.
      qc.setQueryData<WorkspaceInvite[]>(["workspace-invites"], (old) => {
        const row: WorkspaceInvite = {
          id: `pending-${Date.now()}`,
          email,
          tokenHint: "",
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          acceptedAt: null,
        };
        return old ? [row, ...old] : [row];
      });
      toast.push("success", "Invite created", result.link);
    },
    onError: (err) => {
      toast.push("error", "Failed to send invite", toastMessage(err));
    },
  });
}

export function useRevokeWorkspaceInvite() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (inviteId: string) => api.revokeWorkspaceInvite(inviteId),
    onSuccess: (_v, inviteId) => {
      qc.setQueryData<WorkspaceInvite[]>(["workspace-invites"], (old) => (old ?? []).filter((i) => i.id !== inviteId));
      toast.push("success", "Invite revoked");
    },
    onError: (err) => {
      toast.push("error", "Failed to revoke invite", toastMessage(err));
    },
  });
}

export function useCreateSetPasswordLink() {
  const toast = useToast();
  return useMutation({
    mutationFn: (userId: string) => api.createSetPasswordLink(userId),
    onSuccess: () => {
      toast.push("success", "Set-password link created");
    },
    onError: (err) => {
      toast.push("error", "Failed to create link", toastMessage(err));
    },
  });
}

// ---- sessions (own only) ----

export function useSessions() {
  return useQuery({ queryKey: ["sessions"], queryFn: () => api.listSessions().then((r) => r.data) });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (sessionId: string) => api.revokeSession(sessionId),
    onSuccess: (_v, sessionId) => {
      qc.setQueryData<SessionInfo[]>(["sessions"], (old) => (old ?? []).filter((s) => s.id !== sessionId));
      toast.push("success", "Session revoked");
    },
    onError: (err) => {
      toast.push("error", "Failed to revoke session", toastMessage(err));
    },
  });
}

// ---- project → team assignment ----

export function useUpdateProjectTeam() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ projectId, teamId }: { projectId: string; teamId: string | null }) => api.updateProjectTeam(projectId, teamId),
    onSuccess: (project, { teamId }) => {
      qc.setQueryData<Project[]>(["projects"], (old) => (old ?? []).map((p) => (p.id === project.id ? { ...p, teamId } : p)));
      qc.setQueryData<Project>(["project", project.slug], (old) => (old ? { ...old, teamId } : old));
      toast.push("success", "Project team updated");
    },
    onError: (err) => {
      toast.push("error", "Failed to update project team", toastMessage(err));
    },
  });
}

// ---- project members ----

type MemberUser = { id: string; email: string; name: string; role: string; createdAt: string; lastSeen: string | null };

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => api.listUsers().then((r) => r.data) });
}

export function useTeamRuntimes(teamId: string | undefined) {
  return useQuery({
    queryKey: ["hearth-runtimes", teamId],
    queryFn: () => api.listRuntimes(teamId).then((r) => r.data),
    enabled: !!teamId,
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data?.length ? 30_000 : false),
  });
}

export function useUpdateMyName() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (name: string) => api.updateMyName(name),
    onSuccess: (user) => {
      // Mutation response is authoritative — update the session user + any
      // project-members rows from it, never refetch.
      qc.setQueryData<{ session: unknown; user: unknown }>(["session"], (old) => {
        if (!old) return old;
        return { ...old, user };
      });
      qc.setQueriesData<MemberUser[]>({ queryKey: ["project-members"] }, (old) => old?.map((u) => (u.id === user.id ? user : u)));
      toast.push("success", "Profile saved");
    },
    onError: (err) => {
      toast.push("error", "Failed to save profile", toastMessage(err));
    },
  });
}

export function useProjectMembers(slug: string) {
  return useQuery({ queryKey: ["project-members", slug], queryFn: () => api.listProjectMembers(slug).then((r) => r.data) });
}

export function useAddProjectMember(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ userId, projectId }: { userId: string; projectId: string }) => api.addProjectMember(userId, projectId),
    onSuccess: (result, { userId }) => {
      // The members list stores full user records — build the entry from the
      // users cache (loaded on the same settings page) plus the response.
      const user = qc.getQueryData<MemberUser[]>(["users"])?.find((u) => u.id === userId);
      if (user) {
        qc.setQueryData<MemberUser[]>(["project-members", slug], (old) => (old ? [...old, { ...user, role: result.role }] : [{ ...user, role: result.role }]));
      }
      toast.push("success", "Member added");
    },
    onError: (err) => {
      toast.push("error", "Failed to add member", toastMessage(err));
    },
  });
}

export function useRemoveProjectMember(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ userId, projectId }: { userId: string; projectId: string }) => api.removeProjectMember(userId, projectId),
    onSuccess: (_v, { userId }) => {
      qc.setQueryData<MemberUser[]>(["project-members", slug], (old) => (old ?? []).filter((m) => m.id !== userId));
      toast.push("success", "Member removed");
    },
    onError: (err) => {
      toast.push("error", "Failed to remove member", toastMessage(err));
    },
  });
}

// ── Hearth (AI writing assistant) ──

export function useRuntimes() {
  // Hearth daemon runtimes (opencode/hermes machines). Polled so the
  // settings page shows online/offline status — but only while runtimes
  // exist; a fresh install has no machines and nothing can change.
  return useQuery({
    queryKey: ["hearth-runtimes"],
    queryFn: () => api.listRuntimes().then((r) => r.data),
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data?.length ? 30_000 : false),
  });
}

export function useMachines() {
  // Machine hosts (bound via lexa-cli login, listening via machine listen).
  return useQuery({
    queryKey: ["hearth-machines"],
    queryFn: () => api.listMachines().then((r) => r.data),
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data?.length ? 30_000 : false),
  });
}

export function useUpdateRuntime() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; provider?: "opencode" | "hermes" | "command-code"; agent?: string; model?: string; printLogs?: boolean; logLevel?: "" | "DEBUG" | "INFO" | "WARN" | "ERROR"; extraArgs?: string[] } }) => api.updateRuntime(id, patch),
    onSuccess: (runtime) => {
      qc.setQueryData<Runtime[]>(["hearth-runtimes"], (rows) => rows?.map((r) => (r.id === runtime.id ? runtime : r)));
      toast.push("success", "Runtime updated — applies on the next Hearth task");
    },
    onError: (err) => {
      toast.push("error", "Failed to update runtime", toastMessage(err));
    },
  });
}

export function useRemoveRuntime() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.removeRuntime(id),
    onSuccess: (_, id) => {
      qc.setQueryData<Runtime[]>(["hearth-runtimes"], (rows) => rows?.filter((r) => r.id !== id));
      toast.push("success", "Runtime removed");
    },
    onError: (err) => {
      toast.push("error", "Failed to remove runtime", toastMessage(err));
    },
  });
}

export function useRemoveMachine() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.removeMachine(id),
    onSuccess: (_, id) => {
      qc.setQueryData<Machine[]>(["hearth-machines"], (rows) => rows?.filter((m) => m.id !== id));
      // The machine's runtimes are removed server-side (cascade) — drop them
      // from the runtimes cache too so the table doesn't show stale rows.
      qc.setQueryData<Runtime[]>(["hearth-runtimes"], (rows) => rows?.filter((r) => r.machineId !== id));
      toast.push("success", "Machine removed");
    },
    onError: (err) => {
      toast.push("error", "Failed to remove machine", toastMessage(err));
    },
  });
}

// Recent Hearth tasks across all projects — powers the navbar status pill.
// Polls fast while a task runs, slow while idle, and not at all when no
// tasks exist or no Hearth runtime is online (prevents 15s spam + http log
// noise on installs without a blacksmith daemon).
export function useRecentHearthTasks() {
  const { data: runtimes } = useRuntimes();
  const hasRuntime = runtimes?.some((r) => r.status === "online");
  return useQuery({
    queryKey: ["hearth-recent-tasks"],
    queryFn: () => api.listRecentHearthTasks().then((r) => r.data),
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      const hasActive = rows.some((t) => t.status === "queued" || t.status === "running");
      if (hasActive) return 1500;
      if (!rows.length) return false;
      if (runtimes !== undefined && !hasRuntime) return false;
      return 15_000;
    },
  });
}

export function useCreateHearthTask() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.createHearthTask,
    onSuccess: (task) => {
      // Reflect the new task in the navbar pill immediately — the recent
      // list polls every 15s when idle, which feels like a missing status.
      const projects = qc.getQueryData<Project[]>(["projects"]);
      const project = projects?.find((p) => p.id === task.projectId);
      qc.setQueryData<RecentHearthTask[]>(["hearth-recent-tasks"], (rows) => [
        { ...task, projectName: project?.name ?? "" },
        ...(rows ?? []),
      ]);
    },
    onError: (err) => {
      toast.push("error", "Hearth unavailable", toastMessage(err));
    },
  });
}

// Cancel a queued/running Hearth task from the popover or the navbar panel.
// Updates the recent-tasks list and every cached history page from the
// authoritative mutation response (never invalidate on the mutation path).
export function useCancelHearthTask() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.cancelHearthTask(id),
    onSuccess: (task) => {
      qc.setQueryData<HearthTask[]>(["hearth-recent-tasks"], (rows) =>
        rows?.map((r) => (r.id === task.id ? { ...r, status: task.status } : r))
      );
      qc.setQueriesData<HearthHistoryPage>({ queryKey: ["hearth-task-history"] }, (page) =>
        page ? { ...page, data: page.data.map((r) => (r.id === task.id ? { ...r, status: task.status } : r)) } : page
      );
      toast.push("success", "Hearth task cancelled");
    },
    onError: (err) => {
      toast.push("error", "Failed to cancel Hearth task", toastMessage(err));
    },
  });
}

// Full Hearth task history for the control panel: filterable, cursor-paginated.
// Polls while any row on the current page is queued/running so active runs
// update in place; idle pages refresh on a slow heartbeat.
export function useHearthTaskHistory(
  filters: { slug?: string; status?: HearthTask["status"]; skillId?: string; documentType?: "task" | "wiki"; limit?: number },
  cursor: string | null
) {
  return useQuery({
    queryKey: ["hearth-task-history", filters, cursor],
    queryFn: () => api.listHearthTaskHistory({ ...filters, cursor: cursor ?? undefined }),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const hasActive = (query.state.data?.data ?? []).some((t) => t.status === "queued" || t.status === "running");
      return hasActive ? 1500 : 15_000;
    },
  });
}

// ── Lexa Agents & Skills (global rule bundles, shared by both tiers) ──

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listHearthAgents().then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listHearthSkills().then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useCreateHearthAgent() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.createHearthAgent,
    onSuccess: (agent) => {
      qc.setQueryData<LexaAgent[]>(["agents"], (rows) => [...(rows ?? []), agent]);
      toast.push("success", `Agent '${agent.name}' created`);
    },
    onError: (err) => {
      toast.push("error", "Failed to create agent", toastMessage(err));
    },
  });
}

export function useUpdateHearthAgent() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; description?: string; instructions?: string } }) => api.updateHearthAgent(id, patch),
    onSuccess: (agent) => {
      qc.setQueryData<LexaAgent[]>(["agents"], (rows) => rows?.map((r) => (r.id === agent.id ? agent : r)));
      toast.push("success", `Agent '${agent.name}' saved`);
    },
    onError: (err) => {
      toast.push("error", "Failed to save agent", toastMessage(err));
    },
  });
}

export function useDeleteHearthAgent() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteHearthAgent(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<LexaAgent[]>(["agents"], (rows) => rows?.filter((r) => r.id !== id));
      toast.push("success", "Agent deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete agent", toastMessage(err));
    },
  });
}

export function useReplaceAgentSkills() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, skillIds }: { id: string; skillIds: string[] }) => api.replaceAgentSkills(id, skillIds),
    onSuccess: (agent) => {
      qc.setQueryData<LexaAgent[]>(["agents"], (rows) => rows?.map((r) => (r.id === agent.id ? agent : r)));
      toast.push("success", `Skills updated for '${agent.name}'`);
    },
    onError: (err) => {
      toast.push("error", "Failed to update skills", toastMessage(err));
    },
  });
}

export function useResetHearthAgent() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.resetHearthAgent(id),
    onSuccess: (agent) => {
      qc.setQueryData<LexaAgent[]>(["agents"], (rows) => rows?.map((r) => (r.id === agent.id ? agent : r)));
      toast.push("success", `Agent '${agent.name}' reset to default`);
    },
    onError: (err) => {
      toast.push("error", "Failed to reset agent", toastMessage(err));
    },
  });
}

export function useCreateHearthSkill() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.createHearthSkill,
    onSuccess: (skill) => {
      qc.setQueryData<LexaSkill[]>(["skills"], (rows) => [...(rows ?? []), skill]);
      toast.push("success", `Skill '${skill.name}' created`);
    },
    onError: (err) => {
      toast.push("error", "Failed to create skill", toastMessage(err));
    },
  });
}

export function useUpdateHearthSkill() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; description?: string; instructions?: string } }) => api.updateHearthSkill(id, patch),
    onSuccess: (skill) => {
      qc.setQueryData<LexaSkill[]>(["skills"], (rows) => rows?.map((r) => (r.id === skill.id ? skill : r)));
      toast.push("success", `Skill '${skill.name}' saved`);
    },
    onError: (err) => {
      toast.push("error", "Failed to save skill", toastMessage(err));
    },
  });
}

export function useDeleteHearthSkill() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteHearthSkill(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<LexaSkill[]>(["skills"], (rows) => rows?.filter((r) => r.id !== id));
      toast.push("success", "Skill deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete skill", toastMessage(err));
    },
  });
}

export function useResetHearthSkill() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.resetHearthSkill(id),
    onSuccess: (skill) => {
      qc.setQueryData<LexaSkill[]>(["skills"], (rows) => rows?.map((r) => (r.id === skill.id ? skill : r)));
      toast.push("success", `Skill '${skill.name}' reset to default`);
    },
    onError: (err) => {
      toast.push("error", "Failed to reset skill", toastMessage(err));
    },
  });
}

export function useHearthTask(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["hearth-task", id],
    queryFn: () => api.getHearthTask(id!),
    enabled: enabled && id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });
}

// Live activity feed for a Hearth task. Polls fast while the task is active
// so the "what is it doing now" log stays current.
export function useHearthTaskLogs(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["hearth-task-logs", id],
    queryFn: () => api.listHearthTaskLogs(id!).then((r) => r.data),
    enabled: enabled && id !== null,
    refetchInterval: enabled ? 1500 : false,
  });
}

// Most recent Hearth task for a document — used to resume a run that finished
// after the popover was closed (background work keeps running server-side).
export function useRecentHearthTask(slug: string, documentType: "task" | "wiki", documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["hearth-recent", slug, documentType, documentId],
    queryFn: () => api.listHearthTasks(slug, documentType, documentId).then((r) => r.data[0] ?? null),
    enabled: enabled && !!documentId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });
}

export function useSources(slug: string, documentType: "task" | "wiki", documentId: string) {
  return useQuery({
    queryKey: ["sources", slug, documentType, documentId],
    queryFn: () => api.listSources(slug, documentType, documentId).then((r) => r.data),
    enabled: !!slug && !!documentId,
  });
}

export function useAddSource(slug: string, documentType: "task" | "wiki", documentId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { kind: "wiki" | "external"; ref: string }) => api.addSource(slug, documentType, documentId, input),
    onSuccess: ({ data: source, activity }) => {
      if (documentType === "task" && activity?.length) prependActivity(qc, slug, documentId, activity.map((a) => ({ kind: "event" as const, ...a })));
      qc.setQueryData<DocumentSource[]>(["sources", slug, documentType, documentId], (old) => [...(old ?? []), source]);
      toast.push("success", "Source added");
    },
    onError: (err) => {
      toast.push("error", "Failed to add source", toastMessage(err));
    },
  });
}

export function useRemoveSource(slug: string, documentType: "task" | "wiki", documentId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (sourceId: string) => api.removeSource(slug, documentType, documentId, sourceId),
    onSuccess: (_, sourceId) => {
      qc.setQueryData<DocumentSource[]>(["sources", slug, documentType, documentId], (old) => (old ?? []).filter((s) => s.id !== sourceId));
      toast.push("success", "Source removed");
    },
    onError: (err) => {
      toast.push("error", "Failed to remove source", toastMessage(err));
    },
  });
}

// ── Task links (subtask / blocked-by / related) ──

export function useTaskLinks(slug: string, taskId: string) {
  return useQuery({
    queryKey: ["task-links", slug, taskId],
    queryFn: () => api.listTaskLinks(slug, taskId).then((r) => r.data),
    enabled: !!slug && !!taskId,
  });
}

export function useAddTaskLink(slug: string, taskId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { toTaskId: string; relation: "subtask_of" | "blocked_by" | "related_to" }) => api.addTaskLink(slug, taskId, input),
    onSuccess: ({ data: link, activity }) => {
      if (activity?.length) prependActivity(qc, slug, taskId, activity.map((a) => ({ kind: "event" as const, ...a })));
      qc.setQueryData<TaskLink[]>(["task-links", slug, taskId], (old) => [...(old ?? []), link]);
      // Board link maps (subtasks/blocked-by) derive from board.links.
      for (const archived of [false, true]) {
        qc.setQueryData<Board>(["board", slug, archived], (old) => (old ? { ...old, links: [...old.links, link] } : old));
      }
      toast.push("success", "Task linked");
    },
    onError: (err) => {
      toast.push("error", "Failed to link task", toastMessage(err));
    },
  });
}

export function useRemoveTaskLink(slug: string, taskId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (linkId: string) => api.removeTaskLink(slug, taskId, linkId),
    onSuccess: (_v, linkId) => {
      qc.setQueryData<TaskLink[]>(["task-links", slug, taskId], (old) => (old ?? []).filter((l) => l.id !== linkId));
      for (const archived of [false, true]) {
        qc.setQueryData<Board>(["board", slug, archived], (old) => (old ? { ...old, links: old.links.filter((l) => l.id !== linkId) } : old));
      }
      toast.push("success", "Link removed");
    },
    onError: (err) => {
      toast.push("error", "Failed to remove link", toastMessage(err));
    },
  });
}

export function useTaskSearch(slug: string, query: string, exclude = "") {
  return useQuery({
    queryKey: ["task-search", slug, query, exclude],
    queryFn: () => api.searchTasks(slug, query, exclude).then((r) => r.data),
    enabled: query.trim().length >= 2,
    staleTime: 5_000,
  });
}

// ── Activity timeline + comments ──

// Timeline page 1 is prepended from mutation envelopes (invariant 6 — the
// mutation response is authoritative, never a refetch). A modest staleTime
// keeps the prepended rows visible; the next fetch replaces the cache with
// server truth (including rows emitted by other clients/agents).
export function useTaskActivity(slug: string, taskId: string) {
  return useInfiniteQuery({
    queryKey: ["task-activity", slug, taskId],
    queryFn: ({ pageParam }) => api.getTaskActivity(slug, taskId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    enabled: !!slug && !!taskId,
  });
}

// Append items to the END of page 1 of the timeline cache. Server pages are
// newest-chunk-first with ascending items; the timeline renders oldest →
// newest by reversing the page order, so new rows (newest) belong at the end
// of page 1 — that lands them at the bottom of the display, next to the
// composer (wireframe). No dedupe: server rows are append-only and a fresh
// fetch replaces the whole cache, so the same row can never appear twice
// (events and comments may share numeric ids across tables but prepends only
// ever add rows not yet in the cache).
export function prependActivity(qc: QueryClient, slug: string, taskId: string, items: ActivityItem[]) {
  qc.setQueryData<InfiniteData<ActivityPage>>(["task-activity", slug, taskId], (old) => {
    if (!old) return old;
    return { ...old, pages: old.pages.map((p, i) => (i === 0 ? { ...p, data: [...p.data, ...items] } : p)) };
  });
}

export function useAddComment(slug: string, taskId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: TipTapDoc) => api.createComment(slug, taskId, body),
    onSuccess: (result) => {
      prependActivity(qc, slug, taskId, [
        { kind: "comment", ...result.comment },
        { kind: "event", ...result.activity },
      ]);
    },
    onError: (err) => { toast.push("error", "Failed to add comment", toastMessage(err)); },
  });
}

export function useUpdateComment(slug: string, taskId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ commentId, body }: { commentId: number; body: TipTapDoc }) => api.updateComment(slug, taskId, commentId, body),
    onSuccess: (comment) => {
      qc.setQueryData<InfiniteData<ActivityPage>>(["task-activity", slug, taskId], (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            data: p.data.map((it) => (it.kind === "comment" && it.id === comment.id ? { kind: "comment", ...comment } : it)),
          })),
        };
      });
    },
    onError: (err) => { toast.push("error", "Failed to update comment", toastMessage(err)); },
  });
}

export function useDeleteComment(slug: string, taskId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: session } = useSession();
  const label = session?.user?.name ?? "user";
  return useMutation({
    mutationFn: (commentId: number) => api.deleteComment(slug, taskId, commentId),
    onSuccess: (_v, commentId) => {
      const now = new Date().toISOString();
      // DELETE returns 204 with no activity payload — remove the comment card
      // and prepend a LOCAL comment_deleted row (negative id, server row
      // replaces it on the next refetch).
      qc.setQueryData<InfiniteData<ActivityPage>>(["task-activity", slug, taskId], (old) => {
        if (!old) return old;
        const local: ActivityItem = {
          kind: "event", id: -Date.now(), taskId, type: "comment_deleted",
          actorKind: "user", actorLabel: label, actorUserId: null,
          message: `${label} deleted a comment`, viaHerald: false, createdAt: now,
        };
        return {
          ...old,
          pages: old.pages.map((p, i) => ({
            ...p,
            data: i === 0
              ? [...p.data.filter((it) => !(it.kind === "comment" && it.id === commentId)), local]
              : p.data.filter((it) => !(it.kind === "comment" && it.id === commentId)),
          })),
        };
      });
    },
    onError: (err) => { toast.push("error", "Failed to delete comment", toastMessage(err)); },
  });
}

// Selected project's health entry from the shared dashboard cache — powers
// the dashboard status view; the navbar switcher browses the same data.
export function selectProjectHealth(dashboard: Dashboard | undefined, slug: string | undefined): Dashboard["projects"][number] | undefined {
  if (!dashboard || !slug) return undefined;
  return dashboard.projects.find((p) => p.project.slug === slug);
}

// ── Attachments ──

// The list endpoint returns created_at ASC; the wireframe renders newest
// first, so the cache stores newest-first (one reverse at fetch) and upload
// mutations PREPEND — cache order and display order stay identical.
export function useTaskAttachments(slug: string, taskId: string) {
  return useQuery({
    queryKey: ["task-attachments", slug, taskId],
    queryFn: () => api.listTaskAttachments(slug, taskId).then((r) => [...r.data].reverse()),
    enabled: !!slug && !!taskId,
  });
}

export function useWikiAttachments(slug: string, pageSlug: string) {
  return useQuery({
    queryKey: ["wiki-attachments", slug, pageSlug],
    queryFn: () => api.listWikiAttachments(slug, pageSlug).then((r) => [...r.data].reverse()),
    enabled: !!slug && !!pageSlug,
  });
}

type UploadInput = {
  file: File;
  onProgress?: (percent: number) => void;
  onHandle?: (handle: { abort: () => void }) => void;
};

export function useUploadAttachment(slug: string, documentType: "task" | "wiki", documentId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ file, onProgress, onHandle }: UploadInput) => {
      const handle = api.uploadAttachmentWithProgress(
        slug,
        documentType === "task" ? { kind: "task", taskId: documentId } : { kind: "wiki", pageSlug: documentId },
        file,
        onProgress
      );
      onHandle?.(handle);
      return handle.promise;
    },
    onSuccess: (result) => {
      // Invariant 6 — the mutation response is authoritative. Dedupe hits
      // arrive as 201 with activity: [] and land identically (same row,
      // no second activity entry).
      qc.setQueryData<Attachment[]>([documentType === "task" ? "task-attachments" : "wiki-attachments", slug, documentId], (old) =>
        old ? [result.data, ...old] : [result.data]
      );
      if (documentType === "task" && result.activity?.length) {
        prependActivity(qc, slug, documentId, result.activity.map((a) => ({ kind: "event" as const, ...a })));
      }
    },
    onError: (err) => {
      if ((err as { code?: string }).code === "UPLOAD_CANCELLED") return;
      toast.push("error", "Upload failed", toastMessage(err));
    },
  });
}

export function useDeleteAttachment(slug: string, documentType: "task" | "wiki", documentId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteAttachment(id),
    onSuccess: (_, id) => {
      // 204 with no body — filter the authoritative list cache by id.
      qc.setQueryData<Attachment[]>([documentType === "task" ? "task-attachments" : "wiki-attachments", slug, documentId], (old) =>
        (old ?? []).filter((a) => a.id !== id)
      );
    },
    onError: (err) => {
      toast.push("error", "Failed to delete attachment", toastMessage(err));
    },
  });
}

// ── Herald (server-side assistant tier) ──

// Masked provider settings for a project. A missing row is the "not
// configured" state, not an error — surfaced as null so surfaces can swap
// in their empty state (PROVIDER_NOT_CONFIGURED).
// ── Herald chat history (multi-thread) ──

export function useHeraldChatList(projectId: string | undefined, q?: string) {
  const query = q && q.trim() ? q.trim() : undefined;
  return useQuery({
    queryKey: ["herald-chats", projectId, query ?? null],
    queryFn: () => api.listHeraldChats(projectId!, query).then((r) => r.data),
    enabled: !!projectId,
  });
}

function sortThreads(threads: api.HeraldChatThreadSummary[]): api.HeraldChatThreadSummary[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

// PATCH /herald/chat/:chatId ({title?, pinned?}). The response body is not
// part of the pinned contract, so the cache is patched from the request
// args (deterministic — the caller knows what it sent). A pin toggle also
// re-sorts locally (pinned-first then updatedAt DESC, the server's list
// ordering) so no refetch is needed.
export function useUpdateHeraldChatMeta(projectId: string | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ chatId, ...patch }: { chatId: string; title?: string; pinned?: boolean }) =>
      api.updateHeraldChatMeta(chatId, patch),
    onSuccess: (_result, { chatId, title, pinned }) => {
      qc.setQueriesData<api.HeraldChatThreadSummary[]>({ queryKey: ["herald-chats", projectId] }, (old) => {
        if (!old?.some((t) => t.chatId === chatId)) return old;
        return sortThreads(
          old.map((t) =>
            t.chatId === chatId
              ? { ...t, ...(title !== undefined ? { title } : {}), ...(pinned !== undefined ? { pinned } : {}) }
              : t
          )
        );
      });
    },
    onError: (err) => toast.push("error", "Update failed", toastMessage(err)),
  });
}

export function useRenameHeraldChat(projectId: string | undefined) {
  const meta = useUpdateHeraldChatMeta(projectId);
  const toast = useToast();
  return useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      meta.mutateAsync({ chatId, title }),
    onError: (err) => toast.push("error", "Rename failed", toastMessage(err)),
  });
}

export function useDeleteHeraldChat(projectId: string | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ chatId }: { chatId: string }) => api.resetHeraldChat(chatId),
    onSuccess: (_, { chatId }) => {
      // 204 — drop the row from every cached list variant and evict the
      // transcript entry (cache hygiene for a deleted entity, not a refetch).
      qc.setQueriesData<api.HeraldChatThreadSummary[]>({ queryKey: ["herald-chats", projectId] }, (old) =>
        (old ?? []).filter((t) => t.chatId !== chatId)
      );
      qc.removeQueries({ queryKey: ["herald-chat", chatId] });
    },
    onError: (err) => toast.push("error", "Delete failed", toastMessage(err)),
  });
}

export function useHeraldSettings(projectId: string | undefined) {  return useQuery({
    queryKey: ["herald-settings", projectId],
    queryFn: async () => {
      try {
        return await api.getHeraldSettings(projectId!);
      } catch (err) {
        if ((err as { code?: string }).code === "PROVIDER_NOT_CONFIGURED") return null;
        throw err;
      }
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

// PUT returns the fresh masked view — cache it directly (invariant 6).
export function useSaveHeraldSettings(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: HeraldSettingsInput) => api.putHeraldSettings(projectId, input),
    onSuccess: (masked) => {
      qc.setQueryData<HeraldSettingsMasked | null>(["herald-settings", projectId], masked);
      toast.push("success", "Herald provider saved");
    },
    onError: (err) => {
      toast.push("error", "Failed to save Herald provider", toastMessage(err));
    },
  });
}

// Write-tools gate (herald-write-approvals.html State 4): PUT rides on the
// stored masked provider fields; only writeTools changes. Response is the
// fresh masked view — cached directly (invariant 6).
export function useSaveHeraldWriteTools(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: HeraldSettingsInput) => api.putHeraldSettings(projectId, input),
    onSuccess: (masked) => {
      qc.setQueryData<HeraldSettingsMasked | null>(["herald-settings", projectId], masked);
      toast.push("success", "Herald write tools saved");
    },
    onError: (err) => {
      toast.push("error", "Failed to save Herald write tools", toastMessage(err));
    },
  });
}

// Test + models-list consume UNSAVED form values and persist nothing — no
// cache writes, results render inline.
export function useTestHeraldSettings(projectId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: (input: HeraldSettingsInput) => api.testHeraldSettings(projectId, input),
    onError: (err) => {
      if (!toastMessage(err).includes("PROVIDER_")) {
        toast.push("error", "Test connection failed", toastMessage(err));
      }
    },
  });
}

export function useFetchHeraldModels(projectId: string) {
  return useMutation({
    mutationFn: (input: HeraldSettingsInput) => api.listHeraldModels(projectId, input),
  });
}

export function useCreateHeraldTask() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.createHeraldTask,
    onSuccess: (task) => {
      const projects = qc.getQueryData<Project[]>(["projects"]);
      const project = projects?.find((p) => p.id === task.projectId);
      qc.setQueryData<RecentHearthTask[]>(["hearth-recent-tasks"], (rows) => [
        { ...task, projectName: project?.name ?? "" },
        ...(rows ?? []),
      ]);
    },
    onError: (err) => {
      toast.push("error", "Herald unavailable", toastMessage(err));
    },
  });
}

export function useCancelHeraldTask() {
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => api.cancelHeraldTask(id),
    onSuccess: () => {
      toast.push("success", "Herald run stopped");
    },
    onError: (err) => {
      toast.push("error", "Failed to stop Herald run", toastMessage(err));
    },
  });
}

export function useHeraldMemory(projectId: string | undefined) {
  return useQuery({
    queryKey: ["herald-memory", projectId],
    queryFn: () => api.listHeraldMemory(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });
}

export function useAddHeraldMemory(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (content: string) => api.addHeraldMemory(projectId, content),
    onSuccess: (entry) => {
      // Newest-first display order matches the wireframe rows.
      qc.setQueryData<HeraldMemoryEntry[]>(["herald-memory", projectId], (rows) => [entry, ...(rows ?? [])]);
      toast.push("success", "Memory added");
    },
    onError: (err) => {
      toast.push("error", "Failed to add memory", toastMessage(err));
    },
  });
}

export function useRemoveHeraldMemory(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (memoryId: string) => api.removeHeraldMemory(projectId, memoryId),
    onSuccess: (_, memoryId) => {
      qc.setQueryData<HeraldMemoryEntry[]>(["herald-memory", projectId], (rows) => (rows ?? []).filter((m) => m.id !== memoryId));
      toast.push("success", "Memory deleted");
    },
    onError: (err) => {
      toast.push("error", "Failed to delete memory", toastMessage(err));
    },
  });
}
