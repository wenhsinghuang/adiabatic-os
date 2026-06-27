import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

export function problem(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): APIGatewayProxyStructuredResultV2 {
  return json(statusCode, {
    error: code,
    message,
    ...(details ? { details } : {}),
  });
}

export function errorResponse(error: unknown): APIGatewayProxyStructuredResultV2 {
  if (error instanceof HttpError) {
    return problem(error.statusCode, error.code, error.message, error.details);
  }

  console.error("Unhandled API error", error);
  return problem(500, "internal_error", "Internal server error.");
}

export function routeKey(event: APIGatewayProxyEventV2): string {
  return event.routeKey || `${event.requestContext.http.method} ${event.rawPath}`;
}

export function bearerToken(event: APIGatewayProxyEventV2): string | null {
  const header =
    event.headers.authorization ?? event.headers.Authorization ?? event.headers.AUTHORIZATION;
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
