// ContentArea — renders the active tab's content (rendered page, source editor, or app file editor).

import type { Tab } from "../hooks/useTabs";
import { useDoc } from "../hooks/useDoc";
import { MdxRenderer } from "./MdxRenderer";
import { SourceEditor } from "./SourceEditor";
import { AppFileEditor } from "./AppFileEditor";
import { TableView } from "./TableView";
import { ActivityView } from "./ActivityView";
import styles from "./ContentArea.module.css";

interface ContentAreaProps {
  activeTab: Tab | null;
  onOpenDoc?: (docId: string) => void;
}

export function ContentArea({ activeTab, onOpenDoc }: ContentAreaProps) {
  if (!activeTab) {
    return (
      <div className={styles.empty}>
        <span>Open a page from the sidebar</span>
      </div>
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

  if (activeTab.type === "table" && activeTab.tableName) {
    return <TableView key={activeTab.id} tableName={activeTab.tableName} />;
  }

  if (activeTab.type === "activity") {
    return <ActivityView key={activeTab.id} onOpenDoc={onOpenDoc} />;
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

  if (tab.showSource) {
    return <SourceEditor content={doc.content} onSave={save} />;
  }

  return <MdxRenderer content={doc.content} onSave={save} />;
}
