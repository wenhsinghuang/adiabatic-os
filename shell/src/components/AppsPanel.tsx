// AppsPanel — app browser with expandable file tree and create wizard.

import { useState, useCallback } from "react";
import { useApps } from "../hooks/useApps";
import { InlineInput } from "./InlineInput";
import * as api from "../lib/api";
import styles from "./AppsPanel.module.css";

interface AppsPanelProps {
  onOpenAppFile: (appId: string, filename: string) => void;
  onOpenApp: (appId: string) => void;
}

export function AppsPanel({ onOpenAppFile, onOpenApp }: AppsPanelProps) {
  const { apps, loading, refresh } = useApps();
  const [expandedApps, setExpandedApps] = useState<Map<string, string[]>>(new Map());
  const [creating, setCreating] = useState(false);

  const toggleExpand = useCallback(
    async (appId: string) => {
      setExpandedApps((prev) => {
        const next = new Map(prev);
        if (next.has(appId)) {
          next.delete(appId);
        } else {
          next.set(appId, []); // placeholder while loading
          // Fetch files
          api.getAppSource(appId).then((files) => {
            setExpandedApps((p) => {
              const n = new Map(p);
              n.set(appId, Object.keys(files));
              return n;
            });
          });
        }
        return next;
      });
    },
    [],
  );

  const handleCreate = useCallback(
    async (id: string) => {
      setCreating(false);
      const cleanId = id.replace(/\s+/g, "-").toLowerCase();
      await api.createApp(cleanId, cleanId);
      await refresh();
    },
    [refresh],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Apps</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} title="New App" onClick={() => setCreating(true)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z" />
            </svg>
          </button>
        </div>
      </div>
      <div className={styles.tree}>
        {creating && (
          <div className={styles.inlineCreate}>
            <InlineInput
              placeholder="app-id"
              onSubmit={handleCreate}
              onCancel={() => setCreating(false)}
            />
          </div>
        )}
        {loading ? (
          <div className={styles.loading}>Loading...</div>
        ) : apps.length === 0 ? (
          <div className={styles.empty}>No apps installed</div>
        ) : (
          apps.map((app) => {
            const isExpanded = expandedApps.has(app.id);
            const files = expandedApps.get(app.id) ?? [];

            return (
              <div key={app.id}>
                <div
                  className={styles.appItem}
                  onClick={() => toggleExpand(app.id)}
                >
                  <span className={`${styles.arrow} ${isExpanded ? styles.expanded : ""}`}>▸</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={styles.appIcon}>
                    <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-2 .9-2 2v3.8h1.5a2.5 2.5 0 0 1 0 5H2V19c0 1.1.9 2 2 2h3.8v-1.5a2.5 2.5 0 0 1 5 0V21H16c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
                  </svg>
                  <span className={styles.appName}>{app.name}</span>
                  <button
                    className={styles.runBtn}
                    title="Open app"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenApp(app.id);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 2.5v11l9-5.5-9-5.5z" />
                    </svg>
                  </button>
                </div>
                {isExpanded &&
                  files.map((filename) => (
                    <div
                      key={filename}
                      className={styles.fileItem}
                      onClick={() => onOpenAppFile(app.id, filename)}
                    >
                      <span className={styles.fileName}>{filename}</span>
                    </div>
                  ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
