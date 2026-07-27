import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useProjects, useCreateProject } from "../lib/queries";
import { ProjectCard } from "../components/ProjectCard";
import { cn } from "../components/ui/cn";

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
    await createProject.mutateAsync({ name: name.trim() });
    setName("");
  };

  if (isLoading) return <div className="dashboard-loading">Loading projects…</div>;

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <h1 className="dashboard-title">Projects</h1>
        <form onSubmit={handleCreate} className="dashboard-create">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
            className="dashboard-input"
            disabled={createProject.isPending}
          />
          <button type="submit" disabled={createProject.isPending} className="dashboard-btn">
            Create
          </button>
        </form>
      </header>

      {projects && projects.length > 0 ? (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} name={p.name} slug={p.slug} description={p.description} />
          ))}
        </div>
      ) : (
        <div className="dashboard-empty">No projects yet. Create one above.</div>
      )}

      {createProject.error && (
        <div className="dashboard-error">{(createProject.error as Error).message}</div>
      )}
    </main>
  );
}
