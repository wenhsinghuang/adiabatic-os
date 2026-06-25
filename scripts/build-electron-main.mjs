import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "shell/dist-electron");

await mkdir(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, "shell/electron/main.ts")],
  outfile: resolve(outDir, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});
await cp(resolve(root, "shell/electron/preload.cjs"), resolve(outDir, "preload.cjs"));
