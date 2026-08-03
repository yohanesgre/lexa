// Copy text to the clipboard. navigator.clipboard only exists in secure
// contexts (https / localhost) — over LAN HTTP (the home-server case) it is
// undefined, so fall back to a hidden textarea + execCommand("copy").
// Returns true on success (or when the fallback ran); false if neither path
// worked.
export function copyToClipboard(text: string): Promise<boolean> {
  const fallback = (): boolean => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallback()
    );
  }
  return Promise.resolve(fallback());
}
