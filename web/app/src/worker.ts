interface Env {
  ASSETS: Fetcher;
  CLERK_PUBLISHABLE_KEY?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function withRuntimeConfig(response: Response, env: Env): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;

  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(
    html.replaceAll("__CLERK_PUBLISHABLE_KEY__", env.CLERK_PUBLISHABLE_KEY ?? ""),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurityHeaders(await withRuntimeConfig(await env.ASSETS.fetch(request), env));
  },
};
