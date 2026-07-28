import type { Project } from "../../shared/types";

export function stubTaskCount(slug: string): number {
  let sum = 0;
  for (let i = 0; i < slug.length; i++) sum += slug.charCodeAt(i);
  return (sum % 140) + 1;
}

export type ProjectHealth = {
  project: Project;
  taskCount: number;
  columnCount: number;
  urgentCount: number;
  syncCount: number;
  health: "ok" | "approaching" | "exceeded";
  wipSegments: Array<{ state: "ok" | "approaching" | "exceeded" | "empty"; flex: number }>;
};

export type AttentionTask = {
  id: string;
  title: string;
  projectName: string;
  projectSlug: string;
  columnName: string;
  taskNumber: string;
};

export type AttentionSync = {
  id: string;
  title: string;
  projectName: string;
  projectSlug: string;
  repo: string;
  issueNumber: number;
  taskNumber: string;
};

function seed(slug: string, offset: number): number {
  return (stubTaskCount(slug) + offset * 997) % 1000;
}

export function stubColumnCount(slug: string): number {
  return 4 + (seed(slug, 1) % 4);
}

export function stubUrgentCount(slug: string): number {
  const n = seed(slug, 2) % 12;
  return n < 3 ? n : 0;
}

export function stubSyncCount(slug: string): number {
  const n = seed(slug, 3) % 10;
  return n < 2 ? n + 1 : 0;
}

export function stubProjectHealth(projects: Project[]): ProjectHealth[] {
  return projects.map((project) => {
    const taskCount = stubTaskCount(project.slug);
    const columnCount = stubColumnCount(project.slug);
    const urgentCount = stubUrgentCount(project.slug);
    const syncCount = stubSyncCount(project.slug);

    const segments: ProjectHealth["wipSegments"] = [];
    const base = 1 + (seed(project.slug, 4) % 3);
    for (let i = 0; i < columnCount; i++) {
      const roll = seed(project.slug, 5 + i) % 10;
      const state: ProjectHealth["wipSegments"][number]["state"] =
        roll < 1 ? "empty" : roll < 3 ? "approaching" : roll < 5 && urgentCount > 0 ? "exceeded" : "ok";
      segments.push({ state, flex: base + (seed(project.slug, 10 + i) % 3) * 0.5 });
    }

    const hasExceeded = segments.some((s) => s.state === "exceeded");
    const health: ProjectHealth["health"] = hasExceeded ? "exceeded" : urgentCount > 0 ? "approaching" : "ok";

    return { project, taskCount, columnCount, urgentCount, syncCount, health, wipSegments: segments };
  });
}

export function stubAttentionTasks(projects: Project[]): AttentionTask[] {
  const tasks: AttentionTask[] = [];
  const titles = [
    "Fix hitbox desync during dodge roll",
    "Rebalance fire sword damage curve",
    "Crash on sector 7 boss transition",
    "Write final encounter dialogue",
    "AI pathfinding fails on destructible tiles",
    "Memory leak in particle system",
    "Boss arena trigger zones",
    "Animate lava shader",
  ];
  const columns = ["Backlog", "Todo", "In Progress", "Review", "Writing"];
  for (const project of projects) {
    const urgentCount = stubUrgentCount(project.slug);
    for (let i = 0; i < urgentCount; i++) {
      const idx = seed(project.slug, 20 + i) % titles.length;
      tasks.push({
        id: `${project.slug}-urgent-${i}`,
        title: titles[idx],
        projectName: project.name,
        projectSlug: project.slug,
        columnName: columns[seed(project.slug, 30 + i) % columns.length],
        taskNumber: `#${project.slug.slice(0, 2).toUpperCase()}-${String(seed(project.slug, 40 + i) % 100).padStart(3, "0")}`,
      });
    }
  }
  return tasks;
}

export function stubAttentionSyncs(projects: Project[]): AttentionSync[] {
  const syncs: AttentionSync[] = [];
  const titles = ["Title differs from Lexa task", "State mismatch: closed in GitHub"];
  for (const project of projects) {
    if (!project.githubRepo) continue;
    const syncCount = stubSyncCount(project.slug);
    for (let i = 0; i < syncCount; i++) {
      syncs.push({
        id: `${project.slug}-sync-${i}`,
        title: titles[i % titles.length],
        projectName: project.name,
        projectSlug: project.slug,
        repo: project.githubRepo,
        issueNumber: 140 + seed(project.slug, 50 + i) % 40,
        taskNumber: `#${project.slug.slice(0, 2).toUpperCase()}-${String(seed(project.slug, 60 + i) % 100).padStart(3, "0")}`,
      });
    }
  }
  return syncs;
}
