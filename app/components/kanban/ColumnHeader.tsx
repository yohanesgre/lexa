import { cn } from "../ui/cn";

interface ColumnHeaderProps {
  name: string;
  color: string;
  taskCount: number;
  wipLimit: number | null;
  wipFlash?: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ColumnHeader({ name, color, taskCount, wipLimit, wipFlash = false }: ColumnHeaderProps) {
  const wipState =
    wipLimit === null
      ? null
      : wipFlash || taskCount >= wipLimit
        ? "exceeded"
        : taskCount >= wipLimit * 0.8
          ? "approaching"
          : "ok";

  return (
    <>
      <div className="column-strip" style={{ background: color || "transparent" }} />
      <div className={cn("column-header", taskCount > 0 && "has-cards")}>
        <div className="flex items-center">
          <span className="column-name">{name}</span>
          <span className="column-count">{pad(taskCount)}</span>
        </div>
        {wipLimit !== null && wipState !== null && (
          <span className={cn("wip-badge", `wip-${wipState}`, wipFlash && "wip-flash")}>
            {pad(taskCount)}/{pad(wipLimit)}
          </span>
        )}
      </div>
    </>
  );
}
