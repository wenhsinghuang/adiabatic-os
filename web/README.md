# Lamarck Web Services

This folder is reserved for Lamarck-hosted services that are deployed separately
from the desktop app.

Planned layout:

```text
web/
  backend/   CDK app and Lambda handlers for auth.lamarck.ai / api.lamarck.ai
  packages/  shared web/backend packages, config, and provider contracts
```

The desktop source currently lives under `desktop/`. The hosted services are not
production-ready yet; `backend/` currently provides the deployable skeleton.
