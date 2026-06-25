# Lamarck Infrastructure

This folder contains manual bootstrap scripts and deployment notes for Lamarck
hosted services.

The product/service name is Lamarck, but GitHub Actions deployment currently
runs from the `wenhsinghuang/adiabatic-os` repository. IAM trust policies should
therefore bind to `repo:wenhsinghuang/adiabatic-os:*` until the repository is
renamed or moved.

## Scripts

- `scripts/setup-lamarck-iam.sh` creates/updates the GitHub OIDC deploy role and
  CDK bootstrap trust needed for CI/CD.
- `scripts/read-lamarck-iam-topology.sh` prints the relevant IAM topology for
  audit/debugging.

Run these from AWS CloudShell with credentials for the target account.
