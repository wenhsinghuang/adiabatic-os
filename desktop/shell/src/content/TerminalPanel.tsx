// TerminalPanel — xterm.js terminal connected to Electron PTY or browser dev WebSocket.

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getCoreBaseUrl } from "../lib/api";
import styles from "./TerminalPanel.module.css";

interface TerminalPanelProps {
  visible: boolean;
}

type TerminalStatus = "connecting" | "connected" | "disconnected" | "error";

export function TerminalPanel({ visible }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeRef = useRef<(cols: number, rows: number) => void>(() => {});
  const visibleRef = useRef(visible);
  const [status, setStatus] = useState<TerminalStatus>("connecting");

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#aeafad",
        selectionBackground: "#264f78",
      },
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const disposeTransport = window.adiabaticHost?.createTerminal
      ? connectElectronTerminal(term, setStatus, resizeRef)
      : connectWebSocketTerminal(term, setStatus, resizeRef);

    // Resize observer for fit
    const observer = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      try { fit.fit(); } catch {}
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      disposeTransport();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      resizeRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        resizeRef.current(term.cols, term.rows);
        term.focus();
      } catch {
        // xterm can throw while the container is being reattached after a resize.
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [visible]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Terminal</span>
        <span className={`${styles.status} ${styles[status]}`}>{status}</span>
      </div>
      <div className={styles.terminal} ref={containerRef} />
    </div>
  );
}

function connectElectronTerminal(
  term: Terminal,
  setStatus: (status: TerminalStatus) => void,
  resizeRef: MutableRefObject<(cols: number, rows: number) => void>,
): () => void {
  const host = window.adiabaticHost;
  if (!host) return () => {};

  let terminalId: string | null = null;
  const pendingData: string[] = [];

  const disposeData = host.onTerminalData(({ id, data }) => {
    if (terminalId === null) {
      pendingData.push(data);
      return;
    }
    if (id === terminalId) term.write(data);
  });

  const disposeExit = host.onTerminalExit(({ id }) => {
    if (id !== terminalId) return;
    setStatus("disconnected");
    term.writeln("\r\n\x1b[90m~ Terminal disconnected ~\x1b[0m");
  });

  const inputDisposable = term.onData((data) => {
    if (terminalId) host.writeTerminal(terminalId, data);
  });

  const resizeDisposable = term.onResize(({ cols, rows }) => {
    if (terminalId) host.resizeTerminal(terminalId, cols, rows);
  });

  host.createTerminal()
    .then(({ id }) => {
      terminalId = id;
      resizeRef.current = (cols, rows) => host.resizeTerminal(id, cols, rows);
      for (const data of pendingData.splice(0)) term.write(data);
      setStatus("connected");
      host.resizeTerminal(id, term.cols, term.rows);
    })
    .catch((err) => {
      setStatus("error");
      term.writeln(`\r\n\x1b[31m~ Terminal failed: ${String(err)} ~\x1b[0m`);
    });

  return () => {
    disposeData();
    disposeExit();
    inputDisposable.dispose();
    resizeDisposable.dispose();
    if (terminalId) {
      void host.disposeTerminal(terminalId);
    }
  };
}

function connectWebSocketTerminal(
  term: Terminal,
  setStatus: (status: TerminalStatus) => void,
  resizeRef: MutableRefObject<(cols: number, rows: number) => void>,
): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;

  void getCoreBaseUrl()
    .then((base) => {
      if (disposed) return;
      const url = new URL("/api/terminal", base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url.toString());
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setStatus("connected");
        if (ws) sendResize(ws, term.cols, term.rows);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
        } else {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        setStatus("disconnected");
        term.writeln("\r\n\x1b[90m~ Terminal disconnected ~\x1b[0m");
      };

      ws.onerror = () => {
        setStatus("error");
        term.writeln("\r\n\x1b[31m~ Connection error ~\x1b[0m");
      };
    })
    .catch((err) => {
      setStatus("error");
      term.writeln(`\r\n\x1b[31m~ Connection error: ${String(err)} ~\x1b[0m`);
    });

  const inputDisposable = term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  const resizeDisposable = term.onResize(({ cols, rows }) => {
    if (ws) sendResize(ws, cols, rows);
  });

  resizeRef.current = (cols, rows) => {
    if (ws) sendResize(ws, cols, rows);
  };

  return () => {
    disposed = true;
    inputDisposable.dispose();
    resizeDisposable.dispose();
    ws?.close();
  };
}

function sendResize(ws: WebSocket, cols: number, rows: number) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send("\x01" + JSON.stringify({ cols, rows }));
  }
}
