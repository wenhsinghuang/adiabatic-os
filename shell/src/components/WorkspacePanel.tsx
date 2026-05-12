// WorkspacePanel — shows the active workspace and lets the Electron host switch it.

import { useCallback, useEffect, useState } from "react";
import { getWorkspace } from "../lib/api";
import styles from "./WorkspacePanel.module.css";

interface WorkspacePanelProps {
  coreStatus: "checking" | "connected" | "offline";
  onCoreChanged: () => void | Promise<void>;
}

export function WorkspacePanel({ coreStatus, onCoreChanged }: WorkspacePanelProps) {
  const [workspacePath, setWorkspacePath] = useState("");
  const [corePath, setCorePath] = useState("");
  const [hostPath, setHostPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasHost = Boolean(window.adiabaticHost);

  const refresh = useCallback(async () => {
    setError(null);
    setMessage(null);
    try {
      const [core, host] = await Promise.all([
        getWorkspace(),
        window.adiabaticHost?.getWorkspacePath().catch(() => "") ?? Promise.resolve(""),
      ]);
      setCorePath(core.path);
      setHostPath(host);
      setWorkspacePath(host || core.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const switchWorkspace = useCallback(
    async (nextPath: string) => {
      if (!window.adiabaticHost) return;
      const normalized = nextPath.trim();
      if (!normalized) {
        setError("Workspace path is required.");
        return;
      }
      setBusy(true);
      setError(null);
      setMessage("Switching workspace...");
      try {
        const result = await window.adiabaticHost.setWorkspacePath(normalized);
        setWorkspacePath(result.path);
        setHostPath(result.path);
        setCorePath(result.path);
        setMessage("Workspace switched. Reloading shell...");
        await onCoreChanged();
        window.setTimeout(() => window.location.reload(), 250);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setMessage(null);
      } finally {
        setBusy(false);
      }
    },
    [onCoreChanged],
  );

  const chooseWorkspace = useCallback(async () => {
    if (!window.adiabaticHost) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.adiabaticHost.chooseWorkspacePath();
      if (!result.path) return;
      setWorkspacePath(result.path);
      setHostPath(result.path);
      setCorePath(result.path);
      setMessage("Workspace switched. Reloading shell...");
      await onCoreChanged();
      window.setTimeout(() => window.location.reload(), 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onCoreChanged]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Workspace</span>
        <button className={styles.iconButton} title="Refresh" onClick={refresh}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.527 1.225.527 1.924a4.008 4.008 0 0 1-4.5 3.969l.008-.047L6.3 13.499l.093.009A5.993 5.993 0 0 0 14.255 7.5a5.965 5.965 0 0 0-.804-1.891zM8 2.5a5.981 5.981 0 0 0-4.255 1.778l-.451-.312.579.939.804 1.891 1.068-.812.076-.094A4.007 4.007 0 0 1 10.5 4.031l-.008.047L11.7 2.501l-.093-.009A5.961 5.961 0 0 0 8 2.5z" />
          </svg>
        </button>
      </div>

      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.label}>Core</div>
          <div className={styles.statusRow}>
            <span className={`${styles.dot} ${styles[coreStatus]}`} />
            <span className={styles.statusText}>{coreStatus}</span>
          </div>
          <div className={styles.pathBox} title={corePath || "Unknown"}>
            {corePath || "Unknown workspace"}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.label}>Path</div>
          <input
            className={styles.input}
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            readOnly={!hasHost || busy}
            spellCheck={false}
          />
          <div className={styles.buttonRow}>
            <button className={styles.button} onClick={chooseWorkspace} disabled={!hasHost || busy}>
              Choose Folder
            </button>
            <button
              className={styles.button}
              onClick={() => switchWorkspace(workspacePath)}
              disabled={!hasHost || busy || workspacePath.trim() === hostPath}
            >
              Apply
            </button>
          </div>
        </section>

        {!hasHost && (
          <p className={styles.note}>
            Workspace switching is available in the Electron shell. This browser session can still
            show the workspace that the local core is already running with.
          </p>
        )}

        {message && <div className={styles.message}>{message}</div>}
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  );
}
