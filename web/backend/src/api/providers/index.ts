import { HttpError } from "../http";
import oura from "./oura";
import type { ManagedProviderModule } from "./types";

const providerModules = {
  oura,
} satisfies Record<string, ManagedProviderModule>;

export function getManagedProvider(providerId: string | null): ManagedProviderModule {
  if (!providerId) {
    throw new HttpError(400, "missing_provider_id", "Missing managed provider id.");
  }

  const provider = providerModules[providerId as keyof typeof providerModules];
  if (!provider) {
    throw new HttpError(404, "managed_provider_not_found", "Managed provider is not registered.", {
      providerId,
    });
  }

  return provider;
}

export function listManagedProviders(): ManagedProviderModule[] {
  return Object.values(providerModules).sort((a, b) =>
    a.metadata.providerId.localeCompare(b.metadata.providerId),
  );
}
