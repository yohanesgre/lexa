#!/usr/bin/env sh

set -eu

# The Effect-TS checkout is only needed by `doctor` (react-doctor research).
# Skip it in Docker image builds — a live clone there is a fragile network dep.
if [ "${LXK_SKIP_PREPARE:-0}" = "1" ]; then
  exit 0
fi

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect"
# Must match the installed effect version (package.json / bun.lock): the
# default branch tracks the latest beta and will mislead this v3 project.
ref="effect@3.22.1"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

mkdir -p ".repos"
git clone --depth 1 --branch "$ref" "$repo_url" "$repo_dir"
