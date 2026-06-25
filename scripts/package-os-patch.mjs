#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outDir = join(root, "dist");
const outFile = join(outDir, `adiabatic-os-${pkg.version}.tar.gz`);

mkdirSync(outDir, { recursive: true });

const include = [
  "package.json",
  "bun.lock",
  "package-lock.json",
  "desktop",
  "scripts/package-os-patch.mjs",
  "scripts/build-electron-main.mjs",
];

const args = [
  "-czf",
  outFile,
  "--exclude",
  "node_modules",
  "--exclude",
  ".git",
  "--exclude",
  "dist",
  "--exclude",
  "*/.adiabatic/*.db",
  "--exclude",
  "*/.adiabatic/*.db-*",
  ...include,
];

const result = spawnSync("tar", args, { cwd: root, stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(outFile);
