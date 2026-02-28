// App Bundler (server-side) — bundles app index.tsx into browser-compatible ESM.
// Uses Bun.build() for fast bundling.
// Called by GET /api/apps/:id/bundle.

// Bundle cache: entryPoint → { code, mtime }
const cache = new Map<string, { code: string; mtime: number }>();

export async function bundleApp(entryPoint: string, appDir: string): Promise<string> {
  // Check cache freshness
  const stat = Bun.file(entryPoint);
  const mtime = (await stat.exists()) ? stat.lastModified : 0;
  const cached = cache.get(entryPoint);
  if (cached && cached.mtime === mtime) {
    return cached.code;
  }

  const result = await Bun.build({
    entrypoints: [entryPoint],
    format: "esm",
    target: "browser",
    // React is provided by the host (shell) — don't bundle it
    external: ["react", "react-dom", "react/jsx-runtime"],
  });

  if (!result.success) {
    const errors = result.logs.map((l) => l.message).join("\n");
    throw new Error(errors);
  }

  const code = await result.outputs[0].text();
  cache.set(entryPoint, { code, mtime });
  return code;
}
