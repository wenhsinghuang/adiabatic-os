// ContentArea — renders the dashboard, page editor, app files, app runtimes, or data views.

import { lazy, Suspense } from "react";
import type { Tab } from "../hooks/useTabs";
import { useDoc } from "../hooks/useDoc";
import type { SchemaRequest } from "../lib/api";
import { AppFileEditor } from "./AppFileEditor";
import { AppRuntimeView } from "./AppRuntimeView";
import { Dashboard } from "./Dashboard";
import { TableView } from "./TableView";
import { ActivityView } from "./ActivityView";
import { ConnectorsView } from "./ConnectorsView";
import { ConnectorCatalogView } from "./ConnectorCatalogView";
import styles from "./ContentArea.module.css";

const MarkdownPageEditor = lazy(() =>
  import("./MarkdownPageEditor").then((module) => ({ default: module.MarkdownPageEditor })),
);

interface ContentAreaProps {
  activeTab: Tab | null;
  coreStatus: "checking" | "connected" | "offline";
  coreError: string | null;
  schemaRequest: SchemaRequest | null;
  onOpenDoc?: (docId: string) => void;
  onCreatePage: () => void;
  onOpenApps: () => void;
  onOpenData: () => void;
  onOpenActivity: () => void;
  onOpenConnectorCatalog?: () => void;
}

export function ContentArea({
  activeTab,
  coreStatus,
  coreError,
  schemaRequest,
  onOpenDoc,
  onCreatePage,
  onOpenApps,
  onOpenData,
  onOpenActivity,
  onOpenConnectorCatalog,
}: ContentAreaProps) {
  if (!activeTab) {
    return (
      <Dashboard
        coreStatus={coreStatus}
        coreError={coreError}
        schemaRequest={schemaRequest}
        onCreatePage={onCreatePage}
        onOpenDoc={onOpenDoc ?? (() => {})}
        onOpenApps={onOpenApps}
        onOpenData={onOpenData}
        onOpenActivity={onOpenActivity}
      />
    );
  }

  if (activeTab.type === "appFile" && activeTab.appId && activeTab.filename) {
    return (
      <AppFileEditor
        key={activeTab.id}
        appId={activeTab.appId}
        filename={activeTab.filename}
      />
    );
  }

  if (activeTab.type === "appRuntime" && activeTab.appId) {
    return <AppRuntimeView key={activeTab.id} appId={activeTab.appId} />;
  }

  if (activeTab.type === "table" && activeTab.tableName) {
    return <TableView key={activeTab.id} tableName={activeTab.tableName} />;
  }

  if (activeTab.type === "activity") {
    return <ActivityView key={activeTab.id} onOpenDoc={onOpenDoc} />;
  }

  if (activeTab.type === "connectors") {
    return <ConnectorsView key={activeTab.id} onOpenCatalog={onOpenConnectorCatalog} />;
  }

  if (activeTab.type === "connectorCatalog") {
    return <ConnectorCatalogView key={activeTab.id} />;
  }

  return <TabContent key={activeTab.id} tab={activeTab} />;
}

function TabContent({ tab }: { tab: Tab }) {
  const { doc, loading, error, save } = useDoc(tab.docId);

  if (loading) {
    return <div className={styles.loading}>Loading...</div>;
  }

  if (error) {
    return <div className={styles.error}>Error: {error}</div>;
  }

  if (!doc) {
    return <div className={styles.empty}>Document not found</div>;
  }

  return (
    <Suspense fallback={<div className={styles.loading}>Loading editor...</div>}>
      <MarkdownPageEditor content={doc.content} onSave={save} />
    </Suspense>
  );
}
