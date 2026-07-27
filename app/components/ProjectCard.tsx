import { Link } from "@tanstack/react-router";
import { cn } from "./ui/cn";

interface ProjectCardProps {
  name: string;
  slug: string;
  description: string;
  className?: string;
}

export function ProjectCard({ name, slug, description, className }: ProjectCardProps) {
  return (
    <Link to="/$slug" params={{ slug }} className={cn("project-card", className)}>
      <h2 className="project-card-name">{name}</h2>
      <p className="project-card-desc">{description}</p>
      <span className="project-card-stats">/{slug}</span>
    </Link>
  );
}
