# Lamarck App Frontend

Cloudflare Worker frontend for `app.lamarck.ai`.

This is the product app surface for identity, account state, desktop pairing,
and managed provider connection flows. It is intentionally separate from
`api.lamarck.ai`, which owns backend APIs and provider proxying.

## Deploy

```sh
npx wrangler deploy --config web/app/wrangler.toml
```

The Worker config attaches the custom domain:

- `app.lamarck.ai`

Routes currently served by the app shell:

- `/`
- `/auth/sign-in`
- `/providers/{providerId}/connect`

Clerk and real managed-provider protocol integration are not implemented in this
frontend skeleton yet. The sign-in route is wired for Clerk's browser SDK and
needs the Worker variable below before it can mount the Clerk UI:

```sh
npx wrangler secret put CLERK_PUBLISHABLE_KEY --config web/app/wrangler.toml
npx wrangler deploy --config web/app/wrangler.toml
```

`CLERK_PUBLISHABLE_KEY` is not a backend secret, but storing it as a Worker secret
keeps local commits environment-agnostic.
