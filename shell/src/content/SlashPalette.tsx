// SlashPalette — dropdown for inserting app components via `/` command.

import React, { useState, useEffect, useRef } from "react";
import styles from "./SlashPalette.module.css";

export interface SlashItem {
  appId: string;
  appName: string;
  componentName: string;
}

interface Props {
  items: SlashItem[];
  filter: string;
  position: { x: number; y: number };
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
}

export function SlashPalette({ items, filter, position, onSelect, onClose }: Props) {
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = items.filter(
    (it) =>
      it.componentName.toLowerCase().includes(filter.toLowerCase()) ||
      it.appName.toLowerCase().includes(filter.toLowerCase()),
  );

  useEffect(() => setIdx(0), [filter]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setIdx((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setIdx((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (filtered[idx]) onSelect(filtered[idx]);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [filtered, idx, onSelect, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  if (filtered.length === 0) {
    return (
      <div className={styles.palette} style={{ left: position.x, top: position.y }}>
        <div className={styles.empty}>No components found</div>
      </div>
    );
  }

  return (
    <div className={styles.palette} style={{ left: position.x, top: position.y }}>
      <div ref={listRef} className={styles.list}>
        {filtered.map((item, i) => (
          <div
            key={`${item.appId}/${item.componentName}`}
            className={`${styles.item} ${i === idx ? styles.selected : ""}`}
            onMouseEnter={() => setIdx(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
          >
            <span className={styles.name}>{item.componentName}</span>
            <span className={styles.app}>{item.appName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
