#!/usr/bin/env sh

set -eu

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
