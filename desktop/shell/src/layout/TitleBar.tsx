// TitleBar — brand name + breadcrumb for active document.

import type { LamarckSessionView } from "../lib/api";
import styles from "./TitleBar.module.css";

interface TitleBarProps {
  activeDocId: string | null;
  lamarckSession: LamarckSessionView;
  identityBusy: boolean;
  onIdentitySignIn: () => void;
  onIdentitySignOut: () => void;
}

export function TitleBar({
  activeDocId,
  lamarckSession,
  identityBusy,
  onIdentitySignIn,
  onIdentitySignOut,
}: TitleBarProps) {
  const signedIn = lamarckSession.status === "signed_in";
  const identityLabel = signedIn
    ? "Signed in"
    : lamarckSession.status === "expired"
      ? "Session expired"
      : "Sign in";

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
      <button
        type="button"
        className={signedIn ? styles.identitySignedIn : styles.identityButton}
        disabled={identityBusy}
        onClick={signedIn ? onIdentitySignOut : onIdentitySignIn}
        title={signedIn ? "Sign out of Lamarck" : "Sign in to Lamarck"}
      >
        {identityBusy ? "..." : identityLabel}
      </button>
    </div>
  );
}
