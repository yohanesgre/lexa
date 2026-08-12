#!/usr/bin/env sh
# Install the dev lexa-cli shim on PATH: `lexa-cli-dev` runs the live repo
# source via bun (picks up code changes without recompiling). The prod
# binary (`bun run compile:cli` + `bun run install:cli`) installs as
# `lexa-cli` — never overwritten by this.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
test -f "$root/cli/src/index.ts" || { echo "lexa-cli-dev: repo layout unexpected at $root" >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
{
  echo "#!/usr/bin/env sh"
  echo "# lexa-cli-dev — dev build: runs live repo source via bun (no env hacks:"
  echo "# state follows the server URL, same as the compiled binary)."
  echo "exec bun run \"$root/cli/src/index.ts\" \"\$@\""
} > "$HOME/.local/bin/lexa-cli-dev"
chmod +x "$HOME/.local/bin/lexa-cli-dev"
echo "  Installed dev shim → $HOME/.local/bin/lexa-cli-dev"
echo "  (runs repo source at $root — re-run install:cli-dev after moving the repo)"
