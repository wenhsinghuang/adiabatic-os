# Lamarck Web Backend

Deployable backend for Lamarck-hosted services:

- `api.lamarck.ai`: Lamarck provider proxy and capability-token APIs

Identity is implemented as lazy `/me` sync from Clerk into Lamarck-owned user
state. Shared managed-provider connection state and capability-token issuance
are implemented; provider-specific OAuth, provider token vaulting, and proxy
business logic are still intentional stubs.

Product login and managed-provider connect UI live in the Cloudflare Worker app
at `app.lamarck.ai`. This backend exposes one API surface for identity,
managed-provider connection state, and provider proxying.

## AWS Shape

- `Lamarck{Dev,Prod}Stack`
- Single HTTP API for identity, managed-provider, and provider API routes
- Single Lambda handler for API routes
- DynamoDB table for Lamarck users
- DynamoDB table for external identity mappings (`clerk:{subject}` -> Lamarck `userId`)
- DynamoDB table for desktop sessions
- DynamoDB table for managed provider connections
- DynamoDB table for managed provider capability tokens
- DynamoDB table for OAuth/connect state
- Secrets Manager bundle: `lamarck/{stage}/app`
- Static managed provider module registry under `src/api/providers/`

The Lambda runtime reads only the AWS secret name. Doppler remains the source of
truth; CI syncs the Doppler config into Secrets Manager before each CDK deploy.

## Identity Model

Clerk is the current login provider, but Clerk IDs are not Lamarck user IDs.
`GET /me` verifies the Clerk session token with `@clerk/backend`, fetches the
canonical Clerk user profile with the Backend API, then lazily upserts:

- `lamarck-{stage}-users`: keyed by internal `usr_*` IDs
- `lamarck-{stage}-user-identities`: maps external identities such as
  `clerk:user_xxx` to `usr_*`

This keeps managed-provider connections and future product state independent of
Clerk. Replacing Clerk later should add a new identity mapping provider, not
migrate every product table.

There is no Clerk webhook in this model yet. A user appears in DynamoDB after
they sign in through the app and the frontend calls `GET /me`.

Desktop sign-in uses a native-app style one-time code exchange instead of
handing a browser token to the local app:

1. Desktop core opens `app.lamarck.ai/auth/authorize` with `redirect_uri`,
   `state`, and PKCE `code_challenge`.
2. The app signs the user in with Clerk/Google if needed.
3. The app calls `POST /desktop/auth/authorize` with the Clerk session token.
4. The backend validates the Clerk session, resolves the internal `usr_*`, and
   returns a short-lived one-time code redirecting to the desktop loopback
   callback.
5. Desktop core exchanges `code + code_verifier` at `POST /desktop/auth/token`
   and stores the Lamarck desktop session in its local credential module.

Desktop sessions are Lamarck-owned opaque tokens stored in
`lamarck-{stage}-desktop-sessions`. Access tokens are short-lived; refresh
tokens rotate through `/desktop/auth/token` with `grantType: refresh_token`.
`GET /me` accepts either a Clerk browser session token or a Lamarck desktop
access token. Desktop tokens are not Clerk session tokens.

Required Doppler/Secrets Manager keys:

```text
CLERK_SECRET_KEY
```

## Managed Provider Registry

Managed providers are implemented as one folder per provider under
`src/api/providers/`. The API uses a static registry, not runtime directory
scanning, so bundling stays predictable in Lambda.

To add a provider skeleton, add a folder:

```text
src/api/providers/{providerId}/
  metadata.ts
  connect.ts
  proxy.ts
  index.ts
```

Then register it in `src/api/providers/index.ts`:

```ts
import oura from "./oura";

const providerModules = {
  oura,
};
```

Provider metadata stays declarative in `metadata.ts`:

```ts
export const metadata = {
  providerId: "oura",
  displayName: "Oura",
  capability: "Health signals",
  apiBasePath: "/providers/oura",
  connect: {
    type: "oauth2",
    enabled: false,
    scopes: ["daily", "heartrate"],
  },
};
```

Current flow shape:

- `GET /providers` lists registered providers.
- `POST /providers/{providerId}/connect/start` verifies the Clerk session,
  resolves the internal `usr_*`, requires the connector `integrationId`, checks
  the provider registry, and returns a structured not-implemented response until
  that provider's hosted OAuth flow is wired.
- `POST /providers/{providerId}/capability-token` verifies a Lamarck desktop
  session token, checks the `userId + integrationId` managed-provider connection,
  and issues a 24-hour opaque capability token scoped to
  `/providers/{providerId}/v1/*`.
- `GET|POST /providers/{providerId}/oauth/callback` and
  `/providers/{providerId}/v1/{proxy+}` dispatch to the provider module. Provider
  data proxy routes require a scoped Lamarck capability token, not a Clerk token
  and not a desktop session token. Oura currently returns structured stubs from
  `providers/oura/connect.ts` and `providers/oura/proxy.ts`.

Managed-provider server state is intentionally small and auxiliary to the
local-first workspace: provider token vault rows are keyed by `userId +
integrationId`, while local connector credentials store only `{ kind:
"managedProvider", providerId, integrationId }`. Connector runtime code receives
only the scoped capability token returned by `context.auth.getToken()`.

Production attaches `api.lamarck.ai` to the HTTP API and requires Doppler prod
to expose `LAMARCK_API_CERTIFICATE_ARN`. The certificate is an ACM public certificate in
`us-west-2`; Cloudflare DNS owns both the ACM validation CNAME and the final
`api` CNAME to the `ApiCustomDomainTarget` stack output. Dev keeps the raw API
Gateway endpoint and defaults the app origin to
`https://dev-lamarck-app.adiabatic.workers.dev`.

## Useful Commands

```bash
npm install
npm --workspace @lamarck/web-backend run build
npm --workspace @lamarck/web-backend run synth:dev
npm --workspace @lamarck/web-backend run synth:prod
```

## Required CI Secrets

Set these on the `wenhsinghuang/adiabatic-os` GitHub repository:

```text
DOPPLER_TOKEN_DEV
DOPPLER_TOKEN_PROD
```

The workflows assume Doppler project `lamarck` and configs `dev` / `prod`. If the
Doppler project uses another name, update `DOPPLER_PROJECT` in the workflow env.
