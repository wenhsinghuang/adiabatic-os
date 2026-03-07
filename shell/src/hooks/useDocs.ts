// useDocs — list all docs for the sidebar. Polls every 2s.
// Exposes refresh() for immediate re-fetch after create/delete/rename.

import { useState, useEffect, useRef, useCallback } from "react";
import * as api from "../lib/api";

export interface DocEntry {
  id: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

export function useDocs() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDocs = useCallback(async () => {
    try {
      const result = await api.listDocs();
      setDocs(result.rows as unknown as DocEntry[]);
      setLoading(false);
    } catch (err) {
      console.error("[useDocs] Fetch failed:", err);
    }
  }, []);

  useEffect(() => {
    fetchDocs();
    intervalRef.current = setInterval(fetchDocs, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchDocs]);

  return { docs, loading, refresh: fetchDocs };
}
