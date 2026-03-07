// Shell — top-level CSS Grid layout (VS Code-inspired).
//
// ┌─────────────────────────────────────────────────┐
// │ TitleBar                                         │
// ├────┬──────────┬─────────────────────────────────┤
// │ AB │ Sidebar  │ TabBar                           │
// │    │          ├─────────────────────────────────┤
// │    │          │ ContentArea                     │
// │    │          ├─────────────────────────────────┤
// │    │          │ TerminalPanel (collapsible)     │
// └────┴──────────┴─────────────────────────────────┘

import { type ReactNode, useState, useCallback, useRef } from "react";
import styles from "./Shell.module.css";

interface ShellProps {
  titleBar: ReactNode;
  activityBar: ReactNode;
  sidebar: ReactNode;
  tabBar: ReactNode;
  content: ReactNode;
  terminal: ReactNode;
  showTerminal: boolean;
}

export function Shell({
  titleBar,
  activityBar,
  sidebar,
  tabBar,
  content,
  terminal,
  showTerminal,
}: ShellProps) {
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [terminalHeight, setTerminalHeight] = useState(250);
  const draggingRef = useRef<"sidebar" | "terminal" | null>(null);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (draggingRef.current === "sidebar") {
      // activityBar is 48px (--activity-bar-width)
      const newWidth = Math.min(480, Math.max(160, e.clientX - 48));
      setSidebarWidth(newWidth);
    } else if (draggingRef.current === "terminal") {
      const maxH = window.innerHeight * 0.5;
      const newHeight = Math.min(maxH, Math.max(100, window.innerHeight - e.clientY));
      setTerminalHeight(newHeight);
    }
  }, []);

  const onMouseUp = useCallback(() => {
    draggingRef.current = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [onMouseMove]);

  const startSidebarResize = useCallback(() => {
    draggingRef.current = "sidebar";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [onMouseMove, onMouseUp]);

  const startTerminalResize = useCallback(() => {
    draggingRef.current = "terminal";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [onMouseMove, onMouseUp]);

  return (
    <div className={styles.shell} style={{
      gridTemplateColumns: `var(--activity-bar-width) ${sidebarWidth}px 4px 1fr`,
    }}>
      <div className={styles.titleBar}>{titleBar}</div>
      <div className={styles.activityBar}>{activityBar}</div>
      <div className={styles.sidebar}>{sidebar}</div>
      <div className={styles.sidebarSplitter} onMouseDown={startSidebarResize} />
      <div className={styles.main}>
        <div className={styles.tabBar}>{tabBar}</div>
        <div className={styles.content}>{content}</div>
        {showTerminal && (
          <>
            <div className={styles.terminalSplitter} onMouseDown={startTerminalResize} />
            <div className={styles.terminal} style={{ height: terminalHeight }}>
              {terminal}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
