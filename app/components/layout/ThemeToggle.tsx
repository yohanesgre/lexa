import { Moon, Sun } from "lucide-react";
import { useTheme } from "../../lib/theme";

export function ThemeToggle() {
  const { theme, toggleTheme, mounted } = useTheme();
  const isLight = mounted && theme === "light";
  if (!mounted) {
    return (
      <button
        type="button"
        className="nav-pill"
        aria-label="Theme"
        aria-pressed="false"
        title="Light theme"
        suppressHydrationWarning
        onClick={toggleTheme}
        style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }}
      >
        <Moon size={14} strokeWidth={1.5} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="nav-pill"
      aria-label="Theme"
      aria-pressed={isLight}
      title={isLight ? "Dark theme" : "Light theme"}
      suppressHydrationWarning
      onClick={toggleTheme}
      style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }}
    >
      {isLight ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
    </button>
  );
}
