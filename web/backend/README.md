# Lamarck Web Backend

Deployable skeleton for Lamarck-hosted services:

- `api.lamarck.ai`: Lamarck provider proxy and capability-token APIs

The current handlers are intentional stubs. They establish deployable AWS shape
without implementing provider OAuth, provider token vaulting, capability-token
issuance, or proxy business logic yet.

Product login and managed-provider connect UI live in the Cloudflare Worker app
at `app.lamarck.ai`. This backend exposes one API surface for identity,
managed-provider connection state, and provider proxying.

## AWS Shape

- `Lamarck{Dev,Prod}Stack`
- Single HTTP API for identity, managed-provider, and provider API routes
- Single Lambda handler for API routes
- DynamoDB table for managed provider connections
- DynamoDB table for OAuth/connect state
- Secrets Manager bundle: `lamarck/{stage}/app`

The Lambda runtime reads only the AWS secret name. Doppler remains the source of
truth; CI syncs the Doppler config into Secrets Manager before each CDK deploy.

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
