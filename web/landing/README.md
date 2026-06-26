# Lamarck Landing Page

Static landing page for `lamarck.ai`, deployed as a Cloudflare Worker with
Static Assets.

## Cloudflare Worker

Cloudflare Pages is no longer the target deployment model for this site. Use
Workers Static Assets instead:

```sh
npx wrangler deploy --config web/landing/wrangler.toml
```

The Worker config attaches custom domains for:

- `lamarck.ai`
- `www.lamarck.ai`

The Worker redirects `www.lamarck.ai` to `lamarck.ai`, then serves static assets
from `web/landing/public`.

Cloudflare Workers serves `robots.txt` and `sitemap.xml` from the static assets
directory. Security headers are attached by the Worker script because
`run_worker_first` is enabled for canonical host redirects.

`app.lamarck.ai` is the product app and managed-provider connect surface.
`api.lamarck.ai` is the backend API domain. Neither is served by this landing
Worker.
