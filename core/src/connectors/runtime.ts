import type {
  ConnectorDefinition,
  ConnectorEventInput,
  ConnectorRunContext,
} from "./types";
import { assertJsonValue } from "../json";

export interface ConnectorRuntimeOptions<TConfig, TState> {
  definition: ConnectorDefinition<TConfig, TState>;
  context: ConnectorRunContext<TConfig, TState>;
}

export class ConnectorRuntime<TConfig = unknown, TState = unknown> {
  constructor(private opts: ConnectorRuntimeOptions<TConfig, TState>) {}

  async run(): Promise<void> {
    await this.opts.definition.run(this.opts.context);
  }
}

export function validateConnectorDefinition(definition: ConnectorDefinition): void {
  if (!definition || typeof definition.run !== "function") {
    throw new Error("Connector module must export a run(context) function");
  }
}

export function validateConnectorEvent(event: ConnectorEventInput): void {
  if (!event.type || event.type.trim() !== event.type) {
    throw new Error("Connector event requires a type");
  }
  if (!event.externalId || event.externalId.trim() !== event.externalId) {
    throw new Error("Connector event requires an externalId");
  }
  if (!Number.isFinite(event.startedAt)) {
    throw new Error("Connector event requires a finite startedAt timestamp");
  }
  if (event.endedAt !== undefined && !Number.isFinite(event.endedAt)) {
    throw new Error("Connector event endedAt must be finite when provided");
  }
  assertJsonValue(event.payload, "Connector event payload");
}
