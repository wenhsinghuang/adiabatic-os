// TerminalPanel — xterm.js terminal connected to core PTY via WebSocket.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalPanel.module.css";

const WS_URL = "ws://localhost:3000/api/terminal";

interface TerminalPanelProps {
  visible: boolean;
}

type TerminalStatus = "connecting" | "connected" | "disconnected" | "error";

export function TerminalPanel({ visible }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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

    // Connect WebSocket
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setStatus("connected");
      // Send initial size to PTY
      sendResize(ws, term.cols, term.rows);
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

    // Send input to WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Send resize events when terminal dimensions change
    term.onResize(({ cols, rows }) => {
      sendResize(ws, cols, rows);
    });

    // Resize observer for fit
    const observer = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      try { fit.fit(); } catch {}
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      const ws = wsRef.current;
      if (!term || !fit || !ws) return;
      try {
        fit.fit();
        sendResize(ws, term.cols, term.rows);
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

/** Send a resize message (SOH + JSON) so the server can resize the PTY. */
function sendResize(ws: WebSocket, cols: number, rows: number) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send("\x01" + JSON.stringify({ cols, rows }));
  }
}
