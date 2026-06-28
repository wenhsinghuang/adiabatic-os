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
- `/auth/authorize`
- `/providers/{providerId}/connect`

The sign-in route is wired for Clerk's browser SDK. After sign-in, the app calls
`GET /me` on the Lamarck backend with the Clerk session token so the backend can
lazy-sync the user into DynamoDB.

The desktop authorize route is a browser leg for native desktop sign-in. It
keeps the Clerk browser session in the browser, calls
`POST /desktop/auth/authorize`, then redirects only a one-time code back to the
desktop loopback callback.

The provider connect route uses the same Clerk session token to call
`POST /providers/{providerId}/connect/start`. The backend currently returns a
structured not-implemented response for registered providers until the hosted
OAuth implementation is wired.

If you use Worker-injected config instead of `public/config.js`, the Clerk
browser SDK needs the publishable key:

```sh
npx wrangler secret put CLERK_PUBLISHABLE_KEY --config web/app/wrangler.toml
npx wrangler deploy --config web/app/wrangler.toml
```

`CLERK_PUBLISHABLE_KEY` is not a backend secret, but storing it as a Worker secret
keeps local commits environment-agnostic.
