import { useEffect, useMemo, useState } from "react";
import type { SchemaRequest } from "../lib/api";
import * as api from "../lib/api";
import styles from "./Dashboard.module.css";

type CoreStatus = "checking" | "connected" | "offline";

interface DashboardProps {
  coreStatus: CoreStatus;
  coreError: string | null;
  schemaRequest: SchemaRequest | null;
  onCreatePage: () => void;
  onOpenDoc: (docId: string) => void;
  onOpenApps: () => void;
  onOpenData: () => void;
  onOpenActivity: () => void;
}

interface RecentEvent {
  id: string;
  source: string;
  type: string;
  started_at: number;
}

interface DashboardState {
  pages: api.Doc[];
  appCount: number;
  events: RecentEvent[];
  tableCount: number;
}

function relativeTime(epoch: number): string {
  const diff = Math.floor((Date.now() - epoch) / 1000);
  if (diff < 5) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function Dashboard({
  coreStatus,
  coreError,
  schemaRequest,
  onCreatePage,
  onOpenDoc,
  onOpenApps,
  onOpenData,
  onOpenActivity,
}: DashboardProps) {
  const [state, setState] = useState<DashboardState>({
    pages: [],
    appCount: 0,
    events: [],
    tableCount: 0,
  });

  useEffect(() => {
    if (coreStatus !== "connected") return;
    let cancelled = false;

    async function load() {
      try {
        const [docsResult, appsResult, eventsResult, tablesResult] = await Promise.all([
          api.listDocs(),
          api.listApps(),
          api.query("SELECT id, source, type, started_at FROM events ORDER BY created_at DESC LIMIT 6"),
          api.query("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
        ]);
        if (cancelled) return;
        setState({
          pages: docsResult.rows as api.Doc[],
          appCount: appsResult.apps.length,
          events: eventsResult.rows as RecentEvent[],
          tableCount: Number((tablesResult.rows[0] as { count?: number })?.count ?? 0),
        });
      } catch (err) {
        console.error("[Dashboard] Load failed:", err);
      }
    }

    load();
    const id = window.setInterval(load, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [coreStatus]);

  const recentPages = useMemo(() => state.pages.slice(0, 5), [state.pages]);
  const coreLabel =
    coreStatus === "connected" ? "Core connected" : coreStatus === "checking" ? "Checking core" : "Core offline";

  return (
    <div className={styles.dashboard}>
      <header className={styles.hero}>
        <div>
          <div className={styles.kicker}>Adiabatic OS</div>
          <h1>Personal substrate</h1>
          <p>Pages, apps, data, and schema changes in one local-first workspace.</p>
        </div>
        <div className={`${styles.statusPill} ${coreStatus === "connected" ? styles.ok : styles.warn}`}>
          <span />
          {coreLabel}
        </div>
      </header>

      {coreStatus === "offline" && (
        <div className={styles.notice}>
          <strong>Core is not reachable.</strong>
          <span>{coreError ?? "Start the core server on localhost:3000 to use workspace data."}</span>
        </div>
      )}

      {schemaRequest && (
        <div className={styles.notice}>
          <strong>Schema approval pending.</strong>
          <span>{schemaRequest.kind} requested by {schemaRequest.requestedBy}</span>
        </div>
      )}

      <section className={styles.metrics}>
        <button className={styles.metric} onClick={() => recentPages[0] && onOpenDoc(recentPages[0].id)}>
          <span className={styles.metricValue}>{state.pages.length}</span>
          <span className={styles.metricLabel}>Pages</span>
        </button>
        <button className={styles.metric} onClick={onOpenApps}>
          <span className={styles.metricValue}>{state.appCount}</span>
          <span className={styles.metricLabel}>Apps</span>
        </button>
        <button className={styles.metric} onClick={onOpenData}>
          <span className={styles.metricValue}>{state.tableCount}</span>
          <span className={styles.metricLabel}>Tables</span>
        </button>
        <button className={styles.metric} onClick={onOpenActivity}>
          <span className={styles.metricValue}>{state.events.length}</span>
          <span className={styles.metricLabel}>Recent events</span>
        </button>
      </section>

      <section className={styles.actions}>
        <button className={styles.primaryAction} onClick={onCreatePage}>
          New page
        </button>
        <button onClick={() => recentPages[0] && onOpenDoc(recentPages[0].id)} disabled={recentPages.length === 0}>
          Open recent page
        </button>
        <button onClick={onOpenApps}>Open Apps</button>
        <button onClick={onOpenData}>Open Data</button>
        <button onClick={onOpenActivity}>Open Activity</button>
      </section>

      <div className={styles.columns}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Recent Pages</h2>
          </div>
          {recentPages.length === 0 ? (
            <div className={styles.empty}>No pages yet.</div>
          ) : (
            <div className={styles.list}>
              {recentPages.map((page) => (
                <button key={page.id} className={styles.row} onClick={() => onOpenDoc(page.id)}>
                  <span>{page.id}</span>
                  <small>{relativeTime(page.updated_at)} ago</small>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Activity</h2>
            <button onClick={onOpenActivity}>Open</button>
          </div>
          {state.events.length === 0 ? (
            <div className={styles.empty}>No D0 activity yet.</div>
          ) : (
            <div className={styles.list}>
              {state.events.map((event) => (
                <button key={event.id} className={styles.row} onClick={onOpenActivity}>
                  <span>{event.type}</span>
                  <small>{event.source} · {relativeTime(event.started_at)} ago</small>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
