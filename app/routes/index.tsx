import { createFileRoute } from "@tanstack/react-router";
import { Plus, TrendingUp } from "lucide-react";
import { useState } from "react";
import { useProjects, useCreateProject } from "../lib/queries";
import { ProjectCard } from "../components/ProjectCard";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const { data: projects, isLoading } = useProjects();
  const createProject = useCreateProject();
  const [name, setName] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await createProject.mutateAsync({ name: name.trim() });
    } catch {
      // error shown via createProject.error
    }
    setName("");
  };

  if (isLoading) return <div className="page-frame"><div className="dashboard-loading">Loading projects…</div></div>;

  const activeProjects = projects?.length ?? 0;
  const githubLinked = projects?.filter((p) => p.githubRepo).length ?? 0;

  return (
    <main className="page-frame">
      <header className="flex items-center justify-between mb-4">
        <h1 className="font-display text-2xl font-semibold text-lx-text-primary">Projects</h1>
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-ghost">
            <TrendingUp size={14} strokeWidth={1.5} />
            API Keys
          </button>
          <form onSubmit={handleCreate} className="flex items-center gap-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project name"
              className="prop-input"
              disabled={createProject.isPending}
            />
            <button type="submit" disabled={createProject.isPending || !name.trim()} className="btn btn-primary">
              <Plus size={14} strokeWidth={1.5} />
              New Project
            </button>
          </form>
        </div>
      </header>

      {projects && projects.length > 0 ? (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : (
        <div className="dashboard-empty">No projects yet. Create one above.</div>
      )}

      <div className="mt-4 flex gap-4 flex-wrap">
        <SummaryCard label="Active Projects" value={activeProjects} />
        <SummaryCard label="GitHub Linked" value={githubLinked} />
      </div>

      {createProject.error && (
        <div className="dashboard-error">{(createProject.error as Error).message}</div>
      )}
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-lx-surface-card border border-lx-border rounded-lg p-4 min-w-[200px]">
      <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em] mb-1">{label}</div>
      <div className="font-display text-2xl font-semibold text-lx-text-primary">{String(value).padStart(3, "0")}</div>
    </div>
  );
}
