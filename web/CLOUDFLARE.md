# Cloudflare Setup

This repo uses Cloudflare Workers for public frontend surfaces and AWS for the
backend API.

## Domains

| Domain | Owner | Purpose |
| --- | --- | --- |
| `lamarck.ai` | Cloudflare Worker `lamarck-landing` | Public landing page |
| `www.lamarck.ai` | Cloudflare Worker `lamarck-landing` | Redirects to `lamarck.ai` |
| `app.lamarck.ai` | Cloudflare Worker `lamarck-app` | Product app, login UI, provider connect UI |
| `clerk.lamarck.ai` | Clerk | Clerk-managed auth callback/broker domain |
| `api.lamarck.ai` | AWS API Gateway/Lambda | Backend API and managed provider proxy |

Do not create `auth.lamarck.ai` for now. Auth UI belongs under
`app.lamarck.ai`.

## Prerequisites

1. The `lamarck.ai` zone is active in Cloudflare.
2. Wrangler can access the Cloudflare account:

   ```sh
   npx wrangler login
   ```

3. Remove conflicting DNS records for `lamarck.ai`, `www.lamarck.ai`, or
   `app.lamarck.ai` before first deploy if Cloudflare reports a custom-domain
   conflict.

## Deploy Frontends

Deploy the landing page:

```sh
npx wrangler deploy --config web/landing/wrangler.toml
```

Deploy the product app shell:

```sh
npx wrangler deploy --config web/app/wrangler.toml
```

The Worker configs attach custom domains directly via `custom_domain = true`.
Cloudflare will create/manage the DNS records and certificates for those Worker
custom domains.

## Clerk

Clerk can keep using its own custom domain, for example:

```text
clerk.lamarck.ai
```

That domain is configured in Clerk, not in these Worker configs. Follow Clerk's
DNS instructions for the required CNAME/TXT records.

For product redirects and allowed origins, use:

```text
https://app.lamarck.ai
```

If Google OAuth is configured through Clerk, the Google redirect URI remains the
Clerk-provided callback, for example:

```text
https://clerk.lamarck.ai/v1/oauth_callback
```

## API

`api.lamarck.ai` is not served by Cloudflare Workers in this repo. It should
point to AWS API Gateway after the backend CDK stack has a custom domain target.

Until then, leave `api.lamarck.ai` unset or use the raw API Gateway URL for
backend smoke tests.
