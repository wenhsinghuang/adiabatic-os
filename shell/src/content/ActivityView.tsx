// ActivityView — full-page timeline of D0 events with diff view for doc writes.

import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";
import styles from "./ActivityView.module.css";

interface EventRow {
  id: string;
  source: string;
  type: string;
  started_at: number;
  ended_at: number | null;
  payload: string;
}

// Simple line-level diff: returns array of { type: "same"|"add"|"del", text }
interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  // LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "same", text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: "del", text: oldLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

function parsePayload(payload: string): Record<string, unknown> {
  try { return JSON.parse(payload); } catch { return {}; }
}

function typeColor(type: string): string {
  if (type.includes("write") || type.includes("insert")) return "#007acc";
  if (type.includes("delete") || type.includes("demote")) return "#e06c75";
  if (type.includes("promote") || type.includes("create")) return "#98c379";
  if (type.includes("update")) return "#d19a66";
  return "#999";
}

const CONTEXT_LINES = 3;

// Filter diff to only show changed lines ± context, with separators
function withContext(lines: DiffLine[]): (DiffLine | "sep")[] {
  const changed = new Set<number>();
  lines.forEach((line, i) => {
    if (line.type !== "same") changed.add(i);
  });

  // Mark lines within context range of a change
  const visible = new Set<number>();
  for (const idx of changed) {
    for (let j = Math.max(0, idx - CONTEXT_LINES); j <= Math.min(lines.length - 1, idx + CONTEXT_LINES); j++) {
      visible.add(j);
    }
  }

  const result: (DiffLine | "sep")[] = [];
  let lastShown = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!visible.has(i)) continue;
    if (lastShown !== -1 && i - lastShown > 1) result.push("sep");
    result.push(lines[i]);
    lastShown = i;
  }
  return result;
}

// Compute line numbers for old/new sides
function lineNumbers(lines: DiffLine[]): { oldNum: number | null; newNum: number | null }[] {
  let oldLine = 1, newLine = 1;
  return lines.map((line) => {
    if (line.type === "same") return { oldNum: oldLine++, newNum: newLine++ };
    if (line.type === "del") return { oldNum: oldLine++, newNum: null };
    return { oldNum: null, newNum: newLine++ };
  });
}

function DiffBlock({ before, after }: { before: string | null; after: string }) {
  if (before === null) {
    // New doc — show first few lines as additions
    const lines = after.split("\n");
    const shown = lines.slice(0, 10);
    return (
      <div className={styles.diffBlock}>
        {shown.map((line, i) => (
          <div key={i} className={styles.diffAdd}>
            <span className={styles.diffLineNum}>{i + 1}</span>
            <span className={styles.diffSign}>+</span>
            <span>{line || "\u00A0"}</span>
          </div>
        ))}
        {lines.length > 10 && (
          <div className={styles.diffSep}>··· {lines.length - 10} more lines</div>
        )}
      </div>
    );
  }

  if (before === after) {
    return <div className={styles.diffEmpty}>No changes</div>;
  }

  const allLines = computeDiff(before, after);
  const nums = lineNumbers(allLines);
  const filtered = withContext(allLines);

  // Map filtered back to line numbers
  let allIdx = 0;
  return (
    <div className={styles.diffBlock}>
      {filtered.map((item, i) => {
        if (item === "sep") {
          return <div key={`sep-${i}`} className={styles.diffSep}>···</div>;
        }
        // Find this line's index in allLines to get line numbers
        while (allIdx < allLines.length && allLines[allIdx] !== item) allIdx++;
        const num = nums[allIdx] || { oldNum: null, newNum: null };
        allIdx++;
        return (
          <div
            key={i}
            className={
              item.type === "add" ? styles.diffAdd :
              item.type === "del" ? styles.diffDel :
              styles.diffSame
            }
          >
            <span className={styles.diffLineNum}>
              {item.type === "del" ? (num.oldNum ?? "") : (num.newNum ?? "")}
            </span>
            <span className={styles.diffSign}>
              {item.type === "add" ? "+" : item.type === "del" ? "-" : " "}
            </span>
            <span>{item.text || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}

function PayloadDetail({ type, payload, onOpenDoc }: { type: string; payload: Record<string, unknown>; onOpenDoc?: (docId: string) => void }) {
  // d1.write / d1.delete — show diff
  if ((type === "d1.write" || type === "d1.delete") && ("before" in payload || "after" in payload)) {
    const before = payload.before as string | null;
    const after = (payload.after ?? payload.content ?? "") as string;
    const docId = payload.doc_id as string;
    return (
      <div>
        <div className={styles.detailMeta}>
          <span
            className={onOpenDoc ? styles.docLink : undefined}
            onClick={onOpenDoc ? (e) => { e.stopPropagation(); onOpenDoc(docId); } : undefined}
          >
            {docId}
          </span>
          <span>{payload.bytes as number} bytes</span>
        </div>
        <DiffBlock before={before} after={after} />
      </div>
    );
  }

  // d2 / ddl — show SQL + params
  if (payload.sql) {
    return (
      <div>
        {typeof payload.table === "string" && (
          <div className={styles.detailMeta}>
            <span>table: {payload.table}</span>
          </div>
        )}
        <pre className={styles.sqlBlock}>{payload.sql as string}</pre>
        {Array.isArray(payload.params) && payload.params.length > 0 && (
          <div className={styles.paramsList}>
            params: [{payload.params.map((p: unknown) => JSON.stringify(p)).join(", ")}]
          </div>
        )}
      </div>
    );
  }

  // Generic fallback — key-value table
  return (
    <table className={styles.payloadTable}>
      <tbody>
        {Object.entries(payload).map(([k, v]) => (
          <tr key={k}>
            <td className={styles.detailKey}>{k}</td>
            <td className={styles.detailVal}>
              {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v ?? "null")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ActivityViewProps {
  onOpenDoc?: (docId: string) => void;
}

export function ActivityView({ onOpenDoc }: ActivityViewProps) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const result = await api.query(
        "SELECT id, source, type, started_at, ended_at, payload FROM events ORDER BY created_at DESC LIMIT 200",
      );
      setEvents(result.rows as EventRow[]);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  function formatTime(epoch: number): string {
    return new Date(epoch).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function relativeTime(epoch: number): string {
    const diff = Math.floor((Date.now() - epoch) / 1000);
    if (diff < 5) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function previewText(type: string, payload: Record<string, unknown>): string {
    if (payload.doc_id) return `${payload.doc_id}`;
    if (payload.table) return `${payload.table}`;
    return "";
  }

  if (loading) {
    return <div className={styles.center}>Loading...</div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Activity Log</span>
        <span className={styles.meta}>{events.length} events</span>
        <button className={styles.refreshBtn} onClick={fetchData} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.527 1.225.527 1.924a4.008 4.008 0 0 1-4.5 3.969l.008-.047L6.3 13.499l.093.009A5.993 5.993 0 0 0 14.255 7.5a5.965 5.965 0 0 0-.804-1.891zM8 2.5a5.981 5.981 0 0 0-4.255 1.778l-.451-.312.579.939.804 1.891 1.068-.812.076-.094A4.007 4.007 0 0 1 10.5 4.031l-.008.047L11.7 2.501l-.093-.009A5.961 5.961 0 0 0 8 2.5z" />
          </svg>
        </button>
      </div>
      <div className={styles.list}>
        {events.length === 0 ? (
          <div className={styles.empty}>No activity recorded yet.</div>
        ) : (
          events.map((evt) => {
            const isOpen = expandedId === evt.id;
            const payload = parsePayload(evt.payload);
            const preview = previewText(evt.type, payload);
            return (
              <div
                key={evt.id}
                className={`${styles.event} ${isOpen ? styles.eventOpen : ""}`}
                onClick={() => setExpandedId(isOpen ? null : evt.id)}
              >
                <div className={styles.eventRow}>
                  <span className={styles.dot} style={{ background: typeColor(evt.type) }} />
                  <span className={styles.eventType}>{evt.type}</span>
                  {preview && <span className={styles.eventTarget}>{preview}</span>}
                  <span className={styles.eventSource}>{evt.source}</span>
                  <span className={styles.eventTime} title={formatTime(evt.started_at)}>
                    {relativeTime(evt.started_at)}
                  </span>
                </div>
                {isOpen && (
                  <div className={styles.detail}>
                    <div className={styles.detailHeader}>
                      <span>{evt.id}</span>
                      <span>{formatTime(evt.started_at)}</span>
                    </div>
                    <PayloadDetail type={evt.type} payload={payload} onOpenDoc={onOpenDoc} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
