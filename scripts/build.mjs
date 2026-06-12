#!/usr/bin/env node
// Build orchestrator. Replaces the inline "build"/"build:fast" script chains.
//
//   node scripts/build.mjs              bump + wasm + extension build
//   node scripts/build.mjs --fast       bump + extension build (skip wasm)
//   node scripts/build.mjs --release    full build + zip, then commit the
//                                       version bump, tag v<version>, push to
//                                       origin and create a GitHub Release
//                                       with the zip attached (needs `gh`)
//
// Flags combine: `--fast --release` releases without rebuilding wasm.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const release = args.includes("--release");
const fast = args.includes("--fast");

const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const capture = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();

run("node scripts/bump-version.mjs");
if (!fast) run("pnpm wasm:build");
// `wxt zip` runs the build itself, so in release mode it replaces the plain
// build step instead of duplicating it.
run(
  release
    ? "pnpm --filter @ozone/extension zip"
    : "pnpm --filter @ozone/extension build",
);

if (!release) process.exit(0);

const pkgPath = resolve(root, "packages/extension/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const tag = `v${version}`;
const zipPath = resolve(
  root,
  `packages/extension/.output/ozoneextension-${version}-chrome.zip`,
);

if (!existsSync(zipPath)) {
  console.error(`▸ no encuentro el zip esperado en ${zipPath} — aborto`);
  process.exit(1);
}

if (capture(`git tag -l ${tag}`)) {
  console.error(`▸ el tag ${tag} ya existe — aborto sin commitear ni pushear`);
  process.exit(1);
}

// Only the version bump goes into the release commit; anything else dirty
// stays in the working tree (the tag must not absorb unrelated WIP).
const dirty = capture("git status --porcelain")
  .split("\n")
  .filter((l) => l && !l.includes("packages/extension/package.json"));
if (dirty.length) {
  console.warn(
    `▸ aviso: ${dirty.length} cambio(s) sin commitear quedan fuera del commit de release`,
  );
}

run(`git commit -m "chore(release): ${tag}" packages/extension/package.json`);
run(`git tag -a ${tag} -m "Release ${tag}"`);
run("git push origin HEAD --follow-tags");
run(`gh release create ${tag} "${zipPath}" --title "${tag}" --generate-notes`);
console.log(`▸ release ${tag} → tag, GitHub Release y zip subidos`);
