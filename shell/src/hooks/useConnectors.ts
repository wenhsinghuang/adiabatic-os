// useConnectors — polls the core connector + available lists while mounted.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  listAvailableConnectors,
  listConnectors,
  type AvailableConnectorView,
  type ConnectorIntegrationView,
} from "../lib/api";

export function useConnectors(pollMs = 2000) {
  const [connectors, setConnectors] = useState<ConnectorIntegrationView[]>([]);
  const [available, setAvailable] = useState<AvailableConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [{ connectors }, { available }] = await Promise.all([
        listConnectors(),
        listAvailableConnectors(),
      ]);
      if (!aliveRef.current) return;
      setConnectors(connectors);
      setAvailable(available);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const id = window.setInterval(refresh, pollMs);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { connectors, available, loading, error, refresh };
}
