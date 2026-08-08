// Forge spark glyph — the agent marker used on agent event rows and agent
// comment cards (wireframe robot/agent treatment).
export function RobotGlyph({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden="true"
    >
      <path d="m15 12-8.373 8.373a2.121 2.121 0 1 1-3-3L12 9m7-4 .65-.65a2.121 2.121 0 1 1 3 3L19.003 11M15 5l2 2" />
      <path d="M6 18 2 22" />
    </svg>
  );
}
