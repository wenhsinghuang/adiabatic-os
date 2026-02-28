// Root App — layout with sidebar, top bar, and page view.
// Boots the WebContainer sandbox and initializes the component registry on mount.

import { useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { PageView, type EditorMode } from "./editor/PageView";
import { listApps } from "./lib/api";
import { registerApps, setModuleLoader } from "./renderer/component-registry";
import { boot, loadApps, startBridgeServer } from "./sandbox/webcontainer";
import { appModuleLoader } from "./sandbox/app-bundler";

export function App() {
  const [docId, setDocId] = useState<string | null>("welcome");
  const [mode, setMode] = useState<EditorMode>("view");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Booting sandbox...");

  useEffect(() => {
    async function init() {
      try {
        // 1. Boot WebContainer (WASM sandbox)
        setStatus("Booting sandbox...");
        await boot();

        // 2. Fetch app list from core
        setStatus("Loading apps...");
        const { apps } = await listApps();

        // 3. Load app source into WebContainer + bundle
        await loadApps(apps);

        // 4. Start bridge server inside WebContainer
        setStatus("Starting bridge server...");
        await startBridgeServer();

        // 5. Wire up module loader + register components
        setModuleLoader(appModuleLoader);
        registerApps(apps);

        console.log(
          "[app] Sandbox ready. Components:",
          apps.flatMap((a) => a.components),
        );
      } catch (err) {
        console.error("[app] Sandbox init failed:", err);
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      setReady(true);
    }
    init();
  }, []);

  if (!ready) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "#999",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div style={{ fontSize: "14px" }}>{status}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopBar mode={mode} onModeChange={setMode} docId={docId} />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Sidebar activeDocId={docId} onSelect={setDocId} />
        <div style={{ flex: 1, overflow: "auto" }}>
          {docId ? (
            <PageView docId={docId} mode={mode} />
          ) : (
            <div style={{ padding: "48px", color: "#999" }}>
              Select a page from the sidebar.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
