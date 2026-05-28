#!/usr/bin/env node
// Bump the extension's patch version. Reads packages/extension/package.json,
// increments the LAST segment of "version" (0.0.N → 0.0.N+1), and writes it
// back. wxt.config.ts pulls version from package.json so the chrome manifest
// picks up the bump automatically.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "..", "packages/extension/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const parts = String(pkg.version ?? "0.0.0").split(".");
while (parts.length < 3) parts.push("0");
const next = Number(parts[2] ?? "0") + 1;
parts[2] = String(next);
const nextVersion = parts.slice(0, 3).join(".");
pkg.version = nextVersion;

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`▸ extension version → ${nextVersion}`);
