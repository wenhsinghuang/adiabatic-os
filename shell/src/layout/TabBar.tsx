// TabBar — document and app file tabs with source-toggle icon per tab.

import type { Tab } from "../hooks/useTabs";
import styles from "./TabBar.module.css";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onToggleSource: (tabId: string) => void;
}

function getTabLabel(tab: Tab): string {
  if (tab.type === "appFile" && tab.filename) return tab.filename;
  if (tab.type === "table" && tab.tableName) return tab.tableName;
  if (tab.type === "activity") return "Activity";
  return tab.docId.split("/").pop() || tab.docId;
}

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onToggleSource,
}: TabBarProps) {
  if (tabs.length === 0) {
    return <div className={styles.tabBar} />;
  }

  return (
    <div className={styles.tabBar}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = getTabLabel(tab);
        const showSourceToggle = tab.type === "doc";

        return (
          <div
            key={tab.id}
            className={`${styles.tab} ${isActive ? styles.active : ""}`}
            onClick={() => onSelect(tab.id)}
          >
            <span className={styles.label}>{label}</span>
            {showSourceToggle && (
              <button
                className={`${styles.icon} ${tab.showSource ? styles.sourceActive : ""}`}
                title={tab.showSource ? "Show rendered" : "Show source"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSource(tab.id);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.854 4.146a.5.5 0 0 1 0 .708L2.707 8l3.147 3.146a.5.5 0 0 1-.708.708l-3.5-3.5a.5.5 0 0 1 0-.708l3.5-3.5a.5.5 0 0 1 .708 0zm4.292 0a.5.5 0 0 0 0 .708L13.293 8l-3.147 3.146a.5.5 0 0 0 .708.708l3.5-3.5a.5.5 0 0 0 0-.708l-3.5-3.5a.5.5 0 0 0-.708 0z" />
                </svg>
              </button>
            )}
            <button
              className={styles.close}
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
