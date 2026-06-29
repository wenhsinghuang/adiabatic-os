import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { getConfig } from "./config";
import {
  authorizeDesktop,
  exchangeDesktopToken,
  isDesktopAccessToken,
  requireDesktopUser,
  revokeDesktopSession,
} from "./desktop-auth";
import { bearerToken, errorResponse, json, problem, routeKey } from "./http";
import { requireLamarckUser } from "./identity";
import {
  issueManagedProviderCapabilityToken,
  requireIntegrationId,
  requireManagedProviderCapability,
} from "./managed-provider-auth";
import { getManagedProvider, listManagedProviders } from "./providers";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    return await route(event);
  } catch (error) {
    return errorResponse(error);
  }
}

async function route(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const key = routeKey(event);
  const providerId = event.pathParameters?.providerId ?? null;
  const config = getConfig();

  if (key === "GET /healthz") {
    return json(200, {
      ok: true,
      service: "lamarck-api",
      env: config.appEnv,
    });
  }

  if (key === "GET /me") {
    const token = bearerToken(event);
    const user = isDesktopAccessToken(token)
      ? await requireDesktopUser(event)
      : await requireLamarckUser(event);
    return json(200, {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      imageUrl: user.imageUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  }

  if (key === "POST /desktop/auth/authorize") {
    return json(200, await authorizeDesktop(event));
  }

  if (key === "POST /desktop/auth/token") {
    return json(200, await exchangeDesktopToken(event));
  }

  if (key === "POST /desktop/auth/logout") {
    return json(200, await revokeDesktopSession(event));
  }

  if (key === "GET /providers") {
    return json(200, {
      providers: listManagedProviders().map((provider) => ({
        providerId: provider.metadata.providerId,
        displayName: provider.metadata.displayName,
        capability: provider.metadata.capability,
        apiBasePath: provider.metadata.apiBasePath,
        connect: {
          type: provider.metadata.connect.type,
          enabled: provider.metadata.connect.enabled,
          scopes: provider.metadata.connect.scopes,
        },
      })),
    });
  }

  if (key === "POST /providers/{providerId}/connect/start") {
    const user = await requireLamarckUser(event);
    const provider = getManagedProvider(providerId);
    const body = readJsonBody<{ integrationId?: string }>(event);
    const integrationId = requireIntegrationId(body.integrationId);
    return json(200, await provider.connect.start({ user, event, integrationId }));
  }

  if (key === "POST /providers/{providerId}/capability-token") {
    const provider = getManagedProvider(providerId);
    return json(200, await issueManagedProviderCapabilityToken(event, provider.metadata));
  }

  if (
    key === "GET /providers/{providerId}/oauth/callback" ||
    key === "POST /providers/{providerId}/oauth/callback"
  ) {
    const provider = getManagedProvider(providerId);
    return provider.connect.callback({ event });
  }

  if (key.includes("/providers/{providerId}/{proxy+}")) {
    const provider = getManagedProvider(providerId);
    const capability = await requireManagedProviderCapability(event, provider.metadata);
    return json(200, await provider.proxy({ capability, event }));
  }

  return problem(404, "not_found", "Route not found.", {
    routeKey: key,
  });
}

function readJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(text) as T;
}
