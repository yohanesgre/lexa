import { cn } from "../ui/cn";
import type { HeadingOutline } from "../tiptap-render";

interface OutlineListProps {
  headings: HeadingOutline[];
  activeId: string;
  onSelect: (id: string) => void;
}

function levelClass(level: number): string | undefined {
  if (level >= 3) return "wiki-outline-row--l3";
  if (level === 2) return "wiki-outline-row--l2";
  return undefined;
}

export function OutlineList({ headings, activeId, onSelect }: OutlineListProps) {
  return (
    <>
      {headings.map((heading) => {
        const isActive = heading.id === activeId;
        return (
          <a
            key={heading.id}
            href={`#${heading.id}`}
            className={cn("wiki-outline-row", levelClass(heading.level), isActive && "is-active")}
            aria-current={isActive ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault();
              onSelect(heading.id);
            }}
          >
            <span className="wiki-outline-row-label">{heading.text}</span>
          </a>
        );
      })}
    </>
  );
}
