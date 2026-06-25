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
      service: "lamarck-auth",
      env: process.env.APP_ENV,
    });
  }

  if (routeKey === "GET /connect/{providerId}") {
    return json(501, {
      error: "managed_provider_connect_not_implemented",
      message: "Managed provider connect is not implemented in this build.",
      providerId,
      authOrigin: process.env.LAMARCK_AUTH_ORIGIN,
      apiOrigin: process.env.LAMARCK_API_ORIGIN,
    });
  }

  if (routeKey === "GET /oauth/{providerId}/callback" || routeKey === "POST /oauth/{providerId}/callback") {
    return json(501, {
      error: "managed_provider_callback_not_implemented",
      message: "Managed provider OAuth callback handling is not implemented in this build.",
      providerId,
    });
  }

  return json(404, {
    error: "not_found",
    routeKey,
  });
};
