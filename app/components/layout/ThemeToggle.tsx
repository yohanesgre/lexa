import { Moon, Sun } from "lucide-react";
import { useTheme } from "../../lib/theme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === "light";
  return (
    <button
      type="button"
      className="nav-pill"
      aria-label={isLight ? "Switch to dark theme" : "Switch to light theme"}
      title={isLight ? "Dark theme" : "Light theme"}
      onClick={toggleTheme}
      style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }}
    >
      {isLight ? <Moon size={14} strokeWidth={1.5} /> : <Sun size={14} strokeWidth={1.5} />}
    </button>
  );
}
