// Root App — VS Code-inspired layout with sidebar, tabs, content, and terminal.
// Boots the WebContainer sandbox on mount.

import { useState, useEffect, useCallback } from "react";
import { Shell } from "./layout/Shell";
import { TitleBar } from "./layout/TitleBar";
import { TabBar } from "./layout/TabBar";
import { ActivityBar, type Panel } from "./layout/ActivityBar";
import { PagesPanel } from "./components/PagesPanel";
import { AppsPanel } from "./components/AppsPanel";
import { DataPanel } from "./components/DataPanel";
import { ContentArea } from "./content/ContentArea";
import { TerminalPanel } from "./content/TerminalPanel";
import { useTabs } from "./hooks/useTabs";
import { listApps } from "./lib/api";
import { boot, loadApps, startBridgeServer } from "./sandbox/webcontainer";
import "./styles/global.css";

export function App() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Booting sandbox...");
  const [showTerminal, setShowTerminal] = useState(false);
  const [activePanel, setActivePanel] = useState<Panel>("pages");

  const {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    openAppFileTab,
    openTableTab,
    openActivityTab,
    closeTab,
    setActiveTab,
    toggleSource,
  } = useTabs("welcome");

  const handleToggleTerminal = useCallback(() => {
    setShowTerminal((prev) => !prev);
  }, []);

  const handleDeleteDoc = useCallback(
    (id: string) => {
      closeTab(id);
    },
    [closeTab],
  );

  const handleRenameDoc = useCallback(
    (oldId: string, newId: string) => {
      closeTab(oldId);
      openTab(newId);
    },
    [closeTab, openTab],
  );

  useEffect(() => {
    async function init() {
      try {
        setStatus("Booting sandbox...");
        await boot();

        setStatus("Loading apps...");
        const { apps } = await listApps();
        await loadApps(apps);

        setStatus("Starting bridge server...");
        await startBridgeServer();
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
          background: "#1e1e1e",
          color: "#888",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div style={{ fontSize: "13px", fontFamily: "var(--font-sans)" }}>
          {status}
        </div>
        <div
          style={{
            width: "200px",
            height: "2px",
            background: "#333",
            borderRadius: "1px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "40%",
              height: "100%",
              background: "#007acc",
              borderRadius: "1px",
              animation: "loading 1.5s ease-in-out infinite",
            }}
          />
        </div>
        <style>{`
          @keyframes loading {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(350%); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <Shell
      titleBar={<TitleBar activeDocId={activeTabId} />}
      activityBar={
        <ActivityBar
          activePanel={activePanel}
          onSelectPanel={setActivePanel}
          showTerminal={showTerminal}
          onToggleTerminal={handleToggleTerminal}
        />
      }
      sidebar={
        activePanel === "pages" ? (
          <PagesPanel
            activeDocId={activeTabId}
            onSelect={openTab}
            onDeleteDoc={handleDeleteDoc}
            onRenameDoc={handleRenameDoc}
          />
        ) : activePanel === "apps" ? (
          <AppsPanel onOpenAppFile={(appId, filename) => openAppFileTab(appId, filename)} />
        ) : (
          <DataPanel onOpenTable={openTableTab} onOpenActivity={openActivityTab} />
        )
      }
      tabBar={
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTab}
          onClose={closeTab}
          onToggleSource={toggleSource}
        />
      }
      content={<ContentArea activeTab={activeTab} onOpenDoc={openTab} />}
      terminal={<TerminalPanel />}
      showTerminal={showTerminal}
    />
  );
}
