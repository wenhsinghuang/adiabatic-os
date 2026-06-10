// ActivityBar — icon rail on the left (files, apps, settings, terminal toggle).

import styles from "./ActivityBar.module.css";

export type Panel = "pages" | "apps" | "data" | "connectors" | "workspace";

interface ActivityBarProps {
  activePanel: Panel;
  onSelectPanel: (panel: Panel) => void;
  showTerminal: boolean;
  onToggleTerminal: () => void;
}

export function ActivityBar({ activePanel, onSelectPanel, showTerminal, onToggleTerminal }: ActivityBarProps) {
  return (
    <div className={styles.activityBar}>
      <div className={styles.top}>
        {/* Files icon */}
        <button
          className={`${styles.icon} ${activePanel === "pages" ? styles.active : ""}`}
          title="Explorer"
          onClick={() => onSelectPanel("pages")}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.5 0h-9L7 1.5V6H2.5L1 7.5v15.07L2.5 24h12.07L16 22.57V18h4.7l1.3-1.43V4.5L17.5 0zm0 2.12l2.38 2.38H17.5V2.12zm-3 20.38h-12v-15H7v9.07L8.5 18h6v4.5zm6-6h-12v-15H16V6h4.5v10.5z" />
          </svg>
        </button>
        {/* Apps icon (puzzle piece) */}
        <button
          className={`${styles.icon} ${activePanel === "apps" ? styles.active : ""}`}
          title="Apps"
          onClick={() => onSelectPanel("apps")}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-2 .9-2 2v3.8h1.5a2.5 2.5 0 0 1 0 5H2V19c0 1.1.9 2 2 2h3.8v-1.5a2.5 2.5 0 0 1 5 0V21H16c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
          </svg>
        </button>
        {/* Data icon (database cylinder) */}
        <button
          className={`${styles.icon} ${activePanel === "data" ? styles.active : ""}`}
          title="Data"
          onClick={() => onSelectPanel("data")}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <ellipse cx="12" cy="5.5" rx="8" ry="3.5" />
            <path d="M4 5.5v4c0 1.93 3.58 3.5 8 3.5s8-1.57 8-3.5v-4c0 1.93-3.58 3.5-8 3.5S4 7.43 4 5.5z" />
            <path d="M4 9.5v4c0 1.93 3.58 3.5 8 3.5s8-1.57 8-3.5v-4c0 1.93-3.58 3.5-8 3.5S4 11.43 4 9.5z" />
            <path d="M4 13.5v4c0 1.93 3.58 3.5 8 3.5s8-1.57 8-3.5v-4c0 1.93-3.58 3.5-8 3.5S4 15.43 4 13.5z" />
          </svg>
        </button>
        {/* Connectors icon (plug) */}
        <button
          className={`${styles.icon} ${activePanel === "connectors" ? styles.active : ""}`}
          title="Connectors"
          onClick={() => onSelectPanel("connectors")}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16.01 7.5V3h-2v4.5h-4V3h-2v4.5H6.5v5l3.5 3.5v3.5a1.5 1.5 0 0 0 3 0V16l3.5-3.5h1.01v-5h-1.5zM8.5 11.67V9.5h7v2.17l-3.06 3.06h-.88L8.5 11.67z" />
          </svg>
        </button>
      </div>
      <div className={styles.bottom}>
        {/* Workspace/settings */}
        <button
          className={`${styles.icon} ${activePanel === "workspace" ? styles.active : ""}`}
          title="Workspace"
          onClick={() => onSelectPanel("workspace")}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65.2-1-2-3.46-.96-.3-2.49 1a7.4 7.4 0 0 0-1.7-.98L14.2 2h-4.4l-.39 2.63c-.61.24-1.18.56-1.7.98l-2.49-1-.96.3-2 3.46.2 1 2.11 1.65c-.04.32-.07.65-.07.98s.02.66.07.98l-2.11 1.65-.2 1 2 3.46.96.3 2.49-1c.52.4 1.09.73 1.7.98L9.8 22h4.4l.39-2.63c.61-.24 1.18-.56 1.7-.98l2.49 1 .96-.3 2-3.46-.2-1-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z" />
          </svg>
        </button>
        {/* Terminal toggle */}
        <button
          className={`${styles.icon} ${showTerminal ? styles.active : ""}`}
          title={showTerminal ? "Hide terminal" : "Show terminal"}
          onClick={onToggleTerminal}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h15A2.5 2.5 0 0 1 22 4.5v15a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 19.5v-15zM4.5 3.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-15a1 1 0 0 0-1-1h-15zM7.22 8.28a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06L10.19 11.25 7.22 8.28zM12 15.25a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
