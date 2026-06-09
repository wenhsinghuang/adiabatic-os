import type { Guard } from "../guard";
import type { BoundConnectorGuard, ConnectorEventInput } from "./types";
import { validateConnectorId, validateIntegrationKey } from "./manifest";
import { validateConnectorEvent } from "./runtime";

export function sourceForConnector(connectorId: string, integrationKey?: string): string {
  validateConnectorId(connectorId);
  if (integrationKey !== undefined) {
    validateIntegrationKey(integrationKey);
  }
  return `connector:${connectorId}${integrationKey ? `:${integrationKey}` : ""}`;
}

export function createBoundConnectorGuard(
  rootGuard: Guard,
  connectorId: string,
  integrationKey?: string,
): BoundConnectorGuard {
  const source = sourceForConnector(connectorId, integrationKey);
  const guard = rootGuard.withSource(source);
  return {
    async writeEvent(event: ConnectorEventInput): Promise<{ id: string }> {
      validateConnectorEvent(event);
      return { id: writeConnectorEvent(rootGuard, guard, source, event) };
    },
    async writeEvents(events: ConnectorEventInput[]): Promise<{ ids: string[] }> {
      const ids: string[] = [];
      for (const event of events) {
        validateConnectorEvent(event);
        ids.push(writeConnectorEvent(rootGuard, guard, source, event));
      }
      return { ids };
    },
  };
}

function writeConnectorEvent(
  rootGuard: Guard,
  guard: Guard,
  source: string,
  event: ConnectorEventInput,
): string {
  const existing = findExistingConnectorEvent(rootGuard, source, event.externalId);
  if (existing) return existing;

  try {
    return guard.writeEvent(event);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const duplicate = findExistingConnectorEvent(rootGuard, source, event.externalId);
      if (duplicate) return duplicate;
    }
    throw err;
  }
}

function findExistingConnectorEvent(rootGuard: Guard, source: string, externalId: string): string | undefined {
  const row = rootGuard.queryOne(
    "SELECT id FROM events WHERE source = ? AND external_id = ?",
    [source, externalId],
  ) as { id?: unknown } | null;
  return row && typeof row.id === "string" ? row.id : undefined;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  return message.includes("UNIQUE constraint failed") && message.includes("events.source");
}
