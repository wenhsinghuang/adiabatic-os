"use strict";

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const routeKey = event.routeKey || "";
  const providerId = event.pathParameters?.providerId || null;

  if (routeKey === "GET /healthz") {
    return json(200, {
      ok: true,
      service: "lamarck-api",
      env: process.env.APP_ENV,
    });
  }

  if (routeKey === "GET /me") {
    return json(501, {
      error: "identity_not_implemented",
      message: "Clerk identity verification and user upsert are not implemented in this build.",
    });
  }

  if (routeKey === "POST /providers/{providerId}/connect/start") {
    return json(501, {
      error: "managed_provider_connect_not_implemented",
      message: "Managed provider connect start is not implemented in this build.",
      providerId,
      appOrigin: process.env.LAMARCK_APP_ORIGIN,
      apiOrigin: process.env.LAMARCK_API_ORIGIN,
    });
  }

  if (
    routeKey === "GET /providers/{providerId}/oauth/callback" ||
    routeKey === "POST /providers/{providerId}/oauth/callback"
  ) {
    return json(501, {
      error: "managed_provider_callback_not_implemented",
      message: "Managed provider OAuth callback handling is not implemented in this build.",
      providerId,
    });
  }

  if (routeKey.includes("/providers/{providerId}/{proxy+}")) {
    return json(501, {
      error: "managed_provider_proxy_not_implemented",
      message: "Managed provider proxy is not implemented in this build.",
      providerId,
      proxy: event.pathParameters?.proxy || null,
    });
  }

  return json(404, {
    error: "not_found",
    routeKey,
  });
};
