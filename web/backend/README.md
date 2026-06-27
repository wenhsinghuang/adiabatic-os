# Lamarck Web Backend

Deployable backend for Lamarck-hosted services:

- `api.lamarck.ai`: Lamarck provider proxy and capability-token APIs

Identity is implemented as lazy `/me` sync from Clerk into Lamarck-owned user
state. Provider OAuth, provider token vaulting, capability-token issuance, and
proxy business logic are still intentional stubs.

Product login and managed-provider connect UI live in the Cloudflare Worker app
at `app.lamarck.ai`. This backend exposes one API surface for identity,
managed-provider connection state, and provider proxying.

## AWS Shape

- `Lamarck{Dev,Prod}Stack`
- Single HTTP API for identity, managed-provider, and provider API routes
- Single Lambda handler for API routes
- DynamoDB table for Lamarck users
- DynamoDB table for external identity mappings (`clerk:{subject}` -> Lamarck `userId`)
- DynamoDB table for managed provider connections
- DynamoDB table for OAuth/connect state
- Secrets Manager bundle: `lamarck/{stage}/app`

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

Required Doppler/Secrets Manager keys:

```text
CLERK_SECRET_KEY
```

Production attaches `api.lamarck.ai` to the HTTP API and requires Doppler prod
to expose `LAMARCK_API_CERTIFICATE_ARN`. The certificate is an ACM public certificate in
`us-west-2`; Cloudflare DNS owns both the ACM validation CNAME and the final
`api` CNAME to the `ApiCustomDomainTarget` stack output. Dev keeps the raw API
Gateway endpoint.

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
