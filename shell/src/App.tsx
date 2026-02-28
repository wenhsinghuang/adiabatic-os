// Root App — layout with sidebar, top bar, and page view.
// Initializes the component registry on mount.

import { useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { PageView, type EditorMode } from "./editor/PageView";
import { listApps } from "./lib/api";
import { registerApps, setModuleLoader } from "./renderer/component-registry";
import { appModuleLoader } from "./sandbox/app-bundler";

export function App() {
  const [docId, setDocId] = useState<string | null>("welcome");
  const [mode, setMode] = useState<EditorMode>("view");
  const [ready, setReady] = useState(false);

  // Initialize component registry on mount
  useEffect(() => {
    async function init() {
      try {
        // Set up the module loader for dynamic app imports
        setModuleLoader(appModuleLoader);

        // Fetch app list from core and register components
        const { apps } = await listApps();
        registerApps(apps);
        console.log(
          `[app] Registered components:`,
          apps.flatMap((a) => a.components),
        );
      } catch (err) {
        console.error("[app] Failed to initialize component registry:", err);
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
        }}
      >
        Starting...
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
