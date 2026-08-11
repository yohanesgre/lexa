import { describe, it, expect } from "vitest";
import { selectRepoFiles, REPO_CONTENT_DEFAULTS } from "./repo-content";

const blob = (path: string, size = 100) => ({ path, type: "blob", size });

describe("selectRepoFiles", () => {
  it("keeps plain source files in tree order", () => {
    const tree = [blob("src/index.ts", 10), blob("README.md", 5), blob("src/util.ts", 3)];
    expect(selectRepoFiles(tree)).toEqual([
      { path: "src/index.ts", size: 10 },
      { path: "README.md", size: 5 },
      { path: "src/util.ts", size: 3 },
    ]);
  });

  it("skips dirs (node_modules, .git, dist, build, vendor, .next, coverage, target, .venv) at any depth", () => {
    const tree = [
      blob("src/app.ts"),
      blob("node_modules/lodash/index.js"),
      blob("a/b/.git/config"),
      blob("dist/bundle.js"),
      blob("build/out.bin"),
      blob("vendor/lib.js"),
      blob(".next/static/x.js"),
      blob("coverage/lcov.info"),
      blob("target/debug/x"),
      blob(".venv/bin/python"),
      blob("src/ok.ts"),
    ];
    expect(selectRepoFiles(tree).map((f) => f.path)).toEqual(["src/app.ts", "src/ok.ts"]);
  });

  it("skips non-blob tree entries (dirs, submodule commits)", () => {
    const tree = [
      { path: "src", type: "tree" },
      { path: "src/app.ts", type: "blob", size: 10 },
      { path: "vendor/lib", type: "commit", size: 5 },
    ];
    expect(selectRepoFiles(tree).map((f) => f.path)).toEqual(["src/app.ts"]);
  });

  it("skips lockfiles and minified/generated artifacts", () => {
    const tree = [
      blob("package-lock.json"),
      blob("pnpm-lock.yaml"),
      blob("yarn.lock"),
      blob("bun.lockb"),
      blob("composer.lock"),
      blob("dist/app.min.js"),
      blob("src/app.min.css"),
      blob("src/app.js.map"),
      blob("src/app.ts"),
    ];
    expect(selectRepoFiles(tree).map((f) => f.path)).toEqual(["src/app.ts"]);
  });

  it("skips binary extensions but keeps svg (text)", () => {
    const tree = [
      blob("img/logo.png"), blob("img/photo.jpg"), blob("img/g.gif"), blob("img/w.webp"),
      blob("img/i.ico"), blob("img/a.avif"), blob("img/b.bmp"), blob("doc.pdf"),
      blob("a.zip"), blob("b.tar.gz"), blob("f.woff2"), blob("audio.mp3"), blob("v.mp4"),
      blob("app.wasm"), blob("x.exe"), blob("lib.so"), blob("Klass.class"), blob("lib.jar"),
      blob("data.db"), blob("cache.sqlite"),
      blob("icon.svg"), blob("src/app.ts"),
    ];
    expect(selectRepoFiles(tree).map((f) => f.path)).toEqual(["icon.svg", "src/app.ts"]);
  });

  it("caps per-file size: skips blobs larger than maxBytesPerFile without fetching", () => {
    const tree = [blob("big.ts", 300_000), blob("small.ts", 10)];
    expect(selectRepoFiles(tree, { maxBytesPerFile: 256_000 })).toEqual([{ path: "small.ts", size: 10 }]);
  });

  it("caps total bytes across files (tree order, no reordering)", () => {
    const tree = [blob("a.ts", 100), blob("b.ts", 100), blob("c.ts", 100), blob("d.ts", 100)];
    expect(selectRepoFiles(tree, { maxTotalBytes: 250 }).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("caps file count", () => {
    const tree = [blob("a.ts"), blob("b.ts"), blob("c.ts"), blob("d.ts")];
    expect(selectRepoFiles(tree, { maxFiles: 2 }).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("exposes and applies the documented defaults", () => {
    expect(REPO_CONTENT_DEFAULTS).toEqual({ maxFiles: 50, maxBytesPerFile: 256_000, maxTotalBytes: 512_000 });
    const tree = [blob("a.ts", REPO_CONTENT_DEFAULTS.maxBytesPerFile + 1), blob("b.ts", 10)];
    expect(selectRepoFiles(tree)).toEqual([{ path: "b.ts", size: 10 }]);
  });

  it("handles blobs without a size (no crash, treated as fetchable)", () => {
    const tree = [{ path: "src/a.ts", type: "blob" }, { path: "src/b.ts", type: "blob", size: 5 }];
    expect(selectRepoFiles(tree)).toEqual([
      { path: "src/a.ts", size: undefined },
      { path: "src/b.ts", size: 5 },
    ]);
  });

  it("skips dotfiles with known binary extensions but keeps text dotfiles", () => {
    const tree = [blob(".gitignore"), blob(".env.db"), blob("src/x.dylib"), blob("Cargo.toml")];
    expect(selectRepoFiles(tree).map((f) => f.path)).toEqual([".gitignore", "Cargo.toml"]);
  });
});
