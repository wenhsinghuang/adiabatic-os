import { getConfig } from "../config";
import { HttpError } from "../http";
import type {
  ManagedProviderConnectStart,
  ManagedProviderContext,
  ManagedProviderMetadata,
  ManagedProviderProxyContext,
} from "./types";

export function notImplementedConnectStart(
  metadata: ManagedProviderMetadata,
  ctx: ManagedProviderContext,
): never {
  throw new HttpError(
    501,
    "managed_provider_connect_not_implemented",
    "Managed provider connect is registered but not implemented in this build.",
    connectDetails(metadata, ctx),
  );
}

export function notImplementedCallback(metadata: ManagedProviderMetadata): never {
  throw new HttpError(
    501,
    "managed_provider_callback_not_implemented",
    "Managed provider OAuth callback handling is not implemented in this build.",
    {
      providerId: metadata.providerId,
      displayName: metadata.displayName,
    },
  );
}

export function notImplementedProxy(
  metadata: ManagedProviderMetadata,
  ctx: ManagedProviderProxyContext,
): never {
  throw new HttpError(
    501,
    "managed_provider_proxy_not_implemented",
    "Managed provider proxy is not implemented in this build.",
    {
      providerId: metadata.providerId,
      userId: ctx.capability.userId,
      integrationId: ctx.capability.integrationId,
      proxy: ctx.event.pathParameters?.proxy ?? null,
    },
  );
}

function connectDetails(
  metadata: ManagedProviderMetadata,
  ctx: ManagedProviderContext,
): ManagedProviderConnectStart {
  return {
    providerId: metadata.providerId,
    displayName: metadata.displayName,
    capability: metadata.capability,
    status: "not_implemented",
    message: "Provider OAuth ceremony and token vaulting are pending backend implementation.",
    userId: ctx.user.userId,
    integrationId: ctx.integrationId,
    apiBaseUrl: `${getConfig().apiOrigin}${metadata.apiBasePath}`,
    scopes: metadata.connect.scopes,
  };
}
