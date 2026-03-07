// TitleBar — brand name + breadcrumb for active document.

import styles from "./TitleBar.module.css";

interface TitleBarProps {
  activeDocId: string | null;
}

export function TitleBar({ activeDocId }: TitleBarProps) {
  return (
    <div className={styles.titleBar}>
      <div className={styles.brand}>Adiabatic</div>
      {activeDocId && (
        <div className={styles.breadcrumb}>
          {activeDocId.split("/").map((part, i, arr) => (
            <span key={i}>
              {i > 0 && <span className={styles.sep}>/</span>}
              <span className={i === arr.length - 1 ? styles.active : undefined}>
                {part}
              </span>
            </span>
          ))}
        </div>
      )}
      <div className={styles.spacer} />
    </div>
  );
}
