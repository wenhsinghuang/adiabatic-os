// useApps — fetch and manage app list.

import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";

export function useApps() {
  const [apps, setApps] = useState<api.AppInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchApps = useCallback(async () => {
    try {
      const result = await api.listApps();
      setApps(result.apps);
      setLoading(false);
    } catch (err) {
      console.error("[useApps] Fetch failed:", err);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  return { apps, loading, refresh: fetchApps };
}
