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

Deploys run through GitHub Actions, not by hand:

- **Push to `dev`** (touching `web/app/**` or `web/landing/**`) →
  [`deploy-cloudflare-dev.yml`](../.github/workflows/deploy-cloudflare-dev.yml)
  runs `wrangler versions upload`, producing a preview URL. Production custom
  domains are untouched.
- **Publish a GitHub Release** →
  [`deploy-cloudflare-prod.yml`](../.github/workflows/deploy-cloudflare-prod.yml)
  runs `wrangler deploy`, updating `lamarck.ai` / `app.lamarck.ai`. The same
  release also triggers the AWS backend prod deploy (lockstep).

CI auth is a repo secret `CLOUDFLARE_API_TOKEN` + repo variable
`CLOUDFLARE_ACCOUNT_ID`; wrangler is pinned to `4.105.0`.

Manual deploy is only a fallback (account/DNS debugging, or a hotfix when CI is
unavailable):

```sh
npx wrangler deploy --config web/landing/wrangler.toml
npx wrangler deploy --config web/app/wrangler.toml
```

The Worker configs attach custom domains directly via `custom_domain = true`.
Cloudflare creates/manages the DNS records and certificates for those Worker
custom domains.

## Clerk

The Clerk **publishable** key is public (it ships to every browser), so it is
not injected at deploy time. It lives in
[`web/app/public/config.js`](app/public/config.js) and is selected by hostname:
`pk_live` on `app.lamarck.ai`, `pk_test` on every other origin (workers.dev
previews, localhost). Rotating the key is a one-line source change.

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
