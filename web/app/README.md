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

The desktop authorize route is an intent route for native desktop sign-in. If
the browser has no Clerk session, it redirects to `/auth/sign-in` with a local
`redirect_url` back to the same authorize URL. Once signed in, it asks the user
to authorize the
desktop session, calls `POST /desktop/auth/authorize`, then redirects only a
one-time code back to the desktop loopback callback.

The provider connect route uses the same Clerk session token to call
`POST /providers/{providerId}/connect/start`. Registered provider modules may
return a provider authorization URL; the app follows that URL and displays the
completion/error state when the provider redirects back.

If you use Worker-injected config instead of `public/config.js`, the Clerk
browser SDK needs the publishable key:

```sh
npx wrangler secret put CLERK_PUBLISHABLE_KEY --config web/app/wrangler.toml
npx wrangler deploy --config web/app/wrangler.toml
```

`CLERK_PUBLISHABLE_KEY` is not a backend secret, but storing it as a Worker secret
keeps local commits environment-agnostic.
