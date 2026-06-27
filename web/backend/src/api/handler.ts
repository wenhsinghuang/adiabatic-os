import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { getConfig } from "./config";
import { errorResponse, json, problem, routeKey } from "./http";
import { requireLamarckUser } from "./identity";

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
    const user = await requireLamarckUser(event);
    return json(200, {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      imageUrl: user.imageUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  }

  if (key === "POST /providers/{providerId}/connect/start") {
    const user = await requireLamarckUser(event);
    return problem(501, "managed_provider_connect_not_implemented", "Managed provider connect start is not implemented in this build.", {
      providerId,
      userId: user.userId,
      appOrigin: config.appOrigin,
      apiOrigin: config.apiOrigin,
    });
  }

  if (
    key === "GET /providers/{providerId}/oauth/callback" ||
    key === "POST /providers/{providerId}/oauth/callback"
  ) {
    return problem(501, "managed_provider_callback_not_implemented", "Managed provider OAuth callback handling is not implemented in this build.", {
      providerId,
    });
  }

  if (key.includes("/providers/{providerId}/{proxy+}")) {
    const user = await requireLamarckUser(event);
    return problem(501, "managed_provider_proxy_not_implemented", "Managed provider proxy is not implemented in this build.", {
      providerId,
      userId: user.userId,
      proxy: event.pathParameters?.proxy ?? null,
    });
  }

  return problem(404, "not_found", "Route not found.", {
    routeKey: key,
  });
}
