// DataPanel — Timeline activity log + Supabase-style table explorer.

import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";
import styles from "./DataPanel.module.css";

interface EventRow {
  id: number;
  source: string;
  type: string;
  started_at: number;
  payload: string;
}

interface TableInfo {
  name: string;
  columns: { name: string; type: string; pk: number }[];
  rowCount: number | null;
}

// Pull the most useful fields from payload to show inline
function payloadSummary(payload: string): string[] {
  try {
    const p = JSON.parse(payload);
    const parts: string[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.length > 80) {
        parts.push(`${k}: ${v.slice(0, 60)}...`);
      } else if (typeof v === "object") {
        const s = JSON.stringify(v);
        parts.push(`${k}: ${s.length > 60 ? s.slice(0, 60) + "..." : s}`);
      } else {
        parts.push(`${k}: ${v}`);
      }
    }
    return parts;
  } catch {
    return [];
  }
}

function typeColor(type: string): string {
  if (type.includes("write") || type.includes("insert")) return "var(--color-accent)";
  if (type.includes("delete") || type.includes("demote")) return "#e06c75";
  if (type.includes("promote") || type.includes("create")) return "#98c379";
  return "var(--color-text-muted)";
}

interface DataPanelProps {
  onOpenTable: (tableName: string) => void;
  onOpenActivity: () => void;
}

export function DataPanel({ onOpenTable, onOpenActivity }: DataPanelProps) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [eventsResult, tablesResult] = await Promise.all([
        api.query(
          "SELECT id, source, type, started_at, payload FROM events ORDER BY created_at DESC LIMIT 50",
        ),
        api.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('events','docs','sqlite_sequence')",
        ),
      ]);
      setEvents(eventsResult.rows as EventRow[]);

      const tableNames = (tablesResult.rows as { name: string }[]).map((r) => r.name);
      const tableInfos: TableInfo[] = await Promise.all(
        tableNames.map(async (name) => {
          const [schemaResult, countResult] = await Promise.all([
            api.query(`PRAGMA table_info(${name})`),
            api.query(`SELECT COUNT(*) as count FROM ${name}`),
          ]);
          return {
            name,
            columns: (schemaResult.rows as { name: string; type: string; pk: number }[]).map(
              (r) => ({ name: r.name, type: r.type || "TEXT", pk: r.pk }),
            ),
            rowCount: (countResult.rows[0] as { count: number })?.count ?? null,
          };
        }),
      );
      setTables(tableInfos);
    } catch {
      // Tables may not exist yet on fresh workspace
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  function relativeTime(epoch: number): string {
    const now = Date.now();
    const diff = Math.floor((now - epoch) / 1000);
    if (diff < 5) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>Data</span>
        </div>
        <div className={styles.loading}>Loading...</div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Data</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} title="Refresh" onClick={fetchData}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.527 1.225.527 1.924a4.008 4.008 0 0 1-4.5 3.969l.008-.047L6.3 13.499l.093.009A5.993 5.993 0 0 0 14.255 7.5a5.965 5.965 0 0 0-.804-1.891zM8 2.5a5.981 5.981 0 0 0-4.255 1.778l-.451-.312.579.939.804 1.891 1.068-.812.076-.094A4.007 4.007 0 0 1 10.5 4.031l-.008.047L11.7 2.501l-.093-.009A5.961 5.961 0 0 0 8 2.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tables */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Tables</span>
          <span className={styles.sectionCount}>{tables.length}</span>
        </div>
        <div className={styles.tableList}>
          {tables.length === 0 ? (
            <div className={styles.empty}>
              No tables yet.
              <br />
              Apps create tables via system.write()
            </div>
          ) : (
            tables.map((table) => {
              const isExpanded = expandedTable === table.name;
              return (
                <div key={table.name} className={styles.tableGroup}>
                  <div
                    className={`${styles.tableItem} ${isExpanded ? styles.tableItemActive : ""}`}
                    onClick={() => setExpandedTable(isExpanded ? null : table.name)}
                    onDoubleClick={() => onOpenTable(table.name)}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className={styles.tableIcon}>
                      <path d="M14 1H2a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 2h12v3H2V2zm0 4h5v4H2V6zm0 5h5v3H2v-3zm6 3V6h6v8H8z" />
                    </svg>
                    <span className={styles.tableName}>{table.name}</span>
                    <span className={styles.rowCount}>
                      {table.rowCount !== null ? `${table.rowCount} rows` : ""}
                    </span>
                  </div>
                  {isExpanded && (
                    <div className={styles.schemaGrid}>
                      <div className={styles.schemaHeader}>
                        <span>Column</span>
                        <span>Type</span>
                      </div>
                      {table.columns.map((col) => (
                        <div key={col.name} className={styles.schemaRow}>
                          <span className={styles.colName}>
                            {col.name}
                            {col.pk ? <span className={styles.pkBadge}>PK</span> : null}
                          </span>
                          <span className={styles.colType}>{col.type}</span>
                        </div>
                      ))}
                      <div
                        className={styles.openLink}
                        onClick={(e) => { e.stopPropagation(); onOpenTable(table.name); }}
                      >
                        Open table →
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Activity */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Activity</span>
          <span
            className={styles.openAllLink}
            onClick={onOpenActivity}
          >
            Open →
          </span>
        </div>
        <div className={styles.timeline}>
          {events.length === 0 ? (
            <div className={styles.empty}>No activity yet.</div>
          ) : (
            events.slice(0, 10).map((evt) => {
              const summary = payloadSummary(evt.payload);
              return (
                <div
                  key={evt.id}
                  className={styles.timelineItem}
                  onClick={onOpenActivity}
                >
                  <div className={styles.timelineDot} style={{ background: typeColor(evt.type) }} />
                  <div className={styles.timelineContent}>
                    <div className={styles.timelineTop}>
                      <span className={styles.timelineType}>{evt.type}</span>
                      <span className={styles.timelineTime}>{relativeTime(evt.started_at)}</span>
                    </div>
                    {summary.length > 0 && (
                      <span className={styles.timelinePreview}>{summary[0]}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
