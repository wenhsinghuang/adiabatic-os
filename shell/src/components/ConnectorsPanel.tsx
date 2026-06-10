// ConnectorsPanel — sidebar list of connector integrations with status dots.
// Management lives in the Source Console tab; this is the at-a-glance rail.

import { useConnectors } from "../hooks/useConnectors";
import { CHANNEL_LABEL, channelState } from "../lib/connector-state";
import styles from "./ConnectorsPanel.module.css";

interface ConnectorsPanelProps {
  onOpenConsole: () => void;
}

export function ConnectorsPanel({ onOpenConsole }: ConnectorsPanelProps) {
  const { connectors, loading, error } = useConnectors(5000);
  const attention = connectors.filter((c) => {
    const state = channelState(c);
    return state === "attention" || state === "quarantined";
  }).length;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Connectors</span>
        <div className={styles.actions}>
          {attention > 0 && (
            <span className={styles.attentionBadge} title={`${attention} need attention`}>
              {attention}
            </span>
          )}
          <button className={styles.actionBtn} title="Open Source Console" onClick={onOpenConsole}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 3.5L2.5 2h11L15 3.5v9l-1.5 1.5h-11L1 12.5v-9zM2.5 3.5v9h11v-9h-11z" />
              <path d="M4.5 6.25L6.75 8 4.5 9.75v-3.5zM7.5 9.5h4v1h-4v-1z" />
            </svg>
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {loading && connectors.length === 0 ? (
          <div className={styles.empty}>Loading…</div>
        ) : error && connectors.length === 0 ? (
          <div className={styles.empty}>{error}</div>
        ) : connectors.length === 0 ? (
          <div className={styles.empty}>No connectors installed</div>
        ) : (
          connectors.map((c) => {
            const state = channelState(c);
            return (
              <div key={c.id} className={styles.item} onClick={onOpenConsole}>
                <span className={`${styles.dot} ${styles[`dot_${state}`]}`} />
                <span className={styles.itemName}>{c.name}</span>
                <span className={styles.itemState}>{CHANNEL_LABEL[state].toLowerCase()}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
