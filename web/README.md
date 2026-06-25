# Lamarck Web Services

This folder is reserved for Lamarck-hosted services that are deployed separately
from the desktop app.

Planned layout:

```text
web/
  auth/      auth.lamarck.ai login and managed-provider connect flows
  api/       api.lamarck.ai provider proxy and capability-token APIs
  packages/  shared web/backend packages, config, and provider contracts
```

The desktop source currently lives under `desktop/`. The hosted services are not
implemented in this repo yet; this folder only establishes the repository
boundary.
