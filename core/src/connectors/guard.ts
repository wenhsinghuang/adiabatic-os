import type { Guard } from "../guard";
import type { BoundConnectorGuard, ConnectorEventInput } from "./types";
import { validateConnectorId } from "./manifest";
import { validateConnectorEvent } from "./runtime";

export function sourceForConnector(instanceId: string): string {
  validateConnectorId(instanceId);
  return `connector:${instanceId}`;
}

export function createBoundConnectorGuard(rootGuard: Guard, instanceId: string): BoundConnectorGuard {
  const guard = rootGuard.withSource(sourceForConnector(instanceId));
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
