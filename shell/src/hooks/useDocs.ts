// useDocs — list all docs for the sidebar. Polls every 2s.

import { useState, useEffect, useRef } from "react";
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

  useEffect(() => {
    async function fetch() {
      try {
        const result = await api.listDocs();
        setDocs(result.rows as unknown as DocEntry[]);
        setLoading(false);
      } catch (err) {
        console.error("[useDocs] Fetch failed:", err);
      }
    }

    fetch();
    intervalRef.current = setInterval(fetch, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { docs, loading };
}
