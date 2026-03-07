// useTabs — manages open tabs (docs + app files) with source-toggle state.

import { useState, useCallback } from "react";

export interface Tab {
  id: string; // unique tab identifier
  type: "doc" | "appFile" | "table" | "activity";
  docId: string; // for doc tabs: the doc id; for appFile tabs: `__app:{appId}/{filename}`
  showSource: boolean;
  appId?: string;
  filename?: string;
  tableName?: string;
}

export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

function makeAppFileTabId(appId: string, filename: string): string {
  return `__app:${appId}/${filename}`;
}

export function useTabs(initialDocId: string | null = "welcome") {
  const [state, setState] = useState<TabsState>(() => {
    if (!initialDocId) return { tabs: [], activeTabId: null };
    return {
      tabs: [{ id: initialDocId, type: "doc", docId: initialDocId, showSource: false }],
      activeTabId: initialDocId,
    };
  });

  const openTab = useCallback((docId: string) => {
    setState((prev) => {
      const exists = prev.tabs.find((t) => t.id === docId);
      if (exists) {
        return { ...prev, activeTabId: docId };
      }
      return {
        tabs: [...prev.tabs, { id: docId, type: "doc", docId, showSource: false }],
        activeTabId: docId,
      };
    });
  }, []);

  const openAppFileTab = useCallback((appId: string, filename: string) => {
    const tabId = makeAppFileTabId(appId, filename);
    setState((prev) => {
      const exists = prev.tabs.find((t) => t.id === tabId);
      if (exists) {
        return { ...prev, activeTabId: tabId };
      }
      return {
        tabs: [
          ...prev.tabs,
          {
            id: tabId,
            type: "appFile",
            docId: tabId,
            showSource: false,
            appId,
            filename,
          },
        ],
        activeTabId: tabId,
      };
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setState((prev) => {
      const idx = prev.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;

      const newTabs = prev.tabs.filter((t) => t.id !== tabId);
      let newActive = prev.activeTabId;

      if (prev.activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActive = null;
        } else if (idx >= newTabs.length) {
          newActive = newTabs[newTabs.length - 1].id;
        } else {
          newActive = newTabs[idx].id;
        }
      }

      return { tabs: newTabs, activeTabId: newActive };
    });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    setState((prev) => ({ ...prev, activeTabId: tabId }));
  }, []);

  const toggleSource = useCallback((tabId: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) =>
        t.id === tabId ? { ...t, showSource: !t.showSource } : t,
      ),
    }));
  }, []);

  const openTableTab = useCallback((tableName: string) => {
    const tabId = `__table:${tableName}`;
    setState((prev) => {
      const exists = prev.tabs.find((t) => t.id === tabId);
      if (exists) return { ...prev, activeTabId: tabId };
      return {
        tabs: [
          ...prev.tabs,
          { id: tabId, type: "table", docId: tabId, showSource: false, tableName },
        ],
        activeTabId: tabId,
      };
    });
  }, []);

  const openActivityTab = useCallback(() => {
    const tabId = "__activity";
    setState((prev) => {
      const exists = prev.tabs.find((t) => t.id === tabId);
      if (exists) return { ...prev, activeTabId: tabId };
      return {
        tabs: [
          ...prev.tabs,
          { id: tabId, type: "activity", docId: tabId, showSource: false },
        ],
        activeTabId: tabId,
      };
    });
  }, []);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    openTab,
    openAppFileTab,
    openTableTab,
    openActivityTab,
    closeTab,
    setActiveTab,
    toggleSource,
  };
}
