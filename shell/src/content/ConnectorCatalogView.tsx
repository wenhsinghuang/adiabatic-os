// ConnectorCatalogView — the Connector Catalog: packages that can be
// installed into this workspace. Today the shelf holds bundled built-ins;
// the official download catalog merges into the same page later. Installing
// is always explicit and uses the same flow for every package source.

import { useCallback, useState } from "react";
import { useConnectors } from "../hooks/useConnectors";
import { installConnector, type AvailableConnectorView } from "../lib/api";
import styles from "./ConnectorsView.module.css";

export function ConnectorCatalogView() {
  const { available, loading, error, refresh } = useConnectors();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const install = useCallback(
    async (connectorId: string) => {
      setBusy((prev) => ({ ...prev, [connectorId]: true }));
      setActionError(null);
      try {
        await installConnector(connectorId);
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[connectorId];
          return next;
        });
      }
    },
    [refresh],
  );

  return (
    <div className={styles.console}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Connector Catalog</h1>
          <span className={styles.subtitle}>bundled packages · official catalog coming</span>
        </div>
      </header>

      {(error || actionError) && (
        <div className={styles.errorStrip} role="alert">
          <span className={styles.errorGlyph}>▲</span>
          {actionError ?? error}
          {actionError && (
            <button className={styles.errorDismiss} onClick={() => setActionError(null)}>
              ✕
            </button>
          )}
        </div>
      )}

      <div className={styles.ledger}>
        {loading && available.length === 0 ? (
          <div className={styles.empty}>scanning bundled connectors…</div>
        ) : available.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyGlyph}>⌀</span>
            <span>nothing on the shelf</span>
            <span className={styles.emptyHint}>
              this build ships without bundled connectors
            </span>
          </div>
        ) : (
          available.map((entry, index) => (
            <CatalogCard
              key={entry.connectorId}
              entry={entry}
              index={index}
              busy={Boolean(busy[entry.connectorId])}
              onInstall={() => install(entry.connectorId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface CatalogCardProps {
  entry: AvailableConnectorView;
  index: number;
  busy: boolean;
  onInstall: () => void;
}

function CatalogCard({ entry, index, busy, onInstall }: CatalogCardProps) {
  const cardClass = entry.installed
    ? styles.card_installed
    : entry.supported
      ? styles.card_available
      : `${styles.card_available} ${styles.card_unsupported}`;
  return (
    <article
      className={`${styles.card} ${cardClass}`}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className={styles.cardRail} />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span
            className={`${styles.stateBadge} ${entry.installed ? styles.tone_ready : styles.tone_available}`}
          >
            <span className={styles.stateDot} />
            {entry.installed ? "INSTALLED" : "AVAILABLE"}
          </span>
          <h2 className={styles.cardName}>{entry.name}</h2>
          <span className={styles.cardMeta}>
            {entry.mode}
            {entry.authType !== "none" && <span className={styles.cron}> · {entry.authType}</span>}
            <span className={styles.bundledSeal}>bundled</span>
          </span>
          <div className={styles.cardTopActions}>
            {entry.installed ? (
              <span className={styles.installedNote}>in your source console</span>
            ) : entry.supported ? (
              <button className={styles.primaryBtn} disabled={busy} onClick={onInstall}>
                {busy ? "installing…" : "Install"}
              </button>
            ) : (
              <span className={styles.unsupportedNote}>not supported on this device</span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
