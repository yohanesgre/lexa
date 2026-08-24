// Pure selection of repo files worth shipping to a Hearth run as context.
// No I/O — the caller fetches the tree, this picks the files, the caller
// fetches contents. Unit-testable in isolation.

export interface RepoFileCandidate {
  path: string;
  size?: number; // from the git tree (may be absent)
}

export interface RepoContentOptions {
  maxFiles?: number;        // default 50
  maxBytesPerFile?: number; // default 256_000 — larger files are skipped without fetching
  maxTotalBytes?: number;   // default 512_000
}

export const REPO_CONTENT_DEFAULTS: Required<RepoContentOptions> = {
  maxFiles: 50,
  maxBytesPerFile: 256_000,
  maxTotalBytes: 512_000,
};

// Directory names that never contain interesting source (skipped at any depth).
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "vendor", ".next", "coverage", "target", ".venv",
]);

// Exact filenames skipped regardless of location.
const SKIP_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "composer.lock",
]);

// Filename suffixes skipped (minified/generated artifacts).
const SKIP_SUFFIXES = [".min.js", ".min.css", ".map"];

// True binaries — never useful as agent context. svg is TEXT and stays.
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "avif", "bmp",
  "pdf", "zip", "gz", "tar", "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "webm", "wasm", "exe", "dll", "so", "dylib",
  "class", "jar", "pyc", "db", "sqlite",
]);

export function selectRepoFiles(
  tree: Array<{ path: string; type: string; size?: number }>,
  opts: RepoContentOptions = {}
): RepoFileCandidate[] {
  const maxFiles = opts.maxFiles ?? REPO_CONTENT_DEFAULTS.maxFiles;
  const maxBytesPerFile = opts.maxBytesPerFile ?? REPO_CONTENT_DEFAULTS.maxBytesPerFile;
  const maxTotalBytes = opts.maxTotalBytes ?? REPO_CONTENT_DEFAULTS.maxTotalBytes;

  const selected: RepoFileCandidate[] = [];
  let totalBytes = 0;

  for (const entry of tree) {
    if (selected.length >= maxFiles) break;
    if (entry.type !== "blob") continue; // trees (dirs), submodule commits
    const segments = entry.path.split("/");
    if (segments.some((s) => SKIP_DIRS.has(s))) continue;
    if (SKIP_FILES.has(entry.path)) continue;
    if (SKIP_SUFFIXES.some((s) => entry.path.endsWith(s))) continue;
    const ext = (entry.path.split(".").pop() ?? "").toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const size = entry.size;
    if (size !== undefined && size > maxBytesPerFile) continue; // skip without fetching
    if (size !== undefined && totalBytes + size > maxTotalBytes) continue;
    selected.push({ path: entry.path, ...(size !== undefined ? { size } : {}) });
    totalBytes += size ?? 0;
  }
  return selected;
}
