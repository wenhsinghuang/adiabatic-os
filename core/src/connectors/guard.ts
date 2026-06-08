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
  const guard = rootGuard.withSource(sourceForConnector(connectorId, integrationKey));
  return {
    async writeEvent(event: ConnectorEventInput): Promise<{ id: string }> {
      validateConnectorEvent(event);
      return { id: guard.writeEvent(event) };
    },
    async writeEvents(events: ConnectorEventInput[]): Promise<{ ids: string[] }> {
      for (const event of events) validateConnectorEvent(event);
      return { ids: events.map((event) => guard.writeEvent(event)) };
    },
  };
}
