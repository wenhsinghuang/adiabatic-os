// useDoc — fetch and save a single document.

import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../lib/api";

export function useDoc(docId: string) {
  const [doc, setDoc] = useState<api.Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentId = useRef(docId);

  useEffect(() => {
    currentId.current = docId;
    setLoading(true);
    setError(null);

    api
      .getDoc(docId)
      .then((d) => {
        if (currentId.current !== docId) return; // stale
        setDoc(d);
        setLoading(false);
      })
      .catch((err) => {
        if (currentId.current !== docId) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [docId]);

  const save = useCallback(
    (content: string, metadata?: Record<string, unknown>) => {
      api.saveDoc(docId, content, metadata).catch((err) => {
        console.error("[useDoc] Save failed:", err);
      });
    },
    [docId],
  );

  return { doc, loading, error, save };
}
