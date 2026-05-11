import { useEffect, useState } from "react";
import { listApps } from "../lib/api";
import { getAppUrl, prepareRuntime, reloadApp } from "../sandbox/webcontainer";
import styles from "./ContentArea.module.css";

interface AppRuntimeViewProps {
  appId: string;
}

export function AppRuntimeView({ appId }: AppRuntimeViewProps) {
  const [url, setUrl] = useState<string | null>(() => getAppUrl(appId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    async function refresh() {
      try {
        const { apps } = await listApps();
        await prepareRuntime(apps);
        await reloadApp(appId);
        if (!cancelled) setUrl(getAppUrl(appId));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    refresh();
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (error) {
    return <div className={styles.error}>App runtime error: {error}</div>;
  }

  if (!url) {
    return <div className={styles.loading}>Loading app...</div>;
  }

  return (
    <iframe
      title={appId}
      src={url}
      sandbox="allow-scripts allow-forms allow-same-origin"
      style={{
        width: "100%",
        height: "100%",
        border: 0,
        background: "white",
      }}
    />
  );
}
