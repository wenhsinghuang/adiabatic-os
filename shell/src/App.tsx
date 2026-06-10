// Root App — local-first personal OS shell.

import { useState, useEffect, useCallback } from "react";
import { Shell } from "./layout/Shell";
import { TitleBar } from "./layout/TitleBar";
import { TabBar } from "./layout/TabBar";
import { ActivityBar, type Panel } from "./layout/ActivityBar";
import { PagesPanel } from "./components/PagesPanel";
import { AppsPanel } from "./components/AppsPanel";
import { DataPanel } from "./components/DataPanel";
import { ConnectorsPanel } from "./components/ConnectorsPanel";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { SchemaApprovalModal } from "./components/SchemaApprovalModal";
import { ContentArea } from "./content/ContentArea";
import { TerminalPanel } from "./content/TerminalPanel";
import { useTabs } from "./hooks/useTabs";
import {
  approveSchemaRequest,
  listApps,
  listSchemaRequests,
  rejectSchemaRequest,
  saveDoc,
  type SchemaRequest,
} from "./lib/api";
import "./styles/global.css";

type CoreStatus = "checking" | "connected" | "offline";

export function App() {
  const [coreStatus, setCoreStatus] = useState<CoreStatus>("checking");
  const [coreError, setCoreError] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [activePanel, setActivePanel] = useState<Panel>("pages");
  const [schemaRequest, setSchemaRequest] = useState<SchemaRequest | null>(null);

  const {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    openAppFileTab,
    openAppRuntimeTab,
    openTableTab,
    openActivityTab,
    openConnectorsTab,
    closeTab,
    setActiveTab,
  } = useTabs(null);

  const handleToggleTerminal = useCallback(() => {
    setShowTerminal((prev) => {
      const next = !prev;
      if (next) setTerminalStarted(true);
      return next;
    });
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

  const checkCore = useCallback(async () => {
    try {
      await listApps();
      setCoreStatus("connected");
      setCoreError(null);
    } catch (err) {
      setCoreStatus("offline");
      setCoreError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    checkCore();
    const id = window.setInterval(checkCore, 5000);
    return () => window.clearInterval(id);
  }, [checkCore]);

  useEffect(() => {
    if (coreStatus !== "connected") return;
    let cancelled = false;

    async function pollSchemaRequests() {
      try {
        const { requests } = await listSchemaRequests();
        if (cancelled) return;
        setSchemaRequest(requests.find((request) => request.status === "pending") ?? null);
      } catch (err) {
        console.error("[app] Schema request poll failed:", err);
      }
    }

    pollSchemaRequests();
    const id = window.setInterval(pollSchemaRequests, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [coreStatus]);

  const handleApproveSchema = useCallback(async (id: string, remember: boolean) => {
    await approveSchemaRequest(id, remember);
    setSchemaRequest(null);
  }, []);

  const handleRejectSchema = useCallback(async (id: string) => {
    await rejectSchemaRequest(id);
    setSchemaRequest(null);
  }, []);

  const handleCreatePage = useCallback(async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const id = `untitled-${stamp}`;
    await saveDoc(id, "# Untitled\n");
    setActivePanel("pages");
    openTab(id);
  }, [openTab]);

  const handleOpenApps = useCallback(() => {
    setActivePanel("apps");
  }, []);

  const handleOpenData = useCallback(() => {
    setActivePanel("data");
  }, []);

  const handleOpenActivity = useCallback(() => {
    setActivePanel("data");
    openActivityTab();
  }, [openActivityTab]);

  return (
    <>
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
            <AppsPanel
              onOpenApp={openAppRuntimeTab}
              onOpenAppFile={(appId, filename) => openAppFileTab(appId, filename)}
            />
          ) : activePanel === "data" ? (
            <DataPanel onOpenTable={openTableTab} onOpenActivity={openActivityTab} />
          ) : activePanel === "connectors" ? (
            <ConnectorsPanel onOpenConsole={openConnectorsTab} />
          ) : (
            <WorkspacePanel coreStatus={coreStatus} onCoreChanged={checkCore} />
          )
        }
        tabBar={
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTab}
            onClose={closeTab}
          />
        }
        content={
          <ContentArea
            activeTab={activeTab}
            coreStatus={coreStatus}
            coreError={coreError}
            schemaRequest={schemaRequest}
            onOpenDoc={openTab}
            onCreatePage={handleCreatePage}
            onOpenApps={handleOpenApps}
            onOpenData={handleOpenData}
            onOpenActivity={handleOpenActivity}
          />
        }
        terminal={terminalStarted ? <TerminalPanel visible={showTerminal} /> : null}
        showTerminal={showTerminal}
      />
      {schemaRequest && (
        <SchemaApprovalModal
          request={schemaRequest}
          onApprove={handleApproveSchema}
          onReject={handleRejectSchema}
        />
      )}
    </>
  );
}
