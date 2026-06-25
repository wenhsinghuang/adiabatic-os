// useDoc — fetch and save a single document.
// Subscribes to SSE for real-time external change detection.

import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../lib/api";

export function useDoc(docId: string) {
  const [doc, setDoc] = useState<api.Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentId = useRef(docId);
  // Track what we last saved, to avoid overwriting local edits with our own write
  const lastSavedContent = useRef<string | null>(null);

  // Initial fetch
  useEffect(() => {
    currentId.current = docId;
    lastSavedContent.current = null;
    setLoading(true);
    setError(null);

    api
      .getDoc(docId)
      .then((d) => {
        if (currentId.current !== docId) return;
        setDoc(d);
        setLoading(false);
      })
      .catch((err) => {
        if (currentId.current !== docId) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [docId]);

  // SSE subscription for external changes (debounced to handle fs.watch bursts)
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = api.subscribeDocEvents(
      (data) => {
        if (data.id !== docId || currentId.current !== docId) return;

        // Debounce: fs.watch often fires multiple events for one edit
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          api.getDoc(docId).then((d) => {
            if (currentId.current !== docId) return;
            // Skip if content matches what we just saved (our own write)
            if (d.content === lastSavedContent.current) return;
            setDoc(d);
          }).catch(() => {});
        }, 300);
      },
      (err) => console.error("[useDoc] Event stream failed:", err),
    );

    return () => {
      unsubscribe();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [docId]);

  const save = useCallback(
    (content: string, metadata?: Record<string, unknown>) => {
      lastSavedContent.current = content;
      // Optimistically update local state so rendered view reflects edits
      setDoc((prev) => (prev ? { ...prev, content } : prev));
      api.saveDoc(docId, content, metadata).catch((err) => {
        console.error("[useDoc] Save failed:", err);
      });
    },
    [docId],
  );

  return { doc, loading, error, save };
}
